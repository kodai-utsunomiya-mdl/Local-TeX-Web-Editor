import { test as base, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41546';
let javascript;
const test = base.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});
const versions = [
  { id: 'first-version', label: 'First recorded version', createdAt: '2026-01-02T03:04:05Z' },
  { id: 'second-version', label: 'Second recorded version', createdAt: '2026-01-01T03:04:05Z' },
];
const settings = { enabled: true, days: 30, maxBytes: 50 * 1024 * 1024 };
const listing = entries => ({ entries, settings });

test.beforeAll(async () => {
  const bundled = await build({ stdin: {
    resolveDir: path.join(repository, 'web/src'),
    contents: `import { createEditHistory } from './edit-history.js';
      import { setLanguage } from './i18n.js';
      setLanguage('ja');
      const pending = new Map(); let nextRequest = 0;
      window.current = { projectRoot: '/projects/first', path: 'first.tex', content: 'Current text.', revision: 'current-revision' };
      window.requests = []; window.replacements = []; window.errors = [];
      window.pendingRequests = () => [...pending.values()].map(value => value.request);
      window.settleHistory = (match, response, error) => {
        const request = [...pending.values()].find(value => Object.entries(match).every(([key, expected]) => value.request[key] === expected));
        if (!request) throw new Error('No matching history request.');
        pending.delete(request.request.id);
        if (error) request.reject(new Error(error)); else request.resolve(response);
      };
      window.historyTool = createEditHistory({
        getActiveDocument: () => current,
        replaceEditorText: (path, content, before, edits) => { replacements.push({ path, content, before, edits }); },
        api: (endpoint, options = {}) => {
          const url = new URL(endpoint, location.origin);
          const request = { id: ++nextRequest, endpoint: url.pathname, method: options.method || 'GET',
            path: url.searchParams.get('path') || options.body?.path || '', version: url.searchParams.get('id') || '',
            projectRoot: options.projectRoot, body: options.body };
          requests.push(request);
          return new Promise((resolve, reject) => pending.set(request.id, { request, resolve, reject }));
        },
      });
      document.getElementById('open-history').addEventListener('click', () => historyTool.open().catch(error => errors.push(error.message)));`,
  }, bundle: true, format: 'esm', write: false });
  javascript = bundled.outputFiles[0].text;
});

async function openHarness(page) {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/history.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/style.css', '/writing-tools.css'].includes(pathname)) {
      return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', pathname.slice(1))) });
    }
    if (pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/writing-tools.css"></head>
      <body><button id="open-history" type="button">履歴を開く</button><script type="module" src="/history.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.historyTool))).toBe(true);
}
async function pending(page, match) {
  await expect.poll(() => page.evaluate(match => pendingRequests().some(request => Object.entries(match).every(([key, expected]) => request[key] === expected)), match)).toBe(true);
}
async function reply(page, match, response, error = '') {
  await pending(page, match);
  await page.evaluate(({ match, response, error }) => settleHistory(match, response, error), { match, response, error });
}
const dialog = page => page.locator('#edit-history-dialog');
const listRequest = path => ({ method: 'GET', endpoint: '/api/history', path, version: '' });
const entryRequest = (path, version) => ({ method: 'GET', endpoint: '/api/history', path, version });

test('版の読込み中と失敗後には比較が終わったと表示せず，狭い画面でも選んだ版へフォーカスを置く', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openHarness(page);
  const documentPath = `notes/${'very-long-filename-'.repeat(8)}.tex`;
  await page.evaluate(path => { current.path = path; }, documentPath);
  await page.locator('#open-history').click();
  await reply(page, listRequest(documentPath), listing(versions));
  const first = page.locator('[data-history-id="first-version"]');
  await first.click(); await pending(page, entryRequest(documentPath, 'first-version'));
  await expect(first).toBeFocused();
  await expect(page.getByTestId('history-changes')).not.toContainText('現在の原稿と同じ内容です．');
  await expect(page.getByTestId('history-status')).toContainText('読み込');
  await reply(page, entryRequest(documentPath, 'first-version'), { content: 'Current text.' });
  await expect(page.getByTestId('history-changes')).toContainText('現在の原稿と同じ内容です．');
  await page.locator('[data-history-id="second-version"]').click();
  await expect(page.getByTestId('history-changes')).not.toContainText('現在の原稿と同じ内容です．');
  await reply(page, entryRequest(documentPath, 'second-version'), null, 'This version could not be read.');
  await expect(page.getByTestId('history-status')).toContainText('This version could not be read.');
  await expect(page.getByTestId('history-changes')).not.toContainText('現在の原稿と同じ内容です．');
  await expect(page.locator('[data-history-id="second-version"]')).toBeFocused();
  const dimensions = await dialog(page).evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, width: node.clientWidth }));
  expect(dimensions.left).toBeGreaterThanOrEqual(0); expect(dimensions.right).toBeLessThanOrEqual(390);
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 2);
  expect(await page.evaluate(() => errors)).toEqual([]);
});

