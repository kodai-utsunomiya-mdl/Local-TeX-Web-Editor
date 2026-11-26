import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { frontendBuildOptions } from '../scripts/frontend-build.mjs';
import { test, repository, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

function smallPDF() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ];
  let result = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${result}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('PDF の読み込みを待つ間も原稿を開け，必要な時にだけ PDF を表示する', async ({ page, session }) => {
  const errors = [], assets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/asset') assets.push(request.url()); });
  await writeFile(path.join(session.project, 'paper.pdf'), smallPDF());
  await openProject(session);
  let requested = false, release;
  const wait = new Promise(resolve => { release = resolve; });
  await page.route('**/chunks/pdf-runtime-*.js', async route => { requested = true; await wait; await route.continue(); });
  await openEditor(page, session);
  expect(requested).toBe(false);
  await page.getByTestId('file-paper.pdf').click();
  await expect.poll(() => requested).toBe(true);
  await page.getByTestId('file-main.tex').click();
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  const runtimeLoaded = page.waitForResponse(response => /\/chunks\/pdf-runtime-/.test(response.url()));
  release();
  await runtimeLoaded;
  expect(assets).toEqual([]);
  await page.getByTestId('file-paper.pdf').click();
  await expect(page.locator('#asset-pdf-stage canvas')).toBeVisible();
  await expect(page.locator('#asset-preview')).toHaveAttribute('data-state', 'ready');
  expect(errors).toEqual([]);
});

for (const language of ['ja', 'en']) {
  test.describe(`ブラウザの復元 (${language})`, () => {
    test.use({ interfaceLanguage: language });
    test('アプリが停止中のタブは接続を待ち，同じアドレスで編集画面へ戻る', async ({ page, session }, testInfo) => {
      await openProject(session); await openEditor(page, session);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      const original = { url: session.url, token: session.token };
      await page.evaluate(() => sessionStorage.clear());
      await json(session, '/api/shutdown', { method: 'POST', data: {} });
      await session.waitForExit();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#connection-title')).toHaveText(language === 'ja' ? 'アプリへの接続を待っています' : 'Waiting for the application');
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      expect(page.url()).toBe(original.url);
      const cached = await page.evaluate(async () => {
        const paths = [];
        for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
        return [...new Set(paths)].sort();
      });
      expect(cached).toEqual(['/app-icon.svg', '/offline.css', '/offline.html', '/offline.js']);
      await page.screenshot({ path: testInfo.outputPath(`waiting-for-application-${language}.png`) });
      await session.restart();
      expect(session.url).toBe(original.url); expect(session.token).toBe(original.token);
      await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
      await expect(page.locator('#connection-status')).toHaveClass(/connected/);
      expect(page.url()).toBe(original.url);
      const unauthenticated = await fetch(`${session.url}api/state`);
      expect(unauthenticated.status).toBe(401);
      expect((await json(session, '/api/state')).project.root).toBeTruthy();
    });
  });
}

test('ブラウザを終了して前回のタブを復元すると，アプリの起動後に原稿を再び編集できる', async ({ session }, testInfo) => {
  await openProject(session);
  const profile = path.join(session.temp, 'chromium-profile');
  const options = {
    // Session restore uses the regular Chromium browser, including in headless mode.
    // https://playwright.dev/docs/browsers#chromium-new-headless-mode
    channel: 'chromium', headless: true,
    viewport: { width: 1600, height: 1000 }, locale: 'ja-JP',
  };
  const original = { url: session.url, token: session.token };
  const errors = [];
  let context, page, tracing = false;
  try {
    context = await chromium.launchPersistentContext(profile, options);
    await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true;
    page = context.pages()[0];
    page.on('pageerror', error => errors.push(error.message));
    await openEditor(page, session);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(page.url()).toBe(original.url);

    await json(session, '/api/shutdown', { method: 'POST', data: {} });
    await session.waitForExit();
    await context.tracing.stop({ path: testInfo.outputPath('before-browser-restart.zip') }); tracing = false;
    // Close the whole browser so Chromium saves its open tabs and profile data.
    await context.close(); context = undefined; page = undefined;

    context = await chromium.launchPersistentContext(profile, {
      ...options, args: ['--restore-last-session'], ignoreDefaultArgs: ['about:blank'],
    });
    await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true;
    // Do not navigate to the editor here: Chromium must restore the saved tab.
    await expect.poll(() => context.pages().map(tab => tab.url()), {
      message: 'Chromium should restore the previous editor tab from its profile.',
    }).toContain(original.url);
    page = context.pages().find(tab => tab.url() === original.url);
    page.on('pageerror', error => errors.push(error.message));
    await page.bringToFront();
    await expect(page.locator('#connection-title')).toHaveText('アプリへの接続を待っています');
    await page.screenshot({ path: testInfo.outputPath('restored-browser-waiting.png') });

    await session.restart();
    expect(session.url).toBe(original.url); expect(session.token).toBe(original.token);
    const editor = page.getByTestId('editor').locator('.cm-content');
    await expect(editor).toBeVisible();
    await expect(page.locator('#connection-status')).toHaveClass(/connected/);
    expect(page.url()).toBe(original.url);
    await editor.click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    await page.keyboard.insertText('% Edited after restoring the browser session.\n');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain('Edited after restoring the browser session.');
    await page.screenshot({ path: testInfo.outputPath('restored-browser-editor.png') });
    expect(errors).toEqual([]);
  } finally {
    if (page && !page.isClosed()) await page.screenshot({ path: testInfo.outputPath('browser-session-final.png') }).catch(() => {});
    if (tracing) await context?.tracing.stop({ path: testInfo.outputPath('restored-browser-trace.zip') }).catch(() => {});
    await context?.close();
  }
});

