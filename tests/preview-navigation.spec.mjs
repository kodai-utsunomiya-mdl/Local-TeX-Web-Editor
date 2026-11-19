import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41539';
const scripts = new Map();

function linkedPDF() {
  const stream = text => { const value = `BT /F1 20 Tf 160 615 Td (${text}) Tj ET\n`; return `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}endstream`; };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 4 0 R /Annots [9 0 R] >>',
    stream('Open the reference'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 6 0 R >>',
    stream('Middle page'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 10 0 R >> >> /Contents 8 0 R >>',
    stream('Reference destination'),
    '<< /Type /Annot /Subtype /Link /Rect [160 600 400 640] /Border [0 0 0] /A << /S /GoTo /D [7 0 R /XYZ 36 720 null] >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
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
    window.errors = [];
    const navigate = action => window.navigation.navigate(action);
    window.preview = ${kind === 'pdf' ? "new PDFViewer({token:'test-token',onError:error=>window.errors.push(error.message),onNavigate:navigate})" : "new AssetPreview({token:'test-token',onNavigate:navigate})"};
    window.navigation = new NavigationHistory({capture:()=>window.preview.getViewState(),restore:position=>window.preview.applyViewState(position),
      onChange:value=>{document.getElementById('back').disabled=!value.canBack;document.getElementById('forward').disabled=!value.canForward;}});
    document.getElementById('back').onclick=()=>window.navigation.back();
    document.getElementById('forward').onclick=()=>window.navigation.forward();
    ${kind === 'pdf' ? "await window.preview.load('build-one','project','main.tex');" : "await window.preview.show({path:'references/paper.pdf',kind:'pdf',size:1000},'project');"}
  `;
  const bundled = await build({ stdin: { contents, resolveDir: path.join(repository, 'web/src') }, bundle: true, format: 'esm', write: false });
  const javascript = bundled.outputFiles[0].text; scripts.set(kind, javascript); return javascript;
}

async function openHarness(page, kind) {
  const javascript = await bundleScript(kind);
  const source = await readFile(path.join(repository, 'web/src/index.html'), 'utf8');
  const pane = kind === 'markdown' ? '<div id="preview" class="markdown-preview-container" hidden></div>' :
    source.match(kind === 'pdf' ? /<section class="pdf-pane"[\s\S]*?<\/section>/ : /<section id="asset-preview"[\s\S]*?<\/section>/)?.[0];
  expect(pane).toBeTruthy();
  const styles = ['style.css', 'pdf-search.css', 'markdown-preview.css'];
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/api/pdf', '/api/asset'].includes(url.pathname)) return route.fulfill({ contentType: 'application/pdf', body: linkedPDF() });
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

for (const kind of ['pdf', 'asset']) {
  test(`${kind}: PDF の参照リンクから元の位置へ戻り，再び参照先へ進める`, async ({ page }, testInfo) => {
    await openHarness(page, kind);
    await expect.poll(() => page.evaluate(() => window.preview.ready)).toBe(true);
    await page.evaluate(() => {
      const viewer = window.preview.pageViewer || window.preview.pdfViewer;
      viewer.currentScaleValue = '2'; viewer.update();
      const scroll = window.preview.elements.scroll; scroll.scrollTop = 150; scroll.scrollLeft = 110;
      viewer.update();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => ({ position: window.preview.getViewState(), top: window.preview.elements.scroll.scrollTop, left: window.preview.elements.scroll.scrollLeft }));
    const link = page.locator(kind === 'pdf' ? '#pdf-stage .annotationLayer a' : '#asset-pdf-stage .annotationLayer a').first();
    await expect(link).toBeVisible(); await link.click();
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
}

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