test('別の原稿で履歴を開き直した後は，前の一覧の取得失敗を新しい画面へ表示しない', async ({ page }) => {
  await openHarness(page);
  await page.locator('#open-history').click(); await pending(page, listRequest('first.tex'));
  await dialog(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await page.evaluate(() => { current = { projectRoot: '/projects/second', path: 'second.tex', content: 'Second current text.', revision: 'second-revision' }; });
  await page.locator('#open-history').click();
  await reply(page, listRequest('second.tex'), listing([versions[1]]));
  await page.locator('[data-history-id="second-version"]').click();
  await reply(page, entryRequest('second.tex', 'second-version'), { content: 'Earlier second text.' });
  await expect(page.locator('input[data-hunk]')).toHaveCount(1);
  await reply(page, listRequest('first.tex'), null, 'The old project is unavailable.');
  await expect(page.getByTestId('history-status')).not.toContainText('The old project is unavailable.');
  await expect(dialog(page)).toContainText('second.tex');
  await expect(page.locator('input[data-hunk]')).toHaveCount(1);
  expect(await page.evaluate(() => requests.map(({ path, projectRoot }) => ({ path, projectRoot })))).toEqual([
    { path: 'first.tex', projectRoot: '/projects/first' },
    { path: 'second.tex', projectRoot: '/projects/second' },
    { path: 'second.tex', projectRoot: '/projects/second' },
  ]);
  expect(await page.evaluate(() => errors)).toEqual([]);
});

test('削除を取り消して再試行でき，失敗後の再読込みと遅い版の取得が削除結果を戻さない', async ({ page }) => {
  await openHarness(page);
  const disabledSettings = { ...settings, enabled: false };
  await page.locator('#open-history').click(); await reply(page, listRequest('first.tex'), { ...listing(versions), settings: disabledSettings });
  await page.locator('[data-history-id="first-version"]').click(); await pending(page, entryRequest('first.tex', 'first-version'));
  await page.locator('#history-select-all-versions').check(); await page.locator('#history-delete-selected').click();
  const confirmation = page.locator('#history-delete-dialog');
  await expect(page.locator('#history-delete-cancel')).toBeFocused();
  await page.locator('#history-delete-cancel').click(); await expect(confirmation).toBeHidden();
  await expect(page.locator('#history-delete-selected')).toBeFocused();
  expect(await page.locator('input[data-history-select]').evaluateAll(boxes => boxes.every(box => box.checked))).toBe(true);
  await page.locator('#history-delete-selected').click(); await page.locator('#history-delete-confirm').click();
  const deletion = { method: 'DELETE', endpoint: '/api/history', path: 'first.tex' };
  await pending(page, deletion);
  await expect(page.locator('#history-delete-cancel')).toBeDisabled(); await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await reply(page, deletion, null, 'The history folder is temporarily unavailable.');
  await reply(page, listRequest('first.tex'), { ...listing(versions), settings: disabledSettings });
  await expect(confirmation.getByRole('alert')).toContainText('The history folder is temporarily unavailable.');
  await expect(page.locator('#history-delete-confirm')).toBeEnabled(); await expect(page.locator('#history-delete-cancel')).toBeEnabled();
  await page.locator('#history-delete-confirm').click();
  await reply(page, deletion, { ...listing([]), settings: disabledSettings, deleted: versions.map(entry => entry.id) });
  await expect(confirmation).toBeHidden();
  await reply(page, entryRequest('first.tex', 'first-version'), { content: 'Earlier text.' });
  await expect(page.locator('input[data-history-select]')).toHaveCount(0); await expect(page.locator('input[data-hunk]')).toHaveCount(0);
  await expect(page.getByTestId('history-status')).toContainText('2 版を編集履歴から削除しました');
  await expect(page.getByTestId('record-history')).toBeDisabled();
  await expect(dialog(page).getByRole('button', { name: '閉じる', exact: true })).toBeFocused();
  expect(await page.evaluate(() => errors)).toEqual([]);
});
