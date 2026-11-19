import { test, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
let script;

test.beforeAll(async () => {
  const built = await bundle({
    stdin: {
      resolveDir: path.join(repository, 'web/src'),
      contents: `import { createInsertTools } from './insert-tools.js';
        import { createMarkdownEditing } from './markdown-editing.js';
        import { setLanguage } from './i18n.js';
        setLanguage(document.documentElement.lang);
        window.writingDocument = { path: 'notes/chapter.md', projectRoot: '/writing-project', pane: 'secondary', content: '', anchor: 0, head: 0 };
        window.writingRequests = []; window.writingInsertions = []; window.writingEdits = []; window.writingErrors = [];
        const getDocument = () => ({ ...window.writingDocument });
        function render() { document.getElementById('rendered-source').textContent = window.writingDocument.content; }
        const onError = error => window.writingErrors.push(error.message);
        const tools = createInsertTools({
          getDocument, getProject: () => ({ root: window.writingDocument.projectRoot }), onError,
          api: async (endpoint, options) => {
            window.writingRequests.push({ endpoint, ...options });
            return { path: options.body.path.replace(/\\.(png|jpg|jpeg|pdf)$/i, '-2.$1') };
          },
          insertText: async (text, snapshot) => {
            window.writingInsertions.push({ text, snapshot });
            const from = Math.min(snapshot.anchor, snapshot.head), to = Math.max(snapshot.anchor, snapshot.head);
            window.writingDocument.content = window.writingDocument.content.slice(0, from) + text + window.writingDocument.content.slice(to);
            render();
          }
        });
        const editing = createMarkdownEditing({
          container: document.getElementById('markdown-tools'), getDocument, onError,
          onTable: () => tools.openTable(),
          applyEdit: async (edit, snapshot) => {
            window.writingEdits.push({ edit, snapshot });
            for (const change of [...edit.changes].sort((a, b) => b.from - a.from)) {
              const text = window.writingDocument.content;
              window.writingDocument.content = text.slice(0, change.from) + change.insert + text.slice(change.to);
            }
            Object.assign(window.writingDocument, edit.selection); render(); editing.update();
          }
        });
        window.setWritingDocument = values => { Object.assign(window.writingDocument, values); render(); editing.update(); };
        window.writingTools = tools;
        document.getElementById('clipboard-target').addEventListener('paste', tools.handlePaste);
        document.getElementById('clipboard-target').addEventListener('drop', tools.handleDrop);
        render(); window.writingReady = true;`,
    },
    bundle: true, format: 'esm', write: false,
  });
  script = built.outputFiles[0].text;
});

async function openTools(page, language = 'ja') {
  const assets = new Map([
    ['/tools.js', { contentType: 'text/javascript', body: script }],
  ]);
  for (const name of ['style.css', 'imports.css', 'markdown-editing.css']) {
    assets.set(`/${name}`, { contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', name)) });
  }
  assets.set('/', { contentType: 'text/html', body: `<!doctype html><html lang="${language}" data-palette="gray"><head><meta charset="utf-8">
    <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/markdown-editing.css">
    <style>#fixture { width: min(800px, 100%); } #rendered-source { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; } #clipboard-target { width: 100%; }</style>
    </head><body><main id="fixture"><div id="markdown-tools"></div><pre id="rendered-source"></pre><textarea id="clipboard-target" aria-label="Clipboard target"></textarea></main>
    <script type="module" src="/tools.js"></script></body></html>` });
  const origin = 'http://127.0.0.1:41539';
  await page.route(`${origin}/**`, async route => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    await route.fulfill(asset || { status: 404, body: '' });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.writingReady);
}

test('Markdown のリンクは表示文字と URL を入力でき，編集中の位置が変わると再確認を求める', async ({ page }) => {
  await openTools(page, 'en');
  await page.evaluate(() => window.setWritingDocument({ content: 'Read paper here.', anchor: 5, head: 10 }));
  const openLink = page.locator('#markdown-tools').getByRole('button', { name: 'Insert a link', exact: true });
  await openLink.click();
  await expect(page.locator('#markdown-link-label')).toHaveValue('paper');
  await page.locator('#markdown-link-label').fill('Paper [draft]');
  await page.locator('#markdown-link-url').fill('https://example.com/paper (1).pdf');
  await expect(page.locator('#markdown-link-source')).toHaveValue('[Paper \\[draft\\]](https://example.com/paper%20%281%29.pdf)');
  await page.evaluate(() => window.setWritingDocument({ pane: 'primary' }));
  await page.locator('#markdown-link-confirm').click();
  await expect(page.locator('#markdown-link-dialog .form-error')).toContainText('selection changed');
  expect(await page.evaluate(() => window.writingEdits.length)).toBe(0);
  await page.locator('#markdown-link-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await openLink.click();
  await page.locator('#markdown-link-label').fill('Paper [draft]');
  await page.locator('#markdown-link-url').fill('../paper (1).pdf');
  await page.locator('#markdown-link-confirm').click();
  await expect(page.locator('#markdown-link-dialog')).not.toBeVisible();
  await expect(page.locator('#rendered-source')).toHaveText('Read [Paper \\[draft\\]](../paper%20%281%29.pdf) here.');
  const edits = await page.evaluate(() => window.writingEdits);
  expect(edits).toHaveLength(1);
  expect(edits[0].snapshot.pane).toBe('primary');
  expect(await page.evaluate(() => window.writingErrors)).toEqual([]);
});

test('狭い幅でも Markdown の各操作を選べて，コードブロック内の backtick をそのまま使える', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTools(page);
  const bounds = await page.locator('#markdown-tools button, #markdown-tools select').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
  }));
  expect(bounds.length).toBe(12);
  for (const bound of bounds) {
    expect(bound.left).toBeGreaterThanOrEqual(0);
    expect(bound.right).toBeLessThanOrEqual(390);
    expect(bound.width).toBeGreaterThanOrEqual(30);
    expect(bound.height).toBeGreaterThanOrEqual(30);
  }
  await page.evaluate(() => window.setWritingDocument({ content: 'before\n\nsource\n\nafter', anchor: 8, head: 14 }));
  await page.locator('#markdown-tools').getByRole('button', { name: 'コードブロック', exact: true }).click();
  await expect(page.locator('#markdown-code-input')).toHaveValue('source');
  await page.locator('#markdown-code-language').fill('markdown');
  await page.locator('#markdown-code-input').fill('```tex\nx\n```');
  await page.screenshot({ path: testInfo.outputPath('markdown-code-dialog-narrow.png') });
  await page.locator('#markdown-code-confirm').click();
  await expect(page.locator('#rendered-source')).toHaveText('before\n\n````markdown\n```tex\nx\n```\n````\n\nafter');
  await page.evaluate(() => window.setWritingDocument({ path: 'main.tex' }));
  await expect(page.locator('#markdown-tools')).not.toBeVisible();
  expect(await page.evaluate(() => window.writingErrors)).toEqual([]);
});

