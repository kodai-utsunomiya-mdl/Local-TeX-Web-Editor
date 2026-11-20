import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41539';
const figure = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64');
const applicationPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
let script;

test.beforeAll(async () => {
  const built = await bundle({ stdin: {
    resolveDir: path.join(repository, 'web/src'), contents: `
      import { createDocumentTools } from './document-tools.js';
      import { setLanguage } from './i18n.js';
      import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
      GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      setLanguage(document.documentElement.lang);
      window.source = { path: 'notes/current.md', projectRoot: '/project', pane: 'secondary', content: 'Read here.', anchor: 5, head: 9 };
      window.requests = []; window.insertions = []; window.opened = []; window.errors = []; window.focused = [];
      window.pdf = null; window.rejectCreate = false; window.deferCreate = false;
      window.rejectRefresh = false; window.refreshCount = 0;
      window.tools = createDocumentTools({ token: 'test-token',
        getDocument: () => ({ ...window.source }), getProject: () => ({ root: window.source.projectRoot, files: [{ path: 'notes/Taken.md' }] }),
        getPDF: () => window.pdf, onError: error => window.errors.push(error.message),
        api: async (endpoint, options) => {
          window.requests.push({ endpoint, ...options });
          if (window.deferCreate) await new Promise(resolve => window.finishCreate = resolve);
          if (window.rejectCreate) throw new Error('A file already exists at this path.');
          return { path: options.body.path };
        },
        insertText: async (text, snapshot) => {
          if (['path', 'content', 'anchor', 'head', 'pane', 'projectRoot'].some(key => window.source[key] !== snapshot[key])) throw new Error('changed');
          window.insertions.push({ text, snapshot });
          window.source.content = snapshot.content.slice(0, Math.min(snapshot.anchor, snapshot.head)) + text + snapshot.content.slice(Math.max(snapshot.anchor, snapshot.head));
        },
        refreshProject: async () => { window.refreshCount++; if (window.rejectRefresh) throw new Error('Refresh failed.'); },
        openFile: async (path, options) => window.opened.push({ path, ...options }),
        focusDocument: snapshot => window.focused.push(snapshot),
      });
      window.loadPDF = async data => { window.pdf = { path: 'notes/paper.pdf', document: await getDocument({ data: new Uint8Array(data), standardFontDataUrl: '/standard_fonts/' }).promise }; };
      window.pdfText = async data => {
        const pdf = await getDocument({ data: new Uint8Array(data), standardFontDataUrl: '/standard_fonts/' }).promise;
        const pages = [];
        for (let page = 1; page <= pdf.numPages; page++) pages.push((await (await pdf.getPage(page)).getTextContent()).items.map(item => item.str || '').join(' '));
        await pdf.destroy(); return pages;
      };
      document.getElementById('new-page').onclick = () => window.tools.openMarkdownPage();
      document.getElementById('print').onclick = () => window.tools.openMarkdownPDF();
      document.getElementById('text').onclick = () => window.tools.openPDFText();
      window.ready = true;
    `,
  }, bundle: true, format: 'esm', write: false });
  script = built.outputFiles[0].text;
});

async function openTools(page, language = 'en') {
  const assets = new Map([['/tools.js', { contentType: 'text/javascript', body: script }]]);
  for (const name of ['style.css', 'imports.css', 'document-tools.css', 'markdown-preview.css', 'markdown-print.css']) {
    assets.set(`/${name}`, { contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)) });
  }
  assets.set('/', { contentType: 'text/html', headers: { 'Content-Security-Policy': applicationPolicy }, body: `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/document-tools.css"></head><body><button id="new-page">New page</button><button id="print">Print</button><button id="text">Text</button><script type="module" src="/tools.js"></script></body></html>` });
  await page.context().route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/asset') {
      expect(route.request().headers()['x-local-token']).toBe('test-token');
      expect(route.request().headers()['x-project-root']).toBe('%2Fproject');
      expect(url.searchParams.get('path')).toBe('notes/figure.png');
      return route.fulfill({ contentType: 'image/png', body: figure });
    }
    let file;
    if (url.pathname === '/pdf.worker.min.mjs') file = path.join(repository, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
    else if (url.pathname.startsWith('/standard_fonts/')) file = path.join(repository, 'node_modules/pdfjs-dist', url.pathname);
    else if (url.pathname.startsWith('/katex/')) file = path.join(repository, 'node_modules/katex/dist', url.pathname.slice('/katex/'.length));
    if (file) return route.fulfill({ body: await readFile(file), contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.mjs') ? 'text/javascript' : undefined });
    return route.fulfill(assets.get(url.pathname) || { status: 404, body: '' });
  });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
}

