import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const paragraphs = (name, count) => Array.from({ length: count }, (_, index) => `${name} paragraph ${index + 1}.`).join('\n') + '\n';
const tex = '\\section{Introduction}\n' + paragraphs('Opening', 18) + '\\subsection{Background}\n' + paragraphs('Background', 14) + '\\subsubsection{Prior work}\n' + paragraphs('Prior work', 24) + '\\section{Methods with a long heading that can be read in its tooltip}\n' + paragraphs('Methods', 60) + '\\begin{align}\nx &= y + 1 \\\\\ny &= 2\n\\end{align}\n';
const markdown = '# Introduction\n\nMarkdown opening.\n\n## Details\n\n```js\nconst example = 1;\n```\n\n# Next\n\nMore text.\n';
let script;

test.beforeAll(async () => {
  const built = await bundle({
    stdin: {
      resolveDir: path.join(repository, 'web/src'),
      contents: `import { EditorState } from '@codemirror/state';
        import { EditorView } from '@codemirror/view';
        import { StreamLanguage, foldedRanges } from '@codemirror/language';
        import { stex } from '@codemirror/legacy-modes/mode/stex';
        import { markdown } from '@codemirror/lang-markdown';
        import { basicSetup } from 'codemirror';
        import { sourceFolding, revealSourceRange } from './source-folding.js';
        import { createOutlineTree } from './outline-tree.js';
        import { extractOutline } from './tex-tools.js';
        import { setLanguage } from './i18n.js';
        import { english } from './locales/en.js';
        import { outlineEnglish } from './locales/outline-en.js';
        import { resolveAppearance } from './appearance.js';
        Object.assign(english, outlineEnglish); setLanguage('ja');
        const appearance = resolveAppearance({ mode: new URLSearchParams(location.search).get('theme') || 'light' });
        document.documentElement.dataset.theme = appearance.theme; document.documentElement.dataset.palette = appearance.palette;
        for (const [name, color] of Object.entries(appearance.colors)) document.documentElement.style.setProperty('--' + name, color);
        document.documentElement.style.setProperty('--editor-font-family', appearance.fontFamily);
        const sources = { 'main.tex': ${JSON.stringify(tex)}, 'notes.md': ${JSON.stringify(markdown)} };
        let activePath = 'main.tex';
        const filter = document.getElementById('filter');
        const outline = createOutlineTree({ container: document.getElementById('outline'), onJump(path, number) {
          if (path !== activePath) return;
          const line = view.state.doc.line(number);
          view.dispatch({ selection: { anchor: line.from }, effects: [
            ...revealSourceRange(view.state, line.from), EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 })
          ] }); view.focus();
        } });
        function headings() {
          return activePath === 'main.tex' ? extractOutline(view.state.doc.toString()) : [
            { level: 1, title: 'Introduction', line: 1 }, { level: 2, title: 'Details', line: 5 }, { level: 1, title: 'Next', line: 11 }
          ];
        }
        function render() {
          outline.render({ projectRoot: '/project', path: activePath, supported: true, outline: headings(), query: filter.value });
          outline.setActive({ path: activePath, line: view.state.doc.lineAt(view.state.selection.main.head).number });
        }
        function makeState(path, content) {
          return EditorState.create({ doc: content, extensions: [basicSetup, EditorView.lineWrapping,
            path.endsWith('.md') ? markdown() : StreamLanguage.define(stex), sourceFolding(path),
            EditorView.updateListener.of(update => {
              if (update.docChanged) render();
              outline.setActive({ path: activePath, line: update.state.doc.lineAt(update.state.selection.main.head).number });
            })
          ] });
        }
        const view = new EditorView({ parent: document.getElementById('source'), state: makeState(activePath, sources[activePath]) });
        filter.addEventListener('input', render); render();
        window.foldingView = view; window.outlineTree = outline;
        window.foldingCount = () => { let count = 0; foldedRanges(view.state).between(0, view.state.doc.length, () => count++); return count; };
        window.showFoldingDocument = path => {
          sources[activePath] = view.state.doc.toString(); activePath = path; filter.value = '';
          view.setState(makeState(path, sources[path])); render();
        };
        window.setFoldingLanguage = setLanguage;
        window.foldingReady = true;`,
    },
    bundle: true, format: 'esm', write: false,
  });
  script = built.outputFiles[0].text;
});

