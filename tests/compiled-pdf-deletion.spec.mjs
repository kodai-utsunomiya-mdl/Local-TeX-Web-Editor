import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
let script;
test.beforeAll(async () => {
  const built = await bundle({
    stdin: { resolveDir: path.join(repository, 'web/src'), contents: `
      import { createCompiledPDFDeletion } from './compiled-pdf-deletion.js';
      import { setLanguage } from './i18n.js';
      setLanguage('ja');
      window.calls = []; window.changes = []; window.states = []; window.notices = [];
      window.root = '/project'; window.locked = false;
      const initial = { projectRoot: '/project', main: 'chapters/paper.tex', name: 'paper.pdf', buildId: 'old', revision: 'revision-1',
        fileCount: 3, entries: [{ area: 'build', path: 'doc-123/paper.pdf', size: 200 },
          { area: 'cache', path: 'pdf-old.pdf', size: 200 }, { area: 'cache', path: 'pdf-old.json', size: 100 }] };
      const updated = { ...initial, name: 'new.pdf', buildId: 'new', revision: 'revision-2', fileCount: 4,
        entries: [...initial.entries, { area: 'cache', path: 'pdf-new.pdf', size: 250 }] };
      const stale = () => Object.assign(new Error('コンパイル結果が変わりました．内容を確認してください．'),
        { status: 409, data: { reviewRequired: true, inspection: updated, state: { version: 2 } } });
      const component = createCompiledPDFDeletion({
        api: async (url, options) => {
          window.calls.push({ url, ...options });
          if (options.method !== 'DELETE') {
            if (window.holdInspection) await new Promise(resolve => { window.releaseInspection = resolve; });
            if (window.staleInspection) throw stale();
            return initial;
          }
          if (window.staleDelete) { window.staleDelete = false; throw stale(); }
          return { main: initial.main, deletedBuildIds: ['old', 'new'], state: { version: 3 } };
        },
        getProjectRoot: () => window.root, isBlocked: () => window.locked,
        begin: () => { window.locked = true; }, end: () => { window.locked = false; },
        onChanged: result => window.changes.push(result), onState: state => window.states.push(state),
        onNotice: message => window.notices.push(message),
      });
      document.querySelector('#open').onclick = () => { window.completion = component.open(initial); };
      window.language = setLanguage; window.ready = true;
    ` }, bundle: true, format: 'esm', write: false,
  });
  script = built.outputFiles[0].text;
});

async function openFixture(page) {
  const assets = new Map([['/fixture.js', { contentType: 'text/javascript', body: script }]]);
  for (const name of ['style.css', 'compiled-pdfs.css']) assets.set(`/${name}`, {
    contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)),
  });
  assets.set('/', { contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/compiled-pdfs.css">
    </head><body><button id="open">Open</button><script type="module" src="/fixture.js"></script></body></html>` });
  const origin = 'http://127.0.0.1:41873';
  await page.route(`${origin}/**`, route => route.fulfill(assets.get(new URL(route.request().url()).pathname) || { status: 404, body: '' }));
  await page.goto(`${origin}/`); await page.waitForFunction(() => window.ready);
}
const dialog = page => page.locator('#compiled-pdf-delete-dialog');

test('削除対象と元の TeX を表示し，キャンセルするとファイルを削除しない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openFixture(page); await page.locator('#open').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.compiled-pdf-delete-name')).toHaveText('paper.pdf');
  await expect(dialog(page).locator('.compiled-pdf-delete-source')).toHaveText('コンパイル元: chapters/paper.tex');
  await expect(dialog(page).locator('summary')).toHaveText('削除するファイル: 3 個');
  await expect(dialog(page).getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused();
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog(page).locator('summary').click();
  await expect(dialog(page).locator('li')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden(); await expect(page.locator('#open')).toBeFocused();
  expect(await page.evaluate(() => ({ methods: window.calls.map(call => call.method || 'GET'), locked: window.locked, changes: window.changes })))
    .toEqual({ methods: ['GET'], locked: false, changes: [] });
});

test('確認中の再コンパイルで内容を更新し，改めて削除を選んだ版を送信する', async ({ page }) => {
  await openFixture(page); await page.evaluate(() => { window.staleDelete = true; });
  await page.locator('#open').click();
  await dialog(page).getByRole('button', { name: '削除', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('コンパイル結果が変わりました．内容を確認してください．');
  await expect(dialog(page).locator('.compiled-pdf-delete-name')).toHaveText('new.pdf');
  await expect(dialog(page).locator('summary')).toHaveText('削除するファイル: 4 個');
  await expect(dialog(page).getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.changes)).toEqual([]);
  await page.evaluate(() => window.language('en'));
  await expect(dialog(page).getByRole('heading')).toHaveText('Delete this compiled PDF?');
  await expect(dialog(page).locator('summary')).toHaveText('Files to delete: 4');
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => call.method === 'DELETE').map(call => call.body)))
    .toEqual([{ main: 'chapters/paper.tex', buildId: 'old', revision: 'revision-1' }, { main: 'chapters/paper.tex', buildId: 'new', revision: 'revision-2' }]);
  expect(await page.evaluate(() => ({ count: window.changes.length, states: window.states, notices: window.notices, locked: window.locked })))
    .toEqual({ count: 1, states: [{ version: 2 }], notices: ['Compiled PDF deleted.'], locked: false });
});

test('古い一覧からの確認には新しい PDF を示し，取得中にプロジェクトが変わったら閉じる', async ({ page }) => {
  await openFixture(page); await page.evaluate(() => { window.staleInspection = true; });
  await page.locator('#open').click();
  await expect(dialog(page).locator('.compiled-pdf-delete-name')).toHaveText('new.pdf');
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.staleInspection = false; window.holdInspection = true; });
  await page.locator('#open').click(); await page.waitForFunction(() => !!window.releaseInspection);
  await page.evaluate(async () => { window.root = '/other-project'; window.releaseInspection(); await window.completion; });
  await expect(dialog(page)).toBeHidden();
  expect(await page.evaluate(() => ({ locked: window.locked, changes: window.changes }))).toEqual({ locked: false, changes: [] });
});
