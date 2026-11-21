import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const entries = [
  { buildId: 'second', main: 'chapters/本文2.tex', name: '投稿用の本文と参考文献をまとめた最終稿2.pdf', modifiedAt: '2026-01-05T12:00:00Z' },
  { buildId: 'tenth', main: 'notes/概要10.md', name: '投稿用の本文と参考文献をまとめた最終稿10.pdf', modifiedAt: '2026-01-03T12:00:00Z' },
  { buildId: 'old', main: '旧版の原稿.tex', name: '', modifiedAt: '2026-01-01T12:00:00Z' },
];
let script;

test.beforeAll(async () => {
  const built = await bundle({
    stdin: { resolveDir: path.join(repository, 'web/src'), contents: `
      import { createCompiledPDFList } from './compiled-pdfs.js';
      import { setLanguage } from './i18n.js';
      import { resolveAppearance } from './appearance.js';
      const appearance = resolveAppearance({ mode: 'light', palette: 'gray' });
      document.documentElement.dataset.theme = appearance.theme;
      document.documentElement.dataset.palette = appearance.palette;
      for (const [name, value] of Object.entries(appearance.colors)) document.documentElement.style.setProperty('--' + name, value);
      setLanguage('ja');
      window.compiledActions = []; window.treeContextEvents = 0; window.compiledBlocked = false;
      const action = name => entry => {
        if (window.compiledFail === name) throw new Error('Cannot complete ' + name);
        window.compiledActions.push({ action: name, buildId: entry.buildId, main: entry.main });
      };
      const component = createCompiledPDFList({ onOpen: action('open'), onDownload: action('download'), onCopy: action('copy'), onDelete: action('delete'),
        isBlocked: () => window.compiledBlocked, onError: error => { window.compiledError = error.message; } });
      const tree = document.querySelector('#file-tree');
      tree.addEventListener('contextmenu', () => { window.treeContextEvents++; });
      tree.addEventListener('keydown', event => { if (event.key === 'ContextMenu' || event.key === 'F10') window.treeContextEvents++; });
      tree.append(component.element);
      const state = { entries: ${JSON.stringify(entries)}, activeBuildId: 'second' };
      window.compiledRender = options => component.render(Object.assign(state, options));
      window.compiledLanguage = setLanguage; window.compiledDestroy = () => component.destroy();
      window.compiledRender({}); window.compiledReady = true;
    ` },
    bundle: true, format: 'esm', write: false,
  });
  script = built.outputFiles[0].text;
});

