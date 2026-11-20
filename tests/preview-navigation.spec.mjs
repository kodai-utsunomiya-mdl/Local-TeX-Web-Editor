import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { showPDFControls } from './pdf-controls.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41539';
const scripts = new Map();

function linkedPDF(pageCount = 3) {
  const stream = text => { const value = `BT /F1 20 Tf 160 615 Td (${text}) Tj ET\n`; return `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}endstream`; };
  const pages = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const annotation = 3 + pageCount * 2, font = annotation + 1;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map(number => `${number} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ];
  for (const [index, number] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${number + 1} 0 R${index === 0 ? ` /Annots [${annotation} 0 R]` : ''} >>`,
      stream(index === 0 ? 'Open the reference' : index === pageCount - 1 ? 'Reference destination' : `Middle page ${index + 1}`));
  }
  objects.push(`<< /Type /Annot /Subtype /Link /Rect [160 600 400 640] /Border [0 0 0] /A << /S /GoTo /D [${pages.at(-1)} 0 R /XYZ 36 720 null] >> >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function bundleScript(kind) {
  if (scripts.has(kind)) return scripts.get(kind);
  const contents = kind === 'markdown' ? `
    import { MarkdownPreview } from './markdown-preview.js';
    window.notified = []; window.errors = [];
    window.preview = new MarkdownPreview({container: document.getElementById('preview'), token: 'test-token',
      onUserScroll: position => { window.notified.push(position); window.feedback = window.preview.syncSourceLine(position.sourceLine, position); },
      onError: error => window.errors.push(error.message)});
  ` : `
    import { PDFViewer } from './pdf-viewer.js';
    import { AssetPreview } from './asset-preview.js';
    import { NavigationHistory } from './navigation-history.js';
    window.errors = []; window.darkModeChanges = [];
    const navigate = action => window.navigation.navigate(action);
    const onDarkModeChange = enabled => window.darkModeChanges.push(enabled);
    window.preview = ${kind === 'pdf' ? "new PDFViewer({token:'test-token',onError:error=>window.errors.push(error.message),onNavigate:navigate,onDarkModeChange})" : "new AssetPreview({token:'test-token',onNavigate:navigate,onDarkModeChange})"};
    window.navigation = new NavigationHistory({capture:()=>window.preview.getViewState(),restore:position=>window.preview.applyViewState(position),
      onChange:value=>{document.getElementById('back').disabled=!value.canBack;document.getElementById('forward').disabled=!value.canForward;}});
    document.getElementById('back').onclick=()=>window.navigation.back();
    document.getElementById('forward').onclick=()=>window.navigation.forward();
    ${kind === 'pdf' ? "await window.preview.load('build-one','project','main.tex');" : "await window.preview.show({path:'references/paper.pdf',kind:'pdf',size:1000},'project');"}
  `;
  const bundled = await build({ stdin: { contents, resolveDir: path.join(repository, 'web/src') }, bundle: true, format: 'esm', write: false });
  const javascript = bundled.outputFiles[0].text; scripts.set(kind, javascript); return javascript;
}

async function openHarness(page, kind, { pdf = linkedPDF() } = {}) {
  const javascript = await bundleScript(kind);
  const source = await readFile(path.join(repository, 'web/src/index.html'), 'utf8');
  const pane = kind === 'markdown' ? '<div id="preview" class="markdown-preview-container" hidden></div>' :
    source.match(kind === 'pdf' ? /<section class="pdf-pane"[\s\S]*?<\/section>/ : /<section id="asset-preview"[\s\S]*?<\/section>/)?.[0];
  expect(pane).toBeTruthy();
  const styles = ['style.css', 'pdf-search.css', 'writing-workspace.css', 'markdown-preview.css', 'pdf-appearance.css'];
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/api/pdf', '/api/asset'].includes(url.pathname)) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    if (styles.includes(url.pathname.slice(1))) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', url.pathname.slice(1))) });
    if (url.pathname === '/pdf.worker.min.mjs') return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')) });
    if (url.pathname === '/pdf_viewer.css') return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/web/pdf_viewer.css')) });
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/pdf_viewer.css">${styles.map(style => `<link rel="stylesheet" href="/${style}">`).join('')}
      <style>body { margin:0; } .test-controls { height:42px; display:flex; gap:8px; align-items:center; }
        #pdf-pane,#asset-preview,#preview { width:900px; height:550px; flex:none; } #preview { overflow:auto; }</style>
      </head><body><div class="test-controls"><button id="back" disabled>Back</button><button id="forward" disabled>Forward</button></div>${pane}<script type="module" src="/harness.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => !!window.preview)).toBe(true);
}

async function samplePDFPaper(page, canvas) {
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const screenshot = await page.screenshot({ clip: { x: Math.ceil(box.x + 15), y: Math.ceil(box.y + 15), width: 4, height: 4 } });
  return page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    return [...context.getImageData(1, 1, 1, 1).data].slice(0, 3);
  }, screenshot.toString('base64'));
}

for (const kind of ['pdf', 'asset']) {
  test(`${kind}: 820 px，500 px と狭いペインで PDF の操作欄を 1 行に収める`, async ({ page }, testInfo) => {
    await openHarness(page, kind, { pdf: linkedPDF(108) });
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    await expect(page.locator(`#${kind}-pages`)).toHaveText('108');
    const toolbar = page.locator(kind === 'pdf' ? '.pdf-toolbar' : '.asset-toolbar');
    const pageInput = page.locator(`#${kind}-page`);
    if (kind === 'pdf') await page.evaluate(() => {
      document.getElementById('pdf-state').textContent = 'Up to date';
      document.getElementById('pdf-document').textContent = 'thesis2027_utsunomiya.tex';
    });
    for (const width of [820, 760, 620, 600, 500, 320, 240, 820]) {
      await page.setViewportSize({ width: Math.max(360, width + 32), height: 760 });
      await page.evaluate(({ kind, width }) => {
        document.body.classList.add('preview-mode');
        document.getElementById(kind === 'pdf' ? 'pdf-pane' : 'asset-preview').style.width = `${width}px`;
      }, { kind, width });
      await expect(toolbar).toHaveAttribute('data-pdf-compact', String(width < (kind === 'pdf' ? 600 : 420)));
      if (kind === 'pdf') {
        await expect(toolbar).toHaveAttribute('data-pdf-details', String(width >= 760));
        for (const label of ['#pdf-state', '#pdf-document']) {
          if (width >= 760) await expect(page.locator(label)).toBeVisible();
          else await expect(page.locator(label)).toBeHidden();
        }
      }
      const layout = await toolbar.evaluate(element => {
        const area = element.getBoundingClientRect();
        const outside = [...element.querySelectorAll('button, input, select')].filter(control => {
          const box = control.getBoundingClientRect();
          return box.width && box.height && (box.left < area.left - 1 || box.right > area.right + 1 || box.top < area.top - 1 || box.bottom > area.bottom + 1);
        }).map(control => control.id || control.dataset.testid);
        return { height: area.height, overflow: element.scrollWidth > element.clientWidth + 1, outside };
      });
      expect(layout.height).toBeLessThanOrEqual(40);
      expect(layout.overflow).toBe(false); expect(layout.outside).toEqual([]);
      const zoomIn = page.locator(`#${kind}-zoom-in`), zoomOut = page.locator(`#${kind}-zoom-out`);
      await expect(zoomIn).toBeVisible(); await expect(zoomOut).toBeVisible();
      if (kind === 'pdf') await expect(page.locator('#download-pdf')).toBeVisible();
      const scale = () => page.evaluate(() => (window.preview.pageViewer || window.preview.pdfViewer).currentScale);
      const beforeZoom = await scale();
      await zoomIn.click(); await expect.poll(scale).toBeGreaterThan(beforeZoom);
      const enlarged = await scale();
      await zoomOut.click(); await expect.poll(scale).toBeLessThan(enlarged);
      if ([500, 240].includes(width)) await page.screenshot({ path: testInfo.outputPath(`${kind}-pdf-toolbar-${width}-closed.png`) });
      await expect(pageInput).toBeVisible();
      await pageInput.fill('2'); await pageInput.press('Enter');
      await expect.poll(() => page.evaluate(() => window.preview.pageNumber || window.preview.pdfViewer.currentPageNumber)).toBe(2);
      if (!await page.locator(`#${kind}-prev`).isVisible()) await showPDFControls(page, kind);
      await page.locator(`#${kind}-prev`).click();
      await expect(pageInput).toHaveValue('1');
      if (await page.getByTestId(`${kind}-more`).isVisible()) await page.keyboard.press('Escape');

      await showPDFControls(page, kind);
      const zoom = page.locator(`#${kind}-zoom`), toggle = page.getByTestId(`${kind}-dark-mode`);
      await expect(zoom).toBeVisible(); await expect(toggle).toBeVisible();
      const zoomRows = await page.locator(`#${kind}-view-controls .pdf-zoom-controls`).evaluate(element =>
        [...element.querySelectorAll('button, select')].map(control => {
          const box = control.getBoundingClientRect();
          return box.top + box.height / 2;
        }));
      expect(Math.max(...zoomRows) - Math.min(...zoomRows)).toBeLessThan(2);
      await zoom.selectOption('1');
      const initial = await toggle.getAttribute('aria-pressed');
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', String(initial !== 'true'));
      if (kind === 'pdf') {
        await expect(page.locator('#download-pdf')).toBeVisible();
        await page.getByTestId('pdf-search-toggle').click();
        await expect(page.getByTestId('pdf-search-input')).toBeFocused();
        await page.getByTestId('pdf-search-input').fill('reference');
        await expect(page.getByTestId('pdf-search-count')).toContainText('2');
        await page.getByTestId('pdf-search-input').press('Escape');
        await showPDFControls(page);
        await expect(page.locator('.pdf-toolbar .navigation-actions')).toBeVisible();
        await expect(page.locator('#preview-mode')).toBeVisible();
      } else await expect(page.locator('#asset-reload')).toBeVisible();
      const menu = page.locator(`#${kind}-view-controls`);
      const bounds = await menu.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(Math.max(360, width + 32));
      await page.screenshot({ path: testInfo.outputPath(`${kind}-pdf-toolbar-${width}.png`) });
      if (await page.getByTestId(`${kind}-more`).isVisible()) await page.keyboard.press('Escape');
    }
    expect(await page.evaluate(() => window.errors)).toEqual([]);
  });

  test(`${kind}: PDF の画面だけを暗くし，文字を選択しても元の PDF の内容は変わらない`, async ({ page }, testInfo) => {
    await openHarness(page, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    const stage = kind === 'pdf' ? '#pdf-stage' : '#asset-pdf-stage';
    const scroll = page.locator(kind === 'pdf' ? '#pdf-scroll' : '#asset-scroll');
    const toggle = page.getByTestId(`${kind}-dark-mode`);
    const canvas = page.locator(`${stage} .canvasWrapper > canvas`).first();
    const original = linkedPDF();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(scroll).toHaveAttribute('data-pdf-theme', 'original');
    const light = await samplePDFPaper(page, canvas);
    expect(Math.min(...light)).toBeGreaterThan(240);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(scroll).toHaveAttribute('data-pdf-theme', 'dark');
    const dark = await samplePDFPaper(page, canvas);
    expect(Math.max(...dark)).toBeLessThan(60);
    expect(await page.evaluate(() => window.darkModeChanges)).toEqual([true]);
    expect(await canvas.evaluate(element => [...element.getContext('2d').getImageData(15, 15, 1, 1).data].slice(0, 3))).toEqual([255, 255, 255]);
    expect(Buffer.from(await page.evaluate(async () => [...await window.preview.document.getData()]))).toEqual(original);
    const downloaded = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())],
      `${origin}/api/${kind === 'pdf' ? 'pdf?build=build-one' : 'asset?path=references%2Fpaper.pdf'}`);
    expect(Buffer.from(downloaded)).toEqual(original);

    const text = page.locator(`${stage} .textLayer`).first().locator('span').filter({ hasText: 'Open the reference' }).first();
    await expect(text).toBeVisible();
    expect(await text.evaluate(element => {
      const selection = document.getSelection(), range = document.createRange();
      range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })).toBe('Open the reference');
    await expect.poll(() => page.evaluate(stage => {
      const layer = document.querySelector(`${stage} .textLayer`);
      const overlay = document.querySelector(`${stage} .canvasWrapper > .selection`);
      return overlay ? getComputedStyle(overlay).backgroundColor : getComputedStyle(layer.querySelector('span'), '::selection').backgroundColor;
    }, stage)).toBe('rgba(80, 145, 245, 0.45)');
    await page.screenshot({ path: testInfo.outputPath(`${kind}-dark-pdf-selection.png`) });
    await page.evaluate(() => document.getSelection().removeAllRanges());

    if (kind === 'pdf') {
      await page.getByTestId('pdf-search-toggle').click();
      await page.getByTestId('pdf-search-input').fill('reference');
      const result = page.locator(`${stage} .textLayer .highlight.selected`).first();
      await expect(result).toBeVisible();
      expect(await result.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, outline: getComputedStyle(element).outlineColor })))
        .toEqual({ background: 'rgba(245, 178, 67, 0.45)', outline: 'rgb(255, 212, 119)' });
      await page.screenshot({ path: testInfo.outputPath('dark-pdf-search.png') });
      await page.getByTestId('pdf-search-input').press('Escape');
    }

    await page.emulateMedia({ media: 'print' });
    await expect(canvas).toHaveCSS('filter', 'none');
    await page.emulateMedia({ media: 'screen' });
    await toggle.click();
    await expect(scroll).toHaveAttribute('data-pdf-theme', 'original');
    await expect(canvas).toHaveCSS('filter', 'none');
    expect(await page.evaluate(() => window.darkModeChanges)).toEqual([true, false]);
    await page.evaluate(() => window.preview.setDarkMode(true));
    await expect(scroll).toHaveAttribute('data-pdf-theme', 'dark');
    expect(await page.evaluate(() => window.darkModeChanges)).toEqual([true, false]);

    await page.setViewportSize({ width: 360, height: 760 });
    await page.evaluate(kind => {
      document.body.classList.add('preview-mode');
      document.getElementById(kind === 'pdf' ? 'pdf-pane' : 'asset-preview').style.width = '320px';
    }, kind);
    await expect.poll(() => toggle.evaluate(element => {
      const toolbar = element.closest('.pdf-toolbar, .asset-toolbar');
      return toolbar.scrollWidth <= toolbar.clientWidth;
    })).toBe(true);
    await showPDFControls(page, kind);
    await expect(toggle).toBeVisible();
    const bounds = await toggle.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    await toggle.click();
    await expect(scroll).toHaveAttribute('data-pdf-theme', 'original');
    await page.screenshot({ path: testInfo.outputPath(`${kind}-pdf-controls-narrow.png`) });
    expect(await page.evaluate(() => window.errors)).toEqual([]);
  });

  test(`${kind}: PDF の参照リンクから元の位置へ戻り，再び参照先へ進める`, async ({ page }, testInfo) => {
    await openHarness(page, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    await page.evaluate(() => {
      const viewer = window.preview.pageViewer || window.preview.pdfViewer;
      viewer.currentScaleValue = '2'; viewer.update();
      const scroll = window.preview.elements.scroll; scroll.scrollTop = 150; scroll.scrollLeft = 110;
      viewer.update();
    });
    const link = page.locator(kind === 'pdf' ? '#pdf-stage .annotationLayer a' : '#asset-pdf-stage .annotationLayer a').first();
    await expect(link).toBeVisible();
    // Bring the complete link into view before recording the position to restore.
    await link.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => ({ position: window.preview.getViewState(), top: window.preview.elements.scroll.scrollTop, left: window.preview.elements.scroll.scrollLeft }));
    await link.click();
    await expect(page.locator('#back')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.preview.pageNumber || window.preview.pdfViewer.currentPageNumber)).toBe(3);
    const after = await page.evaluate(() => ({ top: window.preview.elements.scroll.scrollTop, left: window.preview.elements.scroll.scrollLeft }));
    await page.locator('#back').click();
    await expect(page.locator('#forward')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.preview.pageNumber || window.preview.pdfViewer.currentPageNumber)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollTop).then(value => Math.abs(value - before.top))).toBeLessThan(3);
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollLeft).then(value => Math.abs(value - before.left))).toBeLessThan(3);
    await page.locator('#forward').click();
    await expect(page.locator('#back')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollTop).then(value => Math.abs(value - after.top))).toBeLessThan(3);
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollLeft).then(value => Math.abs(value - after.left))).toBeLessThan(3);
    expect(await page.evaluate(() => window.errors)).toEqual([]);
    await testInfo.attach(`${kind}-navigation.json`, { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  });

  test(`${kind}: 別の PDF から戻る際に読み込みを待ち，非表示中の位置を表示時に適用する`, async ({ page }) => {
    await openHarness(page, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    const position = await page.evaluate(() => {
      const viewer = window.preview.pageViewer || window.preview.pdfViewer;
      viewer.currentScaleValue = '2'; viewer.update();
      window.preview.elements.scroll.scrollTop = 150; window.preview.elements.scroll.scrollLeft = 110;
      viewer.update();
      return window.preview.getViewState();
    });
    await page.evaluate(async kind => {
      if (kind === 'pdf') await window.preview.load('other-build', 'project', 'other.tex');
      else await window.preview.show({ path: 'other.pdf', kind: 'pdf' }, 'project');
    }, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    let requested, release;
    const requestStarted = new Promise(resolve => { requested = resolve; });
    const responseReady = new Promise(resolve => { release = resolve; });
    await page.route(`${origin}/api/${kind === 'pdf' ? 'pdf' : 'asset'}?**`, async route => {
      requested(); await responseReady;
      await route.fulfill({ contentType: 'application/pdf', body: linkedPDF() });
    });
    const restored = page.evaluate(async ({ kind, position }) => {
      const pane = document.getElementById(kind === 'pdf' ? 'pdf-pane' : 'asset-preview');
      pane.style.display = 'none'; window.restoreDone = false;
      const loading = kind === 'pdf' ? window.preview.load('build-one', 'project', 'main.tex')
        : window.preview.show({ path: position.path, kind: 'pdf' }, 'project');
      const applying = window.preview.applyViewState(position);
      const result = await applying; await loading;
      window.restoreDone = true;
      return result;
    }, { kind, position });
    await requestStarted;
    expect(await page.evaluate(() => window.restoreDone)).toBe(false);
    release();
    expect(await restored).toBe(true);
    await page.evaluate(kind => {
      document.getElementById(kind === 'pdf' ? 'pdf-pane' : 'asset-preview').style.display = '';
      window.preview.refreshLayout?.();
    }, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollTop).then(value => Math.abs(value - 150))).toBeLessThan(3);
    await expect.poll(() => page.evaluate(() => window.preview.elements.scroll.scrollLeft).then(value => Math.abs(value - 110))).toBeLessThan(3);
    expect(await page.evaluate(() => window.errors)).toEqual([]);
  });
}