test('表の行数と列数を指定し，見本のセルを編集して Markdown に挿入する', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTools(page);
  await page.evaluate(() => window.setWritingDocument({ content: '# Notes\n\n', anchor: 9, head: 9 }));
  await page.locator('#markdown-tools').getByRole('button', { name: '表を挿入', exact: true }).click();
  await page.locator('#insert-table-rows').fill('3');
  await page.locator('#insert-table-columns').fill('4');
  await page.locator('#insert-table-new').click();
  await expect(page.locator('#insert-table-preview textarea')).toHaveCount(12);
  await page.getByRole('textbox', { name: '1 行 1 列', exact: true }).fill('Name');
  await page.getByRole('textbox', { name: '2 行 1 列', exact: true }).fill('a|b');
  await page.getByRole('textbox', { name: '3 行 1 列', exact: true }).fill('first\nsecond');
  await expect(page.locator('#insert-table-source')).toHaveValue(/\| a\\\|b \|/);
  await expect(page.locator('#insert-table-source')).toHaveValue(/\| first second \|/);
  const dialog = await page.locator('#insert-table-dialog').evaluate(node => {
    const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: node.clientWidth, scrollWidth: node.scrollWidth };
  });
  expect(dialog.left).toBeGreaterThanOrEqual(0); expect(dialog.right).toBeLessThanOrEqual(390);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.width + 1);
  await page.screenshot({ path: testInfo.outputPath('editable-table-narrow.png') });
  await page.locator('#insert-table-confirm').click();
  await expect(page.locator('#insert-table-dialog')).not.toBeVisible();
  await expect(page.locator('#rendered-source')).toContainText('| a\\|b |');
  const insertions = await page.evaluate(() => window.writingInsertions);
  expect(insertions).toHaveLength(1);
  expect(insertions[0].snapshot).toEqual({ path: 'notes/chapter.md', projectRoot: '/writing-project', pane: 'secondary', anchor: 9, head: 9 });
});

test('画像をドロップすると取り込み前に内容を確認でき，採番されたパスを元のペインへ挿入する', async ({ page }) => {
  await openTools(page);
  await page.evaluate(() => window.setWritingDocument({ content: 'Text\n', anchor: 5, head: 5 }));
  const prevented = await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'diagram.png', { type: 'image/png' }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.getElementById('clipboard-target').dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.locator('#insert-image-dialog')).toBeVisible();
  await expect(page.locator('#insert-image-path')).toHaveValue('figures/diagram.png');
  await expect(page.locator('.import-image-preview img')).toBeVisible();
  await page.locator('#insert-image-caption').fill('An example');
  await page.locator('#insert-image-confirm').click();
  await expect(page.locator('#insert-image-dialog')).not.toBeVisible();
  await expect(page.locator('#rendered-source')).toHaveText('Text\n![An example](../figures/diagram-2.png)\n');
  const { requests, insertions, errors } = await page.evaluate(() => ({ requests: window.writingRequests, insertions: window.writingInsertions, errors: window.writingErrors }));
  expect(requests).toHaveLength(1);
  expect(requests[0].endpoint).toBe('/api/assets/import');
  expect(requests[0].projectRoot).toBe('/writing-project');
  expect(insertions[0].snapshot.pane).toBe('secondary');
  expect(insertions[0].snapshot.anchor).toBe(5);
  expect(errors).toEqual([]);
});