async function openList(page) {
  const assets = new Map([['/fixture.js', { contentType: 'text/javascript', body: script }]]);
  for (const name of ['style.css', 'compiled-pdfs.css']) assets.set(`/${name}`, {
    contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)),
  });
  assets.set('/', { contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/compiled-pdfs.css">
    <style>#file-tree { width: 226px; height: 100vh; border-right: 1px solid var(--border); padding-top: 12px; }</style>
    </head><body><nav id="file-tree" class="file-tree"><button class="file-button" type="button">main.tex</button></nav>
    <script type="module" src="/fixture.js"></script></body></html>` });
  const origin = 'http://127.0.0.1:41873';
  await page.route(`${origin}/**`, route => route.fulfill(assets.get(new URL(route.request().url()).pathname) || { status: 404, body: '' }));
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.compiledReady);
}

const row = (page, id) => page.locator(`.compiled-pdf-button[data-build-id="${id}"]`);
const menu = page => page.locator('.compiled-pdf-context-menu');

test('PDF 名とコンパイル元を 2 行で表示し，検索と表示言語の変更を反映する', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openList(page);
  await expect(page.getByRole('heading', { name: 'コンパイルした PDF' })).toBeVisible();
  await expect(row(page, 'second').locator('.compiled-pdf-name')).toHaveText(entries[0].name);
  await expect(row(page, 'second').locator('.compiled-pdf-source')).toHaveText(entries[0].main);
  await expect(row(page, 'second')).toHaveAttribute('aria-current', 'true');
  await expect(row(page, 'old').locator('.compiled-pdf-name')).toHaveText('旧版の原稿.tex の PDF');
  expect(await row(page, 'second').evaluate(button => {
    const name = button.querySelector('.compiled-pdf-name'), source = button.querySelector('.compiled-pdf-source');
    return button.getBoundingClientRect().height <= 50 && name.getBoundingClientRect().bottom <= source.getBoundingClientRect().top && button.scrollWidth <= button.clientWidth;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('compiled-pdfs-narrow.png') });
  expect(await page.evaluate(() => window.compiledRender({ filter: 'notes/' }))).toBe(1);
  await expect(page.locator('.compiled-pdf-button')).toHaveCount(1);
  await expect(row(page, 'tenth')).toBeVisible();
  expect(await page.evaluate(() => window.compiledRender({ filter: 'nothing' }))).toBe(0);
  await expect(page.locator('.compiled-pdfs')).toBeHidden();
  await page.evaluate(() => { window.compiledRender({ filter: '' }); window.compiledLanguage('en'); });
  await expect(page.getByRole('heading', { name: 'Compiled PDFs' })).toBeVisible();
  await expect(row(page, 'old').locator('.compiled-pdf-name')).toHaveText('PDF from 旧版の原稿.tex');
});

test('クリックと独自のメニューから対象の PDF を開き，保存，コピー，削除を選べる', async ({ page }) => {
  await openList(page);
  const target = row(page, 'second');
  await target.click();
  await expect.poll(() => page.evaluate(() => window.compiledActions)).toEqual([{ action: 'open', buildId: 'second', main: entries[0].main }]);
  await target.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem')).toHaveText(['開く', 'PDF を保存', 'プロジェクトへコピー…', '削除…']);
  await expect(menu(page).getByRole('menuitem', { name: '開く', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden();
  await expect(target).toBeFocused();
  await target.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  await expect(menu(page).getByRole('menuitem', { name: 'PDF を保存', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.compiledActions.at(-1))).toEqual({ action: 'download', buildId: 'second', main: entries[0].main });
  await target.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'プロジェクトへコピー…', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.compiledActions.at(-1))).toEqual({ action: 'copy', buildId: 'second', main: entries[0].main });
  await target.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: '削除…', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.compiledActions.at(-1))).toEqual({ action: 'delete', buildId: 'second', main: entries[0].main });
  expect(await page.evaluate(() => window.treeContextEvents)).toBe(0);
  await expect(menu(page)).toBeHidden();
});

test('操作中は新しい処理を始めず，失敗と一覧の更新でメニューを閉じる', async ({ page }) => {
  await openList(page);
  const target = row(page, 'second');
  await target.focus();
  expect(await target.evaluate(button => {
    window.compiledBlocked = true; window.compiledRender({});
    return button.isConnected && document.activeElement === button;
  })).toBe(true);
  await expect(target).toHaveAttribute('aria-disabled', 'true');
  await target.click({ force: true });
  await target.click({ button: 'right', force: true });
  await expect(menu(page)).toBeHidden();
  expect(await page.evaluate(() => window.compiledActions)).toEqual([]);
  expect(await page.evaluate(() => window.treeContextEvents)).toBe(0);
  await page.evaluate(() => { window.compiledBlocked = false; window.compiledFail = 'copy'; window.compiledRender({}); });
  await expect(target).toHaveAttribute('aria-disabled', 'false');
  await target.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'プロジェクトへコピー…', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.compiledError)).toBe('Cannot complete copy');
  await expect(menu(page)).toBeHidden();
  await expect(target).toBeFocused();
  await target.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await page.evaluate(() => window.compiledRender({ entries: [] }));
  await expect(menu(page)).toBeHidden();
  await expect(page.locator('.compiled-pdfs')).toBeHidden();
  await page.evaluate(() => window.compiledDestroy());
  await expect(menu(page)).toHaveCount(0);
});