async function openFixture(page, theme = 'light') {
  const assets = new Map([['/fixture.js', { contentType: 'text/javascript', body: script }]]);
  for (const name of ['style.css', 'outline-tree.css']) assets.set(`/${name}`, {
    contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)),
  });
  assets.set('/', { contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/outline-tree.css">
    <style>#fixture { display: grid; grid-template-columns: minmax(140px, 230px) minmax(0, 1fr); height: 100vh; padding: 12px; gap: 12px; }
      aside { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--surface); }
      #filter { width: 100%; padding: 8px; } #source { border: 1px solid var(--border); }
      @media (max-width: 500px) { #fixture { grid-template-columns: 170px minmax(0, 1fr); padding: 5px; gap: 5px; } }</style>
    </head><body><main id="fixture"><aside><input id="filter" aria-label="Find headings"><nav id="outline" class="outline-tree" aria-label="Source outline"></nav></aside><section class="editor-host" id="source"></section></main>
    <script type="module" src="/fixture.js"></script></body></html>` });
  const origin = 'http://127.0.0.1:41549';
  await page.route(`${origin}/**`, async route => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    await route.fulfill(asset || { status: 404, body: '' });
  });
  await page.goto(`${origin}/?theme=${theme}`);
  await page.waitForFunction(() => window.foldingReady);
}

test('TeX の節をガターから折りたたみ，アウトラインで内部へ移動すると展開して余白を置く', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  await openFixture(page, 'dark');
  await expect(page.locator('#outline .outline-link')).toHaveCount(4);
  await page.locator('#source .cm-foldGutter [title="Fold line"]').first().click();
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(1);
  await expect(page.locator('#source .cm-content')).not.toContainText('Prior work paragraph');
  await page.locator('#outline .outline-link', { hasText: 'Prior work' }).click();
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(0);
  await expect(page.locator('#outline .outline-link.active')).toContainText('Prior work');
  await expect.poll(() => page.evaluate(() => {
    const view = window.foldingView, rect = view.coordsAtPos(view.state.selection.main.head);
    return Math.round(rect.top - view.scrollDOM.getBoundingClientRect().top);
  })).toBeGreaterThanOrEqual(30);
  const distance = await page.evaluate(() => {
    const view = window.foldingView; return view.coordsAtPos(view.state.selection.main.head).top - view.scrollDOM.getBoundingClientRect().top;
  });
  expect(distance).toBeLessThan(70);
  await page.screenshot({ path: testInfo.outputPath('outline-guides-and-source-folding.png') });
});

test('アウトラインの開閉と検索を文書ごとに使い，行の追加や言語変更後も続けられる', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openFixture(page);
  const intro = page.locator('#outline .outline-link', { hasText: 'Introduction' });
  const background = page.locator('#outline .outline-link', { hasText: 'Background' });
  const prior = page.locator('#outline .outline-link', { hasText: 'Prior work' });
  await page.getByRole('button', { name: '下位見出しを折りたたむ: Introduction', exact: true }).click();
  await expect(background).not.toBeVisible();
  await page.locator('#filter').fill('Prior work');
  await expect(page.locator('#outline .outline-link')).toHaveCount(1);
  await expect(prior).toBeVisible();
  await page.locator('#filter').fill('');
  await expect(background).not.toBeVisible();
  await page.evaluate(() => window.foldingView.dispatch({ changes: { from: 0, insert: 'New opening.\n\n' } }));
  await expect(background).not.toBeVisible();
  await expect(intro).toHaveAttribute('data-line', '3');
  await page.evaluate(() => window.showFoldingDocument('notes.md'));
  await expect(page.locator('#outline .outline-link', { hasText: 'Details' })).toBeVisible();
  await page.evaluate(() => window.showFoldingDocument('main.tex'));
  await expect(background).not.toBeVisible();
  await page.evaluate(() => window.setFoldingLanguage('en'));
  await expect(page.getByRole('button', { name: 'Expand child headings: Introduction', exact: true })).toBeVisible();
  await intro.focus(); await page.keyboard.press('ArrowRight');
  await expect(background).toBeVisible();
  await page.keyboard.press('ArrowRight'); await expect(background).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(prior).not.toBeVisible();
  await page.keyboard.press('ArrowLeft'); await expect(intro).toBeFocused();
  const fit = await page.locator('#outline').evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
    guides: [...element.querySelectorAll('.outline-item > .outline-level')].every(level => getComputedStyle(level).borderLeftWidth === '1px') }));
  expect(fit.content).toBeLessThanOrEqual(fit.width + 1); expect(fit.guides).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('outline-narrow.png') });
});

test('Markdown の見出しとコードブロックを標準のキー操作で折りたたんで戻せる', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => window.showFoldingDocument('notes.md'));
  // Physical key names let Playwright apply Shift to the bracket character.
  // A literal '[' still sends key='[' with Shift held and matches Ctrl+[ first.
  const fold = process.platform === 'darwin' ? 'Meta+Alt+BracketLeft' : 'Control+Shift+BracketLeft';
  const unfold = process.platform === 'darwin' ? 'Meta+Alt+BracketRight' : 'Control+Shift+BracketRight';
  await page.evaluate(() => { const view = window.foldingView; view.dispatch({ selection: { anchor: 0 } }); view.focus(); });
  await page.keyboard.press(fold);
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(1);
  await expect(page.locator('#source .cm-content')).not.toContainText('Markdown opening.');
  await page.keyboard.press(unfold);
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(0);
  await page.evaluate(() => { const view = window.foldingView; view.dispatch({ selection: { anchor: view.state.doc.line(7).from } }); view.focus(); });
  await page.keyboard.press(fold);
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(1);
  await expect(page.locator('#source .cm-content')).not.toContainText('const example');
  await page.keyboard.press(unfold);
  await expect.poll(() => page.evaluate(() => window.foldingCount())).toBe(0);
  await expect(page.locator('#source .cm-content')).toContainText('const example');
});