function examplePDF() {
  const first = 'BT /F1 18 Tf 30 700 Td (First page) Tj 0 -30 Td (Second line) Tj ET\n';
  const second = 'BT /F1 18 Tf 30 700 Td (Second page) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(second)} >>\nstream\n${second}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('new Markdown pages create a file once and insert an escaped relative link in the original pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await openTools(page);
  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('Taken');
  await expect(page.locator('#markdown-page-path')).toHaveValue('notes/Taken-2.md');
  await page.locator('#markdown-page-title').fill('Next [page] $x$');
  await page.locator('#markdown-page-path').fill('pages/Next #1.md');
  await expect(page.locator('#markdown-page-link')).toHaveValue('[Next \\[page\\] \\$x\\$](../pages/Next%20%231.md)');
  await page.evaluate(() => window.rejectCreate = true);
  await page.locator('#markdown-page-confirm').click();
  await expect(page.locator('#markdown-page-dialog .form-error')).toContainText('already exists');
  await expect(page.locator('#markdown-page-title')).toBeEnabled();
  await expect(page.locator('#markdown-page-path')).toBeEnabled();
  expect(await page.evaluate(() => window.insertions)).toHaveLength(0);
  await page.evaluate(() => window.rejectCreate = false);
  const bounds = await page.locator('#markdown-page-dialog').evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390);
  await expect(page.locator('#markdown-page-confirm')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('new-markdown-page-narrow.png') });
  await page.locator('#markdown-page-confirm').click();
  await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
  const { requests, insertions, opened, errors, source } = await page.evaluate(() => ({ requests: window.requests, insertions: window.insertions, opened: window.opened, errors: window.errors, source: window.source }));
  expect(requests.at(-1)).toMatchObject({ endpoint: '/api/file', method: 'PUT', body: { path: 'pages/Next #1.md', content: '# Next \\[page\\] \\$x\\$\n\n', revision: '' }, projectRoot: '/project' });
  expect(insertions).toHaveLength(1); expect(insertions[0].snapshot.pane).toBe('secondary');
  expect(source.content).toBe('Read [Next \\[page\\] \\$x\\$](../pages/Next%20%231.md).');
  expect(opened).toEqual([{ path: 'pages/Next #1.md', pane: 'secondary' }]); expect(errors).toEqual([]);
});

test('changing the source while a new-page dialog is open leaves the project unchanged', async ({ page }) => {
  await openTools(page, 'ja');
  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('新しいページ');
  await page.evaluate(() => window.source.content = 'changed');
  await page.locator('#markdown-page-confirm').click();
  await expect(page.locator('#markdown-page-dialog .form-error')).toContainText('原稿や選択範囲が変わりました');
  expect(await page.evaluate(() => window.requests)).toHaveLength(0);
});

test('cancelling a new page returns to the source, while creation fixes the submitted title and path', async ({ page }) => {
  await openTools(page);
  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('Cancelled page');
  await page.keyboard.press('Escape');
  await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.requests)).toHaveLength(0);
  expect(await page.evaluate(() => window.source.content)).toBe('Read here.');
  await expect.poll(() => page.evaluate(() => window.focused.length)).toBe(1);
  expect(await page.evaluate(() => window.focused.at(-1))).toMatchObject({ path: 'notes/current.md', pane: 'secondary', anchor: 5, head: 9 });

  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('Waiting page');
  await page.evaluate(() => window.deferCreate = true);
  await page.locator('#markdown-page-confirm').click();
  await page.waitForFunction(() => typeof window.finishCreate === 'function');
  await expect(page.locator('#markdown-page-title')).toBeDisabled();
  await expect(page.locator('#markdown-page-path')).toBeDisabled();
  await expect(page.locator('#markdown-page-dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#markdown-page-dialog')).toBeVisible();
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.requests)).toHaveLength(1);
  expect(await page.evaluate(() => window.insertions)).toHaveLength(1);
  expect(await page.evaluate(() => window.source.content)).toBe('Read [Waiting page](Waiting%20page.md).');
});

test('retrying after a refresh failure updates the file list without creating the page twice', async ({ page }) => {
  await openTools(page);
  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('Created page');
  await page.evaluate(() => window.rejectRefresh = true);
  await page.locator('#markdown-page-confirm').click();
  await expect(page.locator('#markdown-page-dialog .form-error')).toContainText('was created, but the file list could not be refreshed');
  await expect(page.locator('#markdown-page-title')).toBeDisabled();
  await expect(page.locator('#markdown-page-path')).toBeDisabled();
  expect(await page.evaluate(() => window.requests)).toHaveLength(1);
  expect(await page.evaluate(() => window.insertions)).toHaveLength(0);
  await page.evaluate(() => window.rejectRefresh = false);
  await page.locator('#markdown-page-confirm').click();
  await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.refreshCount)).toBe(2);
  expect(await page.evaluate(() => window.requests)).toHaveLength(1);
  expect(await page.evaluate(() => window.insertions)).toHaveLength(1);
  expect(await page.evaluate(() => window.source.content)).toBe('Read [Created page](Created%20page.md).');
});

