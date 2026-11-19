import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const bibliography = Array.from({ length: 32 }, (_, index) => ({
  key: `paper${String(index).padStart(3, '0')}LongCitationKeyForStochasticOptimizationAndVariationalInequalitiesWithUnboundedVariance`,
  author: 'Abdurakhmon Sadiev and Marina Danilova and Eduard Gorbunov and Samuel Horváth and Additional Researcher with a Long Name',
  title: `High-Probability Bounds for Stochastic Optimization and Variational Inequalities: The Case of Unbounded Variance (${index}) <draft>`,
  year: '2026',
  path: 'bibliography/a-long-directory-name/references-with-a-long-filename.bib',
  line: 3069 + index,
}));
let script;

test.beforeAll(async () => {
  const built = await bundle({
    stdin: {
      resolveDir: path.join(repository, 'web/src'),
      contents: `import { EditorState } from '@codemirror/state';
        import { EditorView } from '@codemirror/view';
        import { basicSetup } from 'codemirror';
        import { autocompletion, startCompletion, closeCompletion } from '@codemirror/autocomplete';
        import { texCompletionSource } from './tex-tools.js';
        import { completionPresentation } from './completion-ui.js';
        import { resolveAppearance } from './appearance.js';
        const params = new URLSearchParams(location.search);
        const appearance = resolveAppearance({ mode: params.get('theme') || 'light', palette: 'gray' });
        document.documentElement.dataset.theme = appearance.theme;
        document.documentElement.dataset.palette = appearance.palette;
        for (const [name, color] of Object.entries(appearance.colors)) document.documentElement.style.setProperty('--' + name, color);
        document.documentElement.style.setProperty('--editor-font-family', appearance.fontFamily);
        document.documentElement.style.setProperty('--editor-font-size', (params.get('font') || '18') + 'px');
        document.querySelector('#fixture').classList.toggle('split', params.has('split'));
        const items = { citations: ${JSON.stringify(bibliography)}, labels: [
          { key: 'sec:a-long-label-for-an-introductory-section', context: '長い節の見出しと補足情報', path: 'chapters/intro.tex', line: 82 }
        ] };
        window.completionViews = [...document.querySelectorAll('.editor-host')].map(parent => new EditorView({
          parent,
          state: EditorState.create({ doc: 'Unchanged source', extensions: [
            basicSetup, EditorView.lineWrapping, completionPresentation(),
            autocompletion({ override: [texCompletionSource(() => items)] })
          ] })
        }));
        window.openCitationMenu = (index, bottom = false, citation = true) => {
          for (const view of window.completionViews) closeCompletion(view);
          const view = window.completionViews[index];
          const text = (bottom ? 'An earlier paragraph.\\n'.repeat(80) : '') + (citation ? '\\\\cite{paper' : '\\\\ref{sec:');
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length },
            effects: EditorView.scrollIntoView(text.length, { y: bottom ? 'end' : 'start', yMargin: 16 }) });
          view.focus(); startCompletion(view);
        };
        window.completionReady = true;`,
    },
    bundle: true, format: 'esm', write: false,
  });
  script = built.outputFiles[0].text;
});

