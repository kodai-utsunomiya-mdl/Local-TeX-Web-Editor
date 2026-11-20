import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41541';
const bundles = new Map();
const citations = [
  { key: 'smith2026', title: 'Learning <with> Gaussian features', author: 'A. Smith', year: '2026', path: 'references.bib' },
  { key: '日本語%2026', title: '日本語で書かれた文献の題名', author: '著者', year: '2025', path: 'references.bib' },
];

function citedPDF() {
  const pdfString = text => `<FEFF${Array.from({ length: text.length }, (_, index) => text.charCodeAt(index).toString(16).padStart(4, '0')).join('')}>`;
  const stream = lines => {
    const text = lines.map(([label, y]) => `BT /F1 20 Tf 160 ${y} Td (${label}) Tj ET\n`).join('');
    return `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`;
  };
  const link = (destination, y) => `<< /Type /Annot /Subtype /Link /Rect [160 ${y} 430 ${y + 38}] /Border [0 0 0] /A << /S /GoTo /D ${pdfString(destination)} >> >>`;
  const destinations = ['cite.smith2026', 'cite.2@日本語%2026', 'section.smith2026'].sort();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests 12 0 R >> >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [8 0 R 9 0 R 10 0 R 11 0 R] >>',
    stream([['Cite Smith', 615], ['Cite another paper', 565], ['Open a section', 515], ['External link', 465]]),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream([['Bibliography', 700]]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    link('cite.smith2026', 600),
    link('cite.2@日本語%2026', 550),
    link('section.smith2026', 500),
    '<< /Type /Annot /Subtype /Link /Rect [160 450 430 488] /Border [0 0 0] /A << /S /URI /URI (https://example.test/#cite.smith2026) >> >>',
    `<< /Names [${destinations.map(name => `${pdfString(name)} [5 0 R /XYZ 36 720 null]`).join(' ')}] >>`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function openCitations(page, kind, { initiallyIndexed = true } = {}) {
  if (!bundles.has(kind)) {
    const contents = `
      import { PDFViewer } from './pdf-viewer.js';
      import { AssetPreview } from './asset-preview.js';
      window.errors = []; window.citationEntries = ${JSON.stringify(citations)};
      const getCitations = () => window.citationEntries;
      window.preview = ${kind === 'pdf'
        ? "new PDFViewer({ token: 'test-token', getCitations, onError: error => window.errors.push(error.message) })"
        : "new AssetPreview({ token: 'test-token', getCitations })"};
      window.loadPDF = () => ${kind === 'pdf'
        ? "window.preview.load('build-' + Math.random(), 'project', 'main.tex')"
        : "window.preview.show({ path: 'references/paper.pdf', kind: 'pdf', size: 1200 }, 'project')"};
      if (location.search) window.citationEntries = [];
      await window.loadPDF();
    `;
    const result = await build({ stdin: { contents, resolveDir: path.join(repository, 'web/src') }, bundle: true, format: 'esm', write: false });
    bundles.set(kind, result.outputFiles[0].text);
  }
  const source = await readFile(path.join(repository, 'web/src/index.html'), 'utf8');
  const pane = source.match(kind === 'pdf' ? /<section class="pdf-pane"[\s\S]*?<\/section>/ : /<section id="asset-preview"[\s\S]*?<\/section>/)?.[0];
  expect(pane).toBeTruthy();
  const pdf = citedPDF();
  const styles = ['style.css', 'pdf-search.css', 'writing-workspace.css', 'pdf-appearance.css', 'pdf-citations.css'];
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: bundles.get(kind) });
    if (['/api/pdf', '/api/asset'].includes(url.pathname)) return route.fulfill({ contentType: 'application/pdf', body: pdf });
    if (styles.includes(url.pathname.slice(1))) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', url.pathname.slice(1))) });
    if (url.pathname === '/pdf.worker.min.mjs') return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')) });
    if (url.pathname === '/pdf_viewer.css') return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/web/pdf_viewer.css')) });
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/pdf_viewer.css">${styles.map(style => `<link rel="stylesheet" href="/${style}">`).join('')}
      <style>body { margin:0; } #pdf-pane,#asset-preview { width:900px; height:850px; flex:none; }</style>
      </head><body>${pane}<script type="module" src="/harness.js"></script></body></html>` });
  });
  await page.goto(`${origin}/${initiallyIndexed ? '' : '?index-later'}`);
  await expect.poll(() => page.evaluate(() => !!window.preview?.ready)).toBe(true);
  const stage = page.locator(kind === 'pdf' ? '#pdf-stage' : '#asset-pdf-stage');
  await expect(stage.locator('.annotationLayer a')).toHaveCount(4);
  return stage;
}

for (const kind of ['pdf', 'asset']) {
  test(`${kind}: PDF の引用の題名をマウスとキーボードで確認できる`, async ({ page }) => {
    const stage = await openCitations(page, kind);
    const smith = stage.locator('[data-pdf-citation-key="smith2026"]');
    const japanese = stage.locator('[data-pdf-citation-key="日本語%2026"]');
    const tooltip = page.getByRole('tooltip');
    await expect(smith).toHaveAttribute('title', /Learning <with> Gaussian features/);
    await smith.hover();
    await expect(tooltip).toContainText(citations[0].title);
    await expect(tooltip).toContainText('A. Smith · 2026');
    await expect(tooltip.locator('img')).toHaveCount(0);
    await expect(smith).not.toHaveAttribute('title');
    await japanese.hover();
    await expect(tooltip).toContainText(citations[1].title);
    await expect(tooltip).not.toContainText(citations[0].title);
    await page.mouse.move(1, 1);
    await expect(tooltip).not.toBeVisible();
    await smith.focus();
    await expect(tooltip).toContainText(citations[0].title);
    await expect(smith).toHaveAttribute('aria-describedby', /pdf-citation-tooltip-/);
    await page.keyboard.press('Escape');
    await expect(tooltip).not.toBeVisible();
    await expect(smith).not.toHaveAttribute('aria-describedby');

    const section = stage.locator('a[href="#section.smith2026"]');
    await section.hover();
    await expect(tooltip).not.toBeVisible();
    await expect(section).not.toHaveAttribute('data-pdf-citation-key');
    await expect(stage.locator('a[href^="https://"]')).not.toHaveAttribute('data-pdf-citation-key');
    await smith.click();
    await expect.poll(() => page.evaluate(() => (window.preview.pageViewer || window.preview.pdfViewer).currentPageNumber)).toBe(2);
    await expect(tooltip).not.toBeVisible();
    expect(await page.evaluate(() => window.errors)).toEqual([]);
  });

  test(`${kind}: 文献の読み込み，PDF の倍率と文書の変更後も題名が更新される`, async ({ page }, testInfo) => {
    const stage = await openCitations(page, kind, { initiallyIndexed: false });
    const smith = stage.locator('a[href="#cite.smith2026"]');
    await expect(smith).not.toHaveAttribute('data-pdf-citation-key');
    await page.evaluate(entries => { window.citationEntries = entries; window.preview.citationTitles.refresh(); }, citations);
    await expect(smith).toHaveAttribute('data-pdf-citation-key', 'smith2026');
    await page.evaluate(() => { (window.preview.pageViewer || window.preview.pdfViewer).currentScaleValue = '1.5'; });
    await smith.hover();
    await expect(page.getByRole('tooltip')).toContainText(citations[0].title);
    await page.mouse.move(1, 1);
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await page.evaluate(async () => {
      window.citationEntries = [{ key: 'smith2026', title: 'A bibliography from the next PDF', author: 'B. Writer', year: '2027' }];
      await window.loadPDF();
    });
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await smith.hover();
    await expect(page.getByRole('tooltip')).toContainText('A bibliography from the next PDF');
    await expect(page.getByRole('tooltip')).not.toContainText(citations[0].title);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--surface', '#202529');
      document.documentElement.style.setProperty('--text', '#e9edf0');
      window.citationEntries = [{ key: 'smith2026', title: 'A long bibliography title '.repeat(12), author: 'B. Writer', year: '2027' }];
      window.preview.citationTitles.refresh();
    });
    await expect(page.getByRole('tooltip')).toHaveCSS('background-color', 'rgb(32, 37, 41)');
    await expect(page.getByRole('tooltip')).toHaveCSS('color', 'rgb(233, 237, 240)');
    const box = await page.getByRole('tooltip').boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`${kind}-citation-title.png`) });
    await page.evaluate(() => { window.citationEntries = []; window.preview.citationTitles.refresh(); });
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await expect(smith).not.toHaveAttribute('data-pdf-citation-key');
    expect(await page.evaluate(() => window.errors)).toEqual([]);
  });
}