test('a selection changed during page creation leaves a link to copy and keeps the edited source', async ({ page }) => {
  await openTools(page);
  await page.locator('#new-page').click();
  await page.locator('#markdown-page-title').fill('Saved page');
  await page.evaluate(() => window.deferCreate = true);
  await page.locator('#markdown-page-confirm').click();
  await page.waitForFunction(() => typeof window.finishCreate === 'function');
  await page.evaluate(() => { window.source.anchor = window.source.head = 0; window.finishCreate(); });
  await expect(page.locator('#markdown-page-dialog .form-error')).toContainText('copy the displayed link');
  await expect(page.locator('#markdown-page-link')).toHaveValue('[Saved page](Saved%20page.md)');
  expect(await page.evaluate(() => window.requests)).toHaveLength(1);
  expect(await page.evaluate(() => window.insertions)).toHaveLength(0);
  expect(await page.evaluate(() => window.source.content)).toBe('Read here.');
  await page.locator('#markdown-page-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.source.anchor)).toBe(0);
});

test('PDF.js text downloads as UTF-8 in page order with line breaks', async ({ page }) => {
  await openTools(page);
  await page.evaluate(bytes => window.loadPDF(bytes), [...examplePDF()]);
  await page.locator('#text').click();
  await expect(page.locator('#pdf-text-download')).toBeEnabled();
  await expect(page.locator('#pdf-text-preview')).toHaveValue('First page\nSecond line\n\nSecond page\n');
  const downloaded = page.waitForEvent('download');
  await page.locator('#pdf-text-download').click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('paper.txt');
  expect(await readFile(await file.path(), 'utf8')).toBe('First page\nSecond line\n\nSecond page\n');
});

test('PDF text conversion can be cancelled and reports an image-only PDF', async ({ page }) => {
  await openTools(page);
  await page.evaluate(() => {
    window.pdf = { path: 'scanned.pdf', document: { numPages: 3, async getPage() { return { getTextContent: () => new Promise(resolve => window.finishPage = () => resolve({ items: [{ str: 'Cancelled text' }] })) }; } } };
  });
  await page.locator('#text').click();
  await page.waitForFunction(() => !!window.finishPage);
  await page.locator('#pdf-text-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => window.finishPage());
  await expect(page.locator('#pdf-text-dialog')).not.toBeVisible();
  await page.evaluate(() => window.pdf = { path: 'scanned.pdf', document: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [] }; } }; } } });
  await page.locator('#text').click();
  await expect(page.locator('#pdf-text-dialog [role="status"]')).toContainText('requires OCR');
  await expect(page.locator('#pdf-text-download')).toBeDisabled();
});

test('a replaced PDF cannot download the previous extraction and can be converted again', async ({ page }) => {
  await openTools(page);
  const downloads = []; page.on('download', value => downloads.push(value));
  await page.evaluate(() => window.pdf = { path: 'before.pdf', document: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: 'Previous document' }] }; } }; } } });
  await page.locator('#text').click();
  await expect(page.locator('#pdf-text-download')).toBeEnabled();
  await expect(page.locator('#pdf-text-preview')).toHaveValue('Previous document\n');
  await page.evaluate(() => window.pdf = { path: 'after.pdf', document: { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: 'Updated document' }] }; } }; } } });
  await page.locator('#pdf-text-download').click();
  await expect(page.locator('#pdf-text-dialog .form-error')).toContainText('PDF has changed');
  await expect(page.locator('#pdf-text-preview')).toHaveValue('');
  await expect(page.locator('#pdf-text-download')).toBeDisabled();
  expect(downloads).toHaveLength(0);
  await page.locator('#pdf-text-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#text').click();
  await expect(page.locator('#pdf-text-download')).toBeEnabled();
  await expect(page.locator('#pdf-text-preview')).toHaveValue('Updated document\n');
});