test('更新後も未保存の本文を編集でき，新しい版へ草稿を引き継げる', async ({ page, session }) => {
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  const original = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  const marker = '% Keep this edit while reopening the updated application.\n';
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText(marker);
  const current = await json(session, '/api/state');
  const nextVersion = `${current.version}.update-test`;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), version: nextVersion } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#error-action')).toHaveText('新しい版で開く');
  await expect(page.getByTestId('app-error')).toContainText(nextVersion);
  await page.locator('#error-action').click();
  await expect(page.locator('#decision-dialog')).toBeVisible();
  await page.locator('#decision-cancel').click();
  await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('% Still editable.\n');
  await expect(editor).toContainText('Still editable.');
  await page.locator('#error-action').click();
  const reloaded = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.locator('#decision-secondary').click();
  await reloaded;
  await expect(editor).toBeVisible();
  await page.getByTestId('review-drafts').click();
  await expect(page.locator('#recovery-draft')).toHaveValue(new RegExp('Still editable\\.[\\s\\S]*Keep this edit'));
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(original);
});

test('初期読み込みの時間と JavaScript の量を記録する', async ({ browser, session }, testInfo) => {
  const options = frontendBuildOptions(repository);
  // Compare the current implementation with the former packaging method:
  // one initial bundle, eager PDF imports and separate require/import KaTeX.
  const eager = await build({ ...options, entryPoints: undefined,
    stdin: { contents: "import './pdf-runtime.js'; import './main.js';", resolveDir: path.join(repository, 'web/src') },
    splitting: false, alias: {}, write: false });
  const eagerScript = Buffer.from(eager.outputFiles.find(file => file.path.endsWith('.js')).contents);
  const currentScript = await readFile(path.join(repository, 'web/dist/app.js'));
  const samples = { eager: [], deferred: [] };
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const mode of iteration % 2 ? ['deferred', 'eager'] : ['eager', 'deferred']) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ja-JP' });
      const page = await context.newPage();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(() => {
          const watch = new MutationObserver(() => {
            if (document.getElementById('app-version')?.textContent && document.getElementById('welcome-open')?.disabled === false) {
              window.startupReadyAt = performance.now(); watch.disconnect();
            }
          });
          watch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        });
        await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: mode === 'eager' ? eagerScript : currentScript }));
        await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
        await expect.poll(() => page.evaluate(() => window.startupReadyAt || 0)).toBeGreaterThan(0);
        samples[mode].push(await page.evaluate(() => ({ readyMs: window.startupReadyAt,
          api: performance.getEntriesByType('resource').filter(entry => /\/api\/state(?:\?|$)/.test(entry.name)).map(entry => ({ durationMs: entry.duration })),
          scriptBytes: performance.getEntriesByType('resource').filter(entry => /\/(?:app\.js|chunks\/[^/]+\.js)$/.test(entry.name)).reduce((total, entry) => total + entry.decodedBodySize, 0),
        })));
      } finally { await context.close(); }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const result = { cpuThrottleRate: 4, scenario: 'Empty home screen; fresh browser context for each sample; same current source with different packaging.',
    samples, medianReadyMs: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values.map(value => value.readyMs))])) };
  const file = testInfo.outputPath('startup-measurements.json');
  await writeFile(file, JSON.stringify(result, null, 2));
  await testInfo.attach('startup-measurements', { path: file, contentType: 'application/json' });
});