test('画像を開くと PDF の配色ボタンを隠し，PDF へ戻ると選んだ配色で開く', async ({ page }) => {
  await openHarness(page, 'asset');
  await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
  await page.getByTestId('asset-dark-mode').click();
  await page.route(`${origin}/api/asset?path=figure.svg`, route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#fff"/><circle cx="40" cy="20" r="15" fill="#d44"/></svg>' }));
  await page.evaluate(() => window.preview.show({ path: 'figure.svg', kind: 'image', size: 180 }, 'project'));
  await expect(page.getByTestId('asset-image')).toBeVisible();
  await expect(page.getByTestId('asset-dark-mode')).toBeHidden();
  await expect(page.locator('#asset-scroll')).toHaveAttribute('data-pdf-theme', 'original');
  await expect(page.getByTestId('asset-image')).toHaveCSS('filter', 'none');
  expect(await page.evaluate(() => window.preview.darkMode)).toBe(true);
  await page.evaluate(() => window.preview.show({ path: 'references/paper.pdf', kind: 'pdf', size: 1000 }, 'project'));
  await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
  await expect(page.getByTestId('asset-dark-mode')).toBeVisible();
  await expect(page.getByTestId('asset-dark-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#asset-scroll')).toHaveAttribute('data-pdf-theme', 'dark');
  expect(await page.evaluate(() => window.darkModeChanges)).toEqual([true]);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('再コンパイル後にページが減った PDF へ以前の位置を戻すと，最後のページが開く', async ({ page }) => {
  await openHarness(page, 'pdf');
  await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
  const position = await page.evaluate(async () => { await window.preview.goToPage(3); return window.preview.getViewState(); });
  await page.route(`${origin}/api/pdf?build=recompiled`, route => route.fulfill({ contentType: 'application/pdf', body: linkedPDF(1) }));
  const restored = await page.evaluate(async position => {
    await window.preview.load('recompiled', 'project', 'main.tex');
    return window.preview.applyViewState(position);
  }, position);
  expect(restored).toBe(true);
  expect(await page.evaluate(() => window.preview.getViewState())).toMatchObject({ main: 'main.tex', buildId: 'recompiled', pageNumber: 1 });
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('Markdown のユーザースクロールを原稿の行へ対応させ，同期によるスクロールは通知しない', async ({ page }) => {
  await openHarness(page, 'markdown');
  const content = ['# Notes', '', ...Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.\n`),
    'A long paragraph with several wrapped lines. '.repeat(100), '', ...Array.from({ length: 50 }, (_, i) => `Following paragraph ${i}.\n`)].join('\n');
  await page.evaluate(content => { window.preview.update(content, { path: 'notes.md', projectRoot: 'project', immediate: true }); window.preview.show(); }, content);
  const container = page.locator('#preview');
  await expect(container).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => window.preview.syncSourceLine(43.25));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.notified)).toEqual([]);
  await container.hover(); await page.mouse.wheel(0, 160);
  await expect.poll(() => page.evaluate(() => window.notified.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.feedback)).toBe(false);
  const position = await page.evaluate(() => window.notified.at(-1));
  expect(position.path).toBe('notes.md'); expect(position.projectRoot).toBe('project');
  expect(position.sourceLine).toBeGreaterThan(43.25);
  expect(position.fraction).toBeGreaterThanOrEqual(0); expect(position.fraction).toBeLessThan(1);
  const initial = await page.evaluate(() => window.preview.getViewState());
  const count = await page.evaluate(() => window.notified.length);
  await page.evaluate(() => window.preview.syncSourceLine(10));
  await page.evaluate(position => window.preview.applyViewState(position), initial);
  expect(await page.evaluate(() => window.notified.length)).toBe(count);
  expect(await page.evaluate(() => window.preview.getViewState())).toEqual(initial);
  await page.evaluate(() => window.preview.setScrollSync(false));
  await container.hover(); await page.mouse.wheel(0, 160);
  await expect.poll(() => container.evaluate(element => element.scrollTop)).toBeGreaterThan(initial.top + 100);
  expect(await page.evaluate(() => window.notified.length)).toBe(count);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('Markdown は先頭と末尾を両方向に揃え，幅が変わった後も末尾へ追従する', async ({ page }) => {
  await openHarness(page, 'markdown');
  const content = ['# Long notes', '', ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.\n`), 'A final paragraph that wraps many times. '.repeat(300)].join('\n');
  await page.evaluate(content => { window.preview.update(content, { path: 'notes.md', projectRoot: 'project', immediate: true }); window.preview.show(); }, content);
  const container = page.locator('#preview');
  await expect(container).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => window.preview.syncSourceLine(40, { atEnd: true }));
  const bottomGap = () => container.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  await expect.poll(bottomGap).toBeLessThan(2);
  expect(await page.evaluate(() => window.notified)).toEqual([]);
  await container.evaluate(element => { element.style.width = '520px'; });
  await expect.poll(bottomGap).toBeLessThan(2);
  expect(await page.evaluate(() => window.notified)).toEqual([]);
  await page.evaluate(() => window.preview.syncSourceLine(20, { atStart: true }));
  await expect.poll(() => container.evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.notified)).toEqual([]);
  await container.hover(); await page.mouse.wheel(0, 100000);
  await expect.poll(() => page.evaluate(() => window.notified.at(-1)?.atEnd)).toBe(true);
  expect(await page.evaluate(() => window.feedback)).toBe(false);
  const countAtEnd = await page.evaluate(() => window.notified.length);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.notified.length)).toBe(countAtEnd);
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => page.evaluate(() => window.notified.at(-1)?.atStart)).toBe(true);
  expect(await page.evaluate(() => window.feedback)).toBe(false);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});
