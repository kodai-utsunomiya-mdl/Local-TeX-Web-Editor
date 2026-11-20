import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41549';
let javascript;

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { MarkdownPreview } from './markdown-preview.js';
        import { MarkdownRichEditor } from './markdown-rich-editor.js';
        import { prepareMarkdownPrint } from './markdown-print.js';
        import { setLanguage } from './i18n.js';
        setLanguage('ja');
        window.formattingErrors = []; window.formattingChanges = [];
        const options = { path: 'notes.md', projectRoot: '/project', immediate: true };
        const preview = new MarkdownPreview({ container: document.getElementById('preview-host'), token: 'formatting-test',
          onError: error => formattingErrors.push(error.message) });
        window.openFormatting = text => {
          window.formattingEditor?.destroy(); formattingChanges.length = 0;
          window.formattingEditor = new MarkdownRichEditor({ host: document.getElementById('rich-host'), text, ...options,
            onChange: change => { formattingChanges.push(change); preview.update(change.text, options); },
            onError: error => formattingErrors.push(error.message) });
          preview.update(text, options); preview.show();
        };
        window.openFormattingPrint = async () => {
          const frame = document.getElementById('print-frame');
          await prepareMarkdownPrint(frame, { content: formattingEditor.text, ...options },
            { token: 'formatting-test', signal: new AbortController().signal, urls: new Set() });
          document.getElementById('formatting-fixture').hidden = true; frame.hidden = false;
        };
        window.formattingReady = true;`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  javascript = bundled.outputFiles[0].text;
});

async function openFormatting(page, text) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/formatting.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/style.css', '/markdown-preview.css', '/markdown-rich-editor.css', '/markdown-print.css'].includes(url.pathname)) {
      return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', url.pathname.slice(1))) });
    }
    if (/^\/katex\/(?:katex\.min\.css|fonts\/[\w.-]+\.(?:woff2?|ttf))$/.test(url.pathname)) {
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2', body: await readFile(path.join(repository, 'node_modules/katex/dist', url.pathname.slice('/katex/'.length))) });
    }
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/markdown-preview.css">
      <link rel="stylesheet" href="/markdown-rich-editor.css"><link rel="stylesheet" href="/katex/katex.min.css">
      <style>
        #formatting-fixture { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; height: 100%; }
        #formatting-fixture section { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); }
        #formatting-fixture section > h1 { flex: 0 0 auto; font-size: 13px; padding: 12px 18px; border-bottom: 1px solid var(--border); }
        #print-frame { display: block; width: 100%; height: 100%; border: 0; }
      </style></head><body>
      <main id="formatting-fixture"><section><h1>直接編集</h1><div id="rich-host"></div></section>
      <section><h1>プレビュー</h1><div id="preview-host"></div></section></main>
      <iframe id="print-frame" title="印刷する Markdown" hidden></iframe>
      <script type="module" src="/formatting.js"></script></body></html>` });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.formattingReady);
  await page.evaluate(text => openFormatting(text), text);
  await expect(page.locator('#preview-host')).toHaveAttribute('data-state', 'ready');
}

async function checkStyles(article) {
  for (const emphasis of await article.locator('em').all()) {
    await expect(emphasis).toHaveCSS('font-style', 'italic');
    await expect(emphasis).toHaveCSS('font-synthesis-style', 'auto');
  }
  for (const strike of await article.locator('s').all()) await expect(strike).toHaveCSS('text-decoration-line', 'line-through');
  for (const strong of await article.locator('strong').all()) {
    expect(Number(await strong.evaluate(node => getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
  }
}

test('日本語の斜体と取り消し線を直接編集とプレビューで描き，複数の装飾とコードにも反映する', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const original = [
    '# 日本語の書式', '',
    '前*斜体*後', '',
    '前~~取り消し線~~後', '',
    '前*「括弧のある斜体」*後', '',
    '前~~「括弧のある取り消し線」~~後', '',
    '前***~~太字・斜体・取り消し線~~***後', '',
    '前~~***内側の強調***~~後', '',
    '前***~~`装飾したコード`~~***後', '',
    '末尾の句読点*斜体。*次の文', '',
  ].join('\n');
  await openFormatting(page, original);
  for (const article of [page.locator('.markdown-rich-document'), page.locator('#preview-host .markdown-body')]) {
    await expect(article.locator('em')).toHaveCount(6);
    await expect(article.locator('s')).toHaveCount(5);
    const combined = article.locator('p').filter({ hasText: '太字・斜体・取り消し線' });
    await expect(combined).toHaveText('前太字・斜体・取り消し線後');
    for (const tag of ['em', 'strong', 's']) await expect(combined.locator(tag)).toHaveText('太字・斜体・取り消し線');
    const code = article.locator('code');
    await expect(code).toHaveText('装飾したコード');
    await expect(code).toHaveCSS('font-style', 'italic');
    expect(Number(await code.evaluate(node => getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
    await checkStyles(article);
    expect(await article.locator('p').evaluateAll(nodes => nodes.some(node => /\*|~~/.test(node.textContent)))).toBe(false);
  }
  expect(await page.evaluate(() => formattingEditor.text)).toBe(original);
  expect(await page.evaluate(() => formattingChanges.length)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('markdown-japanese-formatting.png') });
  expect(await page.evaluate(() => formattingErrors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('日本語に接して入力した複数の装飾が原稿とプレビューへ反映され，印刷にも同じ書式を使う', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFormatting(page, '前後\n');
  await page.evaluate(() => { formattingEditor.selectSource(1); formattingEditor.focus(); });
  await page.keyboard.type('***~~「本文。」~~***');
  const rich = page.locator('.markdown-rich-document');
  const preview = page.locator('#preview-host .markdown-body');
  for (const article of [rich, preview]) {
    await expect(article.locator('p')).toHaveText('前「本文。」後');
    for (const tag of ['em', 'strong', 's']) await expect(article.locator(tag)).toHaveText('「本文。」');
    await checkStyles(article);
  }
  expect(await page.evaluate(() => formattingEditor.text)).toBe('前***~~「本文。」~~***後\n');
  await page.evaluate(() => openFormattingPrint());
  const printed = page.frameLocator('#print-frame').locator('.markdown-body');
  await expect(printed.locator('p')).toHaveText('前「本文。」後');
  for (const tag of ['em', 'strong', 's']) await expect(printed.locator(tag)).toHaveText('「本文。」');
  await checkStyles(printed);
  await page.emulateMedia({ media: 'print' });
  await checkStyles(printed);
  await page.screenshot({ path: testInfo.outputPath('markdown-japanese-formatting-print.png') });
  expect(await page.evaluate(() => formattingErrors)).toEqual([]);
  expect(errors).toEqual([]);
});
