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
        import { setLanguage } from './i18n.js';
        setLanguage('ja');
        window.openedMarkdownFiles = [];
        window.markdownErrors = [];
        window.markdownSourceLines = [];
        window.preview = new MarkdownPreview({
          container: document.getElementById('preview'), token: 'test-markdown-token',
          onOpenFile: (path, options) => window.openedMarkdownFiles.push({ path, ...options }),
          onSourceLine: (line, path) => window.markdownSourceLines.push({ line, path }),
          onError: error => window.markdownErrors.push(error.message),
        });`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  javascript = bundled.outputFiles[0].text;
});

async function openPreview(page, { asset = pixelPNG } = {}) {
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
      return route.fulfill({ contentType: 'image/png', body: asset });
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

test('Markdown に戻った時に，画像の取得で本文とスクロール位置が動かない', async ({ page }, testInfo) => {
  const onePixelPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64');
  await openPreview(page, { asset: onePixelPNG });
  await render(page, ['# 原稿', '', '![図](../figures/図%201.png)', '',
    ...Array.from({ length: 50 }, (_, index) => `段落 ${index} の本文．\n`)].join('\n'));
  const container = page.getByTestId('markdown-preview');
  const image = page.getByRole('img', { name: '図', exact: true });
  await expect(image).toHaveAttribute('data-state', 'ready');
  await container.evaluate(element => { element.scrollTop = 600; });

  const measure = () => container.evaluate(element => {
    const image = element.querySelector('img'), paragraph = image.closest('p');
    const rect = image.getBoundingClientRect(), line = paragraph.getBoundingClientRect();
    return { scrollTop: element.scrollTop, width: rect.width, height: rect.height,
      paragraphHeight: line.height, paragraphTop: line.top };
  });
  const initial = await measure();
  let releaseAsset;
  const pendingAsset = new Promise(resolve => { releaseAsset = resolve; });
  let requested = false;
  await page.route(`${origin}/api/asset?*`, async route => {
    requested = true;
    await pendingAsset;
    await route.fulfill({ contentType: 'image/png', body: onePixelPNG });
  });
  try {
    await page.evaluate(() => { window.preview.hide(); window.preview.show(); });
    await expect.poll(() => requested).toBe(true);
    const loading = await measure();
    releaseAsset();
    await expect(image).toHaveAttribute('data-state', 'ready');
    await container.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const loaded = await measure();
    await testInfo.attach('markdown-image-layout.json', { body: JSON.stringify({ initial, loading, loaded }, null, 2), contentType: 'application/json' });
    expect(initial.scrollTop).toBe(600);
    expect(loading).toEqual(initial);
    expect(loaded).toEqual(initial);
  } finally { releaseAsset(); }
});

test('原稿の行から本文，コード，項目，表，数式へ移動し，プレビューから原稿へ戻る', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  await openPreview(page);
  const lines = ['# 長い文書', '', ...Array.from({ length: 20 }, (_, index) => `前の段落 ${index}．\n`)];
  // Each source line remains separate so the expected locations come from the document.
  const source = lines.join('\n').split('\n');
  const targets = [];
  const add = (content, lineOffset, selector, text) => {
    targets.push({ line: source.length + 1 + lineOffset, start: source.length + 1, selector, text });
    source.push(...content, '');
  };
  add(['本文の最初の行．', '本文の二行目．', '本文の最後の行．'], 1, 'p', '本文の最初の行．');
  add(['```tex', '\\section{確認}', '\\textbf{コードの内容}', '```'], 2, 'pre', 'コードの内容');
  add(['- 親の項目', '  - 子の項目', '- 次の項目'], 1, 'li', '子の項目');
  add(['| 名前 | 値 |', '| --- | --- |', '| 表の行 | 3 |'], 2, 'tr', '表の行');
  add(['$$', 'a^2+b^2=c^2', '$$'], 1, '.markdown-equation', '');
  source.push(...Array.from({ length: 30 }, (_, index) => `後の段落 ${index}．\n`));
  await render(page, source.join('\n'));
  const container = page.getByTestId('markdown-preview');

  for (const target of targets) {
    expect(await page.evaluate(line => window.preview.revealSourceLine(line, {
      path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown',
    }), target.line)).toBe(true);
    const marked = container.locator(`${target.selector}.markdown-source-highlight`);
    await expect(marked).toHaveCount(1);
    if (target.text) await expect(marked).toContainText(target.text);
    const position = await marked.evaluate(element => {
      const box = element.getBoundingClientRect();
      const viewport = element.closest('.markdown-preview').getBoundingClientRect();
      return { top: box.top - viewport.top, bottom: box.bottom - viewport.top, height: viewport.height };
    });
    expect(position.top).toBeLessThan(position.height);
    expect(position.bottom).toBeGreaterThan(0);
  }

  await container.locator('.markdown-equation').dblclick();
  expect(await page.evaluate(() => window.markdownSourceLines)).toEqual([
    { line: targets.at(-1).start, path: 'notes/intro.md' },
  ]);
  const top = await container.evaluate(element => element.scrollTop);
  expect(await page.evaluate(() => window.preview.revealSourceLine(1, { path: 'notes/other.md' }))).toBe(false);
  expect(await page.evaluate(() => window.preview.revealSourceLine(1, { projectRoot: 'C:\\別のプロジェクト' }))).toBe(false);
  expect(await container.evaluate(element => element.scrollTop)).toBe(top);
  await page.evaluate(() => window.preview.hide());
  expect(await page.evaluate(() => window.preview.revealSourceLine(1))).toBe(false);
  expect(await page.evaluate(() => window.markdownErrors)).toEqual([]);
});

test('原稿の行内の位置に追従し，同期の解除やプレビューでのスクロールを尊重する', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await openPreview(page);
  const lines = ['# 原稿', '', ...Array.from({ length: 20 }, (_, index) => `前の段落 ${index}．\n`)].join('\n').split('\n');
  const paragraphLine = lines.length + 1;
  lines.push('一つの長い段落を，画面内で複数行に折り返して表示する．'.repeat(70), '',
    ...Array.from({ length: 40 }, (_, index) => `後の段落 ${index}．\n`));
  const content = lines.join('\n');
  await render(page, content);
  const container = page.getByTestId('markdown-preview');
  const paragraph = container.locator(`p[data-source-line="${paragraphLine}"]`);

  await page.evaluate(() => window.preview.setScrollSync(false));
  expect(await page.evaluate(line => window.preview.syncSourceLine(line), paragraphLine)).toBe(false);
  expect(await container.evaluate(element => element.scrollTop)).toBe(0);
  await page.evaluate(() => window.preview.setScrollSync(true));
  const positions = [];
  for (const fraction of [0, 0.25, 0.5, 0.75]) {
    expect(await page.evaluate(line => window.preview.syncSourceLine(line, {
      path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown',
    }), paragraphLine + fraction)).toBe(true);
    positions.push(await container.evaluate(element => element.scrollTop));
  }
  const height = await paragraph.evaluate(element => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(500);
  for (let index = 1; index < positions.length; ++index) {
    expect(Math.abs(positions[index] - positions[index - 1] - height / 4)).toBeLessThan(2);
  }

  const pendingText = '入力中の末尾．';
  const deferred = await page.evaluate(({ content, line, pendingText }) => {
    window.preview.update(content + '\n' + pendingText, { path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown' });
    const accepted = window.preview.syncSourceLine(line + 0.5);
    return { accepted, state: document.getElementById('preview').dataset.state,
      hasNewText: document.getElementById('preview').textContent.includes(pendingText) };
  }, { content, line: paragraphLine, pendingText });
  expect(deferred).toEqual({ accepted: true, state: 'updating', hasNewText: false });
  await expect(container).toContainText(pendingText);
  await expect(container).toHaveAttribute('data-state', 'ready');

  // An explicit navigation uses the edited document even while its render is pending.
  await page.evaluate(({ content, line }) => {
    window.preview.update(content.replace('一つの長い段落', '編集された長い段落'), {
      path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown',
    });
    window.preview.revealSourceLine(line);
  }, { content, line: paragraphLine });
  await expect(paragraph).toContainText('編集された長い段落');
  await expect(paragraph).toHaveClass(/markdown-source-highlight/);

  await page.evaluate(line => window.preview.syncSourceLine(line + 0.5), paragraphLine);
  await container.hover();
  const following = await container.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, 180);
  await expect.poll(() => container.evaluate(element => element.scrollTop)).toBeGreaterThan(following + 100);
  const manuallyScrolled = await container.evaluate(element => element.scrollTop);
  expect(await page.evaluate(line => window.preview.syncSourceLine(line + 0.5), paragraphLine)).toBe(false);
  expect(await container.evaluate(element => element.scrollTop)).toBe(manuallyScrolled);
  await page.evaluate(content => window.preview.update(content.replace('一つの長い段落', '編集された長い段落') + '\n手動スクロール後の追記．', {
    path: 'notes/intro.md', projectRoot: 'C:\\原稿\\Markdown', immediate: true,
  }), content);
  await expect(container).toContainText('手動スクロール後の追記．');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const afterRender = await container.evaluate(element => element.scrollTop);
  expect(Math.abs(afterRender - manuallyScrolled)).toBeLessThan(2);

  await page.evaluate(() => window.preview.setScrollSync(false));
  expect(await page.evaluate(() => window.preview.syncSourceLine(1))).toBe(false);
  expect(await container.evaluate(element => element.scrollTop)).toBe(afterRender);
  await page.evaluate(() => window.preview.setScrollSync(true));
  expect(await page.evaluate(() => window.preview.syncSourceLine(1, { path: 'notes/different.md' }))).toBe(false);
  expect(await container.evaluate(element => element.scrollTop)).toBe(afterRender);
  expect(await page.evaluate(() => window.markdownErrors)).toEqual([]);
});

test('画像が読み込まれた後も，同期中の原稿に対応する本文を上端に合わせる', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 500 });
  await openPreview(page);
  const imageData = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 360;
    canvas.getContext('2d').fillRect(0, 0, 320, 360);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  let releaseAsset;
  const pending = new Promise(resolve => { releaseAsset = resolve; });
  let requested = false;
  await page.route(`${origin}/api/asset?*`, async route => {
    requested = true;
    await pending;
    await route.fulfill({ contentType: 'image/png', body: Buffer.from(imageData, 'base64') });
  });
  const lines = ['# 原稿', '', '![図](../figures/図%201.png)', '',
    ...Array.from({ length: 50 }, (_, index) => `段落 ${index} の本文．\n`)].join('\n').split('\n');
  const targetLine = lines.indexOf('段落 8 の本文．') + 1;
  try {
    await render(page, lines.join('\n'));
    await expect.poll(() => requested).toBe(true);
    await page.evaluate(line => window.preview.syncSourceLine(line), targetLine);
    const target = page.getByText('段落 8 の本文．', { exact: true });
    const topOffset = () => target.evaluate(element => {
      const container = element.closest('.markdown-preview');
      return element.getBoundingClientRect().top - container.getBoundingClientRect().top
        - parseFloat(getComputedStyle(container).paddingTop);
    });
    expect(Math.abs(await topOffset())).toBeLessThan(2);
    releaseAsset();
    await expect(page.getByRole('img', { name: '図', exact: true })).toHaveAttribute('data-state', 'ready');
    await expect.poll(async () => Math.abs(await topOffset())).toBeLessThan(2);
    expect(await page.evaluate(() => window.markdownErrors)).toEqual([]);
  } finally { releaseAsset(); }
});
