import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41538';
const pixelPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAIAAAA7N+mxAAAAF0lEQVR4nGNUbipkIBcwka1zVPOI0QwArkYBKjdurAMAAAAASUVORK5CYII=', 'base64');
let javascript;

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { MarkdownPreview } from './markdown-preview.js';
        window.openedMarkdownFiles = [];
        window.markdownErrors = [];
        window.preview = new MarkdownPreview({
          container: document.getElementById('preview'), token: 'test-markdown-token',
          onOpenFile: (path, options) => window.openedMarkdownFiles.push({ path, ...options }),
          onError: error => window.markdownErrors.push(error.message),
        });`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  javascript = bundled.outputFiles[0].text;
});

async function openPreview(page) {
  const requests = [];
  const contentTypes = { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
  await page.route(`${origin}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ path: url.pathname, query: url.searchParams.get('path'), headers: request.headers() });
    if (url.pathname === '/preview.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (url.pathname === '/api/asset') {
      expect(request.headers()['x-local-token']).toBe('test-markdown-token');
      expect(request.headers()['x-project-root']).toBe(encodeURIComponent('C:\\原稿\\Markdown'));
      expect(url.searchParams.get('path')).toBe('figures/図 1.png');
      return route.fulfill({ contentType: 'image/png', body: pixelPNG });
    }
    if (url.pathname === '/style.css' || url.pathname === '/markdown-preview.css') {
      return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', url.pathname.slice(1))) });
    }
    if (/^\/katex\/(?:katex\.min\.css|fonts\/[\w.-]+\.(?:woff2?|ttf))$/.test(url.pathname)) {
      return route.fulfill({ contentType: contentTypes[path.extname(url.pathname)], body: await readFile(path.join(repository, 'node_modules/katex/dist', url.pathname.slice('/katex/'.length))) });
    }
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/markdown-preview.css"><link rel="stylesheet" href="/katex/katex.min.css">
      <style>body { height: 100vh; display: flex; margin: 0; } #preview { width: 760px; max-width: 100%; margin: 0 auto; }</style>
      </head><body><div id="preview" class="markdown-preview-container" hidden></div><script type="module" src="/preview.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.preview))).toBe(true);
  return requests;
}

async function render(page, content, filename = 'notes/intro.md') {
  await page.evaluate(({ content, filename }) => {
    window.preview.update(content, { path: filename, projectRoot: 'C:\\原稿\\Markdown', immediate: true });
    window.preview.show();
  }, { content, filename });
  await expect(page.getByTestId('markdown-preview')).toHaveAttribute('data-state', 'ready');
}

test('Markdown の本文と数式を表示し，相対画像を認証して読み，リンクから原稿を開く', async ({ page }, testInfo) => {
  const requests = await openPreview(page);
  const content = [
    '# 研究ノート', '', '本文の **強調** と $`f_{\\theta}(x)`$．', '',
    '| 文書 | 状態 |', '| --- | --- |', '| 原稿 | 編集中 |', '',
    '- [x] 実験を確認する', '- [ ] 結果を書く', '',
    '$$', '\\frac{1}{n}\\sum_{i=1}^n x_i', '$$', '',
    '```math', 'A^\\top A', '```', '',
    '```tex', '\\textbf{本文}', '```', '',
    '![実験の図](../figures/図%201.png)', '',
    '[次のノート](detail.markdown#実験の結果)', '', '[参考資料](https://example.org/paper)',
  ].join('\n');
  await render(page, content);
  const body = page.getByTestId('markdown-document');
  await expect(body.getByRole('heading', { name: '研究ノート' })).toBeVisible();
  await expect(body.locator('table td').last()).toHaveText('編集中');
  await expect(body.locator('.katex')).toHaveCount(3);
  await expect(body.locator('.katex-mathml math')).toHaveCount(3);
  await expect(body.locator('input[type="checkbox"]').first()).toBeChecked();
  await expect(body.locator('input[type="checkbox"]').first()).toBeDisabled();
  const image = body.getByRole('img', { name: '実験の図' });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
  expect(requests.filter(item => item.path === '/api/asset')).toHaveLength(1);
  await body.getByRole('link', { name: '次のノート' }).click();
  expect(await page.evaluate(() => window.openedMarkdownFiles)).toEqual([{ path: 'notes/detail.markdown', fragment: '実験の結果' }]);
  await expect(body.getByRole('link', { name: '参考資料' })).toHaveAttribute('rel', 'noopener noreferrer');
  await page.screenshot({ path: testInfo.outputPath('markdown-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: testInfo.outputPath('markdown-dark.png') });
  expect(await page.evaluate(() => window.markdownErrors)).toEqual([]);
});

test('Markdown の再描画では画像と位置を使い続け，HTML やプロジェクト外へのリンクを実行しない', async ({ page }) => {
  const requests = await openPreview(page);
  const content = [
    '# 原稿', '', '![図](../figures/図%201.png)', '',
    '<script>window.attack = true</script>', '', '<img src="x" onerror="window.attack = true">', '',
    '[危険なリンク](javascript:alert(1))', '', '[外のファイル](../../secret.md)', '',
    '![外部の画像](https://example.org/figure.png)', '',
    ...Array.from({ length: 50 }, (_, index) => `段落 ${index} の本文．\n`),
  ].join('\n');
  await render(page, content);
  const container = page.getByTestId('markdown-preview');
  const body = page.getByTestId('markdown-document');
  await expect(body.getByRole('img', { name: '図', exact: true })).toHaveAttribute('src', /^blob:/);
  await expect(body.locator('script, iframe, object, embed')).toHaveCount(0);
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(body.getByText('外のファイル', { exact: true })).not.toHaveAttribute('href');
  await expect(body.getByRole('link', { name: '外部の画像' })).toHaveAttribute('href', 'https://example.org/figure.png');
  expect(await page.evaluate(() => window.attack)).toBeUndefined();
  expect(requests.filter(item => item.path === '/api/asset')).toHaveLength(1);
  await container.evaluate(element => { element.scrollTop = 500; });
  const top = await container.evaluate(element => element.scrollTop);
  await page.evaluate(content => {
    window.preview.update(content + '\n最後の追記．', { path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown' });
    window.preview.show();
    window.preview.show();
  }, content);
  await expect(container).toHaveAttribute('data-state', 'ready');
  await expect(body).toContainText('最後の追記．');
  expect(await container.evaluate(element => element.scrollTop)).toBe(top);
  expect(requests.filter(item => item.path === '/api/asset')).toHaveLength(1);
  await page.evaluate(() => { window.preview.hide(); window.preview.hide(); window.preview.show(); });
  await expect(container).toBeVisible();
  expect(await container.evaluate(element => element.scrollTop)).toBe(top);
  await render(page, '# 別の Markdown', 'notes/detail.markdown');
  await expect(body.getByRole('heading', { name: '別の Markdown' })).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.markdownErrors)).toEqual([]);
});