async function openEditor(page, options = {}) {
  const assets = new Map([['/fixture.js', { contentType: 'text/javascript', body: script }]]);
  for (const name of ['style.css', 'completion-ui.css']) assets.set(`/${name}`, {
    contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)),
  });
  assets.set('/', { contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/completion-ui.css">
    <style>#fixture { display: grid; grid-template-columns: minmax(0, 1fr); height: 100vh; padding: 12px; gap: 16px; }
      #fixture.split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .editor-host { min-width: 0; min-height: 0; border: 1px solid var(--border); }
      #fixture:not(.split) .editor-host:last-child { display: none; }</style>
    </head><body><main id="fixture"><section class="editor-host" id="left-editor"></section><section class="editor-host" id="right-editor"></section></main>
    <script type="module" src="/fixture.js"></script></body></html>` });
  const origin = 'http://127.0.0.1:41547';
  await page.route(`${origin}/**`, async route => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    await route.fulfill(asset || { status: 404, body: '' });
  });
  await page.goto(`${origin}/?${new URLSearchParams(options)}`);
  await page.waitForFunction(() => window.completionReady);
}

async function menuBounds(page, editor = '#left-editor') {
  return page.locator(editor).evaluate(host => {
    const menu = host.querySelector('.tex-completion-menu');
    const list = menu?.querySelector(':scope > ul'), info = menu?.querySelector(':scope > .cm-completionInfo');
    if (!list || !info) return null;
    const pane = host.querySelector('.cm-scroller').getBoundingClientRect();
    const full = menu.getBoundingClientRect(), a = list.getBoundingClientRect(), b = info.getBoundingClientRect();
    return {
      separate: a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1,
      contained: full.left >= pane.left - 1 && full.right <= pane.right + 1 && full.top >= pane.top - 1 && full.bottom <= pane.bottom + 1,
      listFits: list.scrollWidth <= list.clientWidth + 1,
      detailFits: info.scrollWidth <= info.clientWidth + 1,
      detailScrollable: info.scrollHeight > info.clientHeight,
      layout: host.querySelector('.cm-editor').dataset.completionLayout,
    };
  });
}

test('長い文献候補の詳細を一覧の横に表示し，候補の移動と挿入を続けられる', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openEditor(page, { theme: 'dark', font: '26' });
  await page.evaluate(() => window.openCitationMenu(0));
  const menu = page.locator('#left-editor .tex-completion-menu');
  await expect(menu.locator('.tex-completion-key')).toHaveText(bibliography[0].key);
  await expect.poll(() => menuBounds(page)).toMatchObject({ separate: true, contained: true, listFits: true, detailFits: true, layout: 'columns' });
  await expect(menu.locator('.tex-completion-title')).toHaveText(bibliography[0].title);
  await expect(menu.locator('.tex-completion-authors')).toContainText(bibliography[0].author);
  await expect(menu.locator('.tex-completion-location')).toHaveText(`${bibliography[0].path}:${bibliography[0].line}`);
  await expect(menu.locator('draft, script')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('completion-wide-dark.png') });
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('.tex-completion-key')).toHaveText(bibliography[1].key);
  await page.keyboard.press('Enter');
  await expect(menu).not.toBeVisible();
  expect(await page.evaluate(() => window.completionViews[0].state.doc.toString())).toBe(`\\cite{${bibliography[1].key}`);
});

test('狭い画面では文献候補と詳細を上下に表示し，詳細を最後まで読める', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await openEditor(page);
  await page.evaluate(() => window.openCitationMenu(0, true));
  const menu = page.locator('#left-editor .tex-completion-menu');
  await expect(menu.locator('.tex-completion-key')).toHaveText(bibliography[0].key);
  await expect.poll(() => menuBounds(page)).toMatchObject({ separate: true, contained: true, listFits: true, detailFits: true, detailScrollable: true, layout: 'rows' });
  await menu.locator('.cm-completionInfo').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(menu.locator('.tex-completion-location')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('completion-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(page.locator('#left-editor .cm-content')).toBeFocused();
});

test('左右の原稿で補完の表示を各ペインに収め，幅を変更すると配置も追従する', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await openEditor(page, { split: '1' });
  for (const [index, editor] of [[0, '#left-editor'], [1, '#right-editor']]) {
    await page.evaluate(index => window.openCitationMenu(index), index);
    await expect.poll(() => menuBounds(page, editor)).toMatchObject({ separate: true, contained: true, listFits: true, detailFits: true, layout: 'rows' });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator(`${editor} .tex-completion-key`)).toHaveText(bibliography[1].key);
  }
  const leftBefore = await page.evaluate(() => window.completionViews[0].state.doc.toString());
  await page.screenshot({ path: testInfo.outputPath('completion-right-pane.png') });
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect.poll(() => menuBounds(page, '#right-editor')).toMatchObject({ separate: true, contained: true, listFits: true, detailFits: true, layout: 'columns' });
  await expect(page.locator('#right-editor .tex-completion-key')).toHaveText(bibliography[1].key);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.completionViews[1].state.doc.toString())).toBe(`\\cite{${bibliography[1].key}`);
  expect(await page.evaluate(() => window.completionViews[0].state.doc.toString())).toBe(leftBefore);
});

test('相互参照の詳細にも見出しとファイルの位置を表示する', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 600 });
  await openEditor(page);
  await page.evaluate(() => window.openCitationMenu(0, false, false));
  const menu = page.locator('#left-editor .tex-completion-menu');
  await expect(menu.locator('.tex-completion-title')).toHaveText('長い節の見出しと補足情報');
  await expect(menu.locator('.tex-completion-location')).toHaveText('chapters/intro.tex:82');
  await expect.poll(() => menuBounds(page)).toMatchObject({ separate: true, contained: true, listFits: true, detailFits: true, layout: 'rows' });
});