test('Markdown prints unsaved content, math, tables and local images with clean pages', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openTools(page);
  await page.evaluate(() => {
    window.revokedURLs = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.revokedURLs.push(url); revoke(url); };
  });
  const content = '# Unsaved report\n\nEquation: $x^2 + y^2$.\n\n| Method | Result |\n| --- | --- |\n| Test | 42 |\n\n![Local figure](figure.png)\n\n' + `![Embedded figure](data:image/png;base64,${figure.toString('base64')})\n\n` + '<script>window.untrusted = true</script>\n\n' + Array.from({ length: 42 }, (_, index) => `## Section ${index + 1}\n\nBody text for section ${index + 1}. This paragraph belongs to the unsaved draft.\n`).join('\n');
  await page.evaluate(content => window.source.content = content, content);
  await page.locator('#print').click();
  await expect(page.locator('#markdown-print-confirm')).toBeEnabled();
  const frame = page.frameLocator('#markdown-print-preview');
  await expect(frame.locator('h1')).toHaveText('Unsaved report');
  await expect(frame.locator('.katex')).toHaveCount(1);
  await expect(frame.locator('table tbody td').last()).toHaveText('42');
  await expect(frame.locator('img')).toHaveCount(2);
  expect(await frame.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await frame.locator('body').evaluate(() => [...document.fonts].filter(font => font.family.startsWith('KaTeX_') && font.status === 'loaded').length)).toBeGreaterThan(0);
  expect(await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  expect(await page.evaluate(() => window.untrusted)).toBeUndefined();
  await page.locator('#markdown-print-preview').evaluate(frame => { frame.contentWindow.print = () => window.printCalled = frame.contentDocument.title; });
  await page.locator('#markdown-print-name').fill('research-notes.pdf');
  await page.locator('#markdown-print-confirm').click();
  expect(await page.evaluate(() => window.printCalled)).toBe('research-notes');
  await page.screenshot({ path: testInfo.outputPath('markdown-print-preview.png') });
  const html = await page.locator('#markdown-print-preview').evaluate(frame => frame.contentDocument.documentElement.outerHTML);
  const printPage = await page.context().newPage();
  await printPage.route(`${origin}/printed-document`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' + html }));
  await printPage.goto(`${origin}/printed-document`);
  await printPage.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  const pdf = await printPage.pdf({ path: testInfo.outputPath('markdown-export.pdf'), preferCSSPageSize: true, printBackground: true });
  const pages = await page.evaluate(bytes => window.pdfText(bytes), [...pdf]);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages[0]).toContain('Unsaved report'); expect(pages[0]).toContain('Method');
  expect(pages.join('\n')).toContain('Section 42');
  expect(pages.join('\n')).not.toContain('Print / Save as PDF');
  expect(errors).toEqual([]);
  await printPage.close();
  const imageURL = await frame.getByRole('img', { name: 'Local figure', exact: true }).getAttribute('src');
  await page.locator('#markdown-print-dialog .dialog-actions').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('#markdown-print-dialog')).not.toBeVisible();
  await expect(page.locator('#markdown-print-preview')).toHaveAttribute('src', 'about:blank');
  expect(await page.evaluate(() => window.revokedURLs)).toContain(imageURL);
  expect(await page.evaluate(() => window.source.content)).toBe(content);
  await page.locator('#print').click();
  await expect(page.locator('#markdown-print-confirm')).toBeEnabled();
  expect(await frame.getByRole('img', { name: 'Local figure', exact: true }).getAttribute('src')).not.toBe(imageURL);
  await expect(frame.locator('h1')).toHaveText('Unsaved report');
  expect(errors).toEqual([]);
});

test('closing an unfinished Markdown print preview cancels it and allows a fresh preview', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openTools(page);
  await page.evaluate(() => window.source.content = '# Pending print\n\n![Local figure](figure.png)\n');
  let pending, finish;
  const handler = async route => {
    pending = route;
    await new Promise(resolve => { finish = resolve; });
    await route.fulfill({ contentType: 'image/png', body: figure }).catch(() => {});
  };
  await page.route(`${origin}/api/asset?*`, handler);
  try {
    await page.locator('#print').click();
    await expect.poll(() => Boolean(pending)).toBe(true);
    await expect(page.locator('#markdown-print-confirm')).toBeDisabled();
    await page.locator('#markdown-print-dialog .dialog-actions').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('#markdown-print-dialog')).not.toBeVisible();
    await expect(page.locator('#markdown-print-preview')).toHaveAttribute('src', 'about:blank');
    finish();
    await page.unroute(`${origin}/api/asset?*`, handler);
    await page.locator('#print').click();
    await expect(page.locator('#markdown-print-confirm')).toBeEnabled();
    const frame = page.frameLocator('#markdown-print-preview');
    await expect(frame.locator('h1')).toHaveText('Pending print');
    expect(await frame.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.locator('#markdown-print-dialog .form-error')).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    finish?.();
    await page.unroute(`${origin}/api/asset?*`, handler);
  }
});
