import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41542';
let javascript;

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { createPanelLayout, normalizePanelLayout } from './panel-layout.js';
        const $ = id => document.getElementById(id);
        let preferences = normalizePanelLayout(JSON.parse(localStorage.getItem('panels') || 'null'));
        window.layout = createPanelLayout({ workbench: $('workbench'), shell: $('app-shell'),
          handles: { sidebar: $('sidebar-splitter'), editor: $('splitter'), log: $('log-splitter') },
          getPreferences: () => preferences,
          onChange: (value, persist) => { preferences = value; if (persist) localStorage.setItem('panels', JSON.stringify(value)); },
        });
        window.panelPreferences = () => preferences;
        window.setPreviewVisible = visible => {
          layout.setPreviewVisible(visible);
          $('app-shell').classList.toggle('preview-mode', visible && matchMedia('(max-width: 900px)').matches);
          layout.refresh();
        };
        $('preview-toggle').addEventListener('click', () => setPreviewVisible(!preferences.previewVisible));
        $('sidebar-toggle').addEventListener('click', () => { $('app-shell').classList.toggle('sidebar-collapsed'); layout.refresh(); });`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  javascript = bundled.outputFiles[0].text;
});

async function openLayout(page) {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/layout.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src/style.css')) });
    if (pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><style>.sample-page { width: 1200px; height: 1600px; background: white; margin: 12px; }</style>
      </head><body><div id="app-shell" class="app-shell">
      <header class="app-header"><button id="preview-toggle">Preview</button><button id="sidebar-toggle">Files</button></header>
      <main id="workbench" class="workbench">
        <aside id="file-pane" class="file-pane">Files</aside>
        <div id="sidebar-splitter" class="sidebar-splitter panel-splitter" role="separator" tabindex="0"></div>
        <section id="editor-pane" class="editor-pane"><div class="editor-toolbar">Source</div><div class="editor-host">Text</div></section>
        <div id="splitter" class="splitter panel-splitter" role="separator" tabindex="0"></div>
        <section id="pdf-pane" class="pdf-pane"><div class="pdf-toolbar">PDF</div><div class="pdf-frame"><div id="pdf-scroll" class="pdf-scroll"><div class="sample-page"></div></div></div></section>
        <section id="log-panel" class="log-panel"><div id="log-splitter" class="log-splitter panel-splitter" role="separator" tabindex="0"></div><div>Compilation log</div></section>
      </main></div><script type="module" src="/layout.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.layout))).toBe(true);
}

async function bounds(page) {
  return page.evaluate(() => {
    const rectangle = id => {
      const { left, right, width, height } = document.getElementById(id).getBoundingClientRect();
      return { left, right, width, height };
    };
    return { workbench: rectangle('workbench'), editor: rectangle('editor-pane'), preview: rectangle('pdf-pane'), log: rectangle('log-panel') };
  });
}

async function expectRightEdge(page, pane = 'preview') {
  await expect.poll(async () => { const measured = await bounds(page); return Math.abs(measured.workbench.right - measured[pane].right); }).toBeLessThan(1);
}

test('境界の両端と小数の幅でも，プレビューの右に空きを作らない', async ({ page }) => {
  await openLayout(page);
  await page.evaluate(() => {
    const workbench = document.getElementById('workbench');
    workbench.style.width = 'calc(100% - .53px)';
    // A subpixel difference makes the smaller track reach its CSS minimum.
    // This reproduces the unused space when the remaining factor is below 1fr.
    workbench.style.paddingRight = '.25px';
  });
  for (const width of [1031, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const key of ['End', 'ArrowLeft', 'End', 'Home', 'ArrowRight', 'Home']) {
      await page.locator('#splitter').focus();
      await page.keyboard.press(key);
      await expectRightEdge(page);
      const measured = await bounds(page);
      expect(measured.editor.width).toBeGreaterThanOrEqual(259);
      expect(measured.preview.width).toBeGreaterThanOrEqual(259);
      expect(measured.log.right).toBeCloseTo(measured.workbench.right, 0);
    }
    await page.locator('#sidebar-toggle').click();
    await page.locator('#splitter').focus(); await page.keyboard.press('End');
    await expectRightEdge(page);
    await page.locator('#sidebar-toggle').click();
    await expectRightEdge(page);
  }
  const divider = await page.locator('#splitter').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  try { await page.mouse.move(1919, divider.y + divider.height / 2, { steps: 8 }); }
  finally { await page.mouse.up(); }
  await expectRightEdge(page);
  expect((await bounds(page)).preview.width).toBeCloseTo(260, 0);
});

test('プレビューを隠して再表示すると，前の幅とスクロール位置で開く', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLayout(page);
  await page.locator('#splitter').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const chosen = await bounds(page);
  const ratio = await page.evaluate(() => panelPreferences().editorRatio);
  await page.locator('#pdf-scroll').evaluate(element => { element.scrollTop = 320; element.scrollLeft = 80; });
  await page.locator('#preview-toggle').click();
  await expect(page.locator('#pdf-pane')).not.toBeVisible();
  await expect(page.locator('#splitter')).not.toBeVisible();
  await expectRightEdge(page, 'editor');
  await expectRightEdge(page, 'log');
  expect(await page.evaluate(() => panelPreferences().editorRatio)).toBe(ratio);
  await page.locator('#preview-toggle').click();
  await expect(page.locator('#pdf-pane')).toBeVisible();
  await expect.poll(async () => Math.abs((await bounds(page)).preview.width - chosen.preview.width)).toBeLessThan(1);
  expect(await page.locator('#pdf-scroll').evaluate(element => [element.scrollTop, element.scrollLeft])).toEqual([320, 80]);
  await expectRightEdge(page);
  await page.locator('#preview-toggle').click();
  await page.reload();
  await expect(page.locator('#app-shell')).toHaveClass(/preview-hidden/);
  await expectRightEdge(page, 'editor');
  expect(await page.evaluate(() => panelPreferences().editorRatio)).toBe(ratio);
  await page.locator('#preview-toggle').click();
  await expect.poll(async () => Math.abs((await bounds(page)).preview.width - chosen.preview.width)).toBeLessThan(1);
  await page.locator('#sidebar-toggle').click();
  await page.locator('#preview-toggle').click();
  const expanded = await bounds(page);
  expect(expanded.editor.left).toBe(expanded.workbench.left);
  await expectRightEdge(page, 'editor');
});

test('画面を狭めて表示を切り替え，再び広げても全幅を使える', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLayout(page);
  await page.locator('#splitter').focus(); await page.keyboard.press('End');
  const chosen = await bounds(page);
  for (const width of [800, 640, 390]) {
    await page.setViewportSize({ width, height: 600 });
    await page.evaluate(() => setPreviewVisible(false));
    await expect(page.locator('#editor-pane')).toBeVisible();
    await expect(page.locator('#pdf-pane')).not.toBeVisible();
    await expectRightEdge(page, 'editor');
    await expectRightEdge(page, 'log');
    await page.evaluate(() => setPreviewVisible(true));
    await expect(page.locator('#pdf-pane')).toBeVisible();
    await expect(page.locator('#editor-pane')).not.toBeVisible();
    await expectRightEdge(page);
    await expect(page.locator('#splitter')).not.toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#editor-pane')).toBeVisible();
  await expect(page.locator('#pdf-pane')).toBeVisible();
  await expect.poll(async () => Math.abs((await bounds(page)).editor.width - chosen.editor.width)).toBeLessThan(1);
  await expectRightEdge(page);
  await page.evaluate(() => setPreviewVisible(false));
  await page.setViewportSize({ width: 390, height: 600 });
  await expectRightEdge(page, 'editor');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#pdf-pane')).not.toBeVisible();
  await expectRightEdge(page, 'editor');
});
