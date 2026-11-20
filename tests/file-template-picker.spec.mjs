import { test as base, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41549';
const templates = [
  { id: 'builtin-article', name: '英語の文書', description: 'pdfLaTeX を使う文書です．', builtin: true, main: 'main.tex', fileCount: 1 },
  { id: 'builtin-markdown', name: 'Markdown のメモ', description: 'メモを書き始めます．', builtin: true, main: '', fileCount: 1 },
  { id: 'custom', name: '私のテンプレート', description: '原稿とメモと画像を登録しています．', builtin: false, main: 'sections/main.tex', fileCount: 3 },
  { id: 'pictures', name: '画像のテンプレート', description: '画像を登録しています．', builtin: false, main: '', fileCount: 1 },
];
const contents = {
  'builtin-article': { 'main.tex': '\\documentclass{article}\n\\begin{document}\nTemplate article\n\\end{document}\n' },
  'builtin-markdown': { 'notes.md': '# Notes\n\nWrite here.\n' },
  custom: { 'sections/main.tex': '\\section{登録した原稿}\n', 'notes/日本語.md': '# 登録したメモ\n\n<img src="outside.png" onerror="window.injected=true">\n' },
  pictures: {},
};
let javascript, dialogHTML;
const test = base.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});

test.beforeAll(async () => {
  const html = await readFile(path.join(repository, 'web/src/index.html'), 'utf8');
  dialogHTML = html.match(/<dialog id="new-file-dialog"[\s\S]*?<\/dialog>/)[0];
  const bundle = await build({ stdin: {
    resolveDir: path.join(repository, 'web/src'),
    contents: `import { createFileTemplatePicker } from './file-template-picker.js';
      import { setLanguage } from './i18n.js';
      setLanguage('ja');
      window.templateFixtures = ${JSON.stringify(templates)};
      window.templateContents = ${JSON.stringify(contents)};
      window.createdFiles = []; window.templateRequests = []; window.pickerStates = [];
      window.deferredTemplateRequests = new Set(); window.failTemplateRequest = '';
      const pending = [];
      const dialog = document.getElementById('new-file-dialog'), input = document.getElementById('new-file-path');
      const resultFor = (id, selectedPath, hasPath) => {
        const item = templateFixtures.find(item => item.id === id), files = templateContents[id] || {};
        if (hasPath) return { id, path: selectedPath, name: selectedPath.split('/').at(-1), content: files[selectedPath], lineEnding: 'lf' };
        return { template: item, files: Object.keys(files).map(path => ({ path, name: path.split('/').at(-1), bytes: files[path].length })) };
      };
      window.pendingTemplateKeys = () => pending.map(item => item.key);
      window.releaseTemplateRequest = key => {
        const index = pending.findIndex(item => item.key === key);
        if (index < 0) throw new Error('No pending request: ' + key);
        pending.splice(index, 1)[0].resolve(); deferredTemplateRequests.delete(key);
      };
      window.templatePicker = createFileTemplatePicker({
        host: document.getElementById('new-file-template-picker'), pathInput: input,
        api: async (endpoint, options = {}) => {
          const url = new URL(endpoint, location.origin), id = url.searchParams.get('id'), selectedPath = url.searchParams.get('path');
          const key = url.pathname === '/api/templates' ? 'catalog' : id + (url.searchParams.has('path') ? '|' + selectedPath : '');
          templateRequests.push({ key, projectRoot: options.projectRoot });
          if (failTemplateRequest === key) { failTemplateRequest = ''; throw new Error('読込みに失敗しました．'); }
          if (deferredTemplateRequests.has(key)) await new Promise(resolve => pending.push({ key, resolve }));
          return key === 'catalog' ? { templates: templateFixtures } : resultFor(id, selectedPath, url.searchParams.has('path'));
        },
        onChange: state => { pickerStates.push(state); document.getElementById('create-file').disabled = !state.ready; },
      });
      window.openFileTemplate = ({ folder = '', name = null } = {}) => {
        if (dialog.open) dialog.close();
        input.value = name ?? (folder ? folder + '/' : '');
        templatePicker.reset({ folder }); dialog.showModal(); input.focus();
      };
      for (const button of dialog.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => dialog.close());
      document.getElementById('new-file-form').addEventListener('submit', event => {
        event.preventDefault();
        const value = templatePicker.getValue(); templatePicker.setBusy(true);
        createdFiles.push({ ...value, path: input.value }); dialog.close(); templatePicker.setBusy(false);
      });`,
  }, bundle: true, format: 'esm', write: false });
  javascript = bundle.outputFiles[0].text;
});

async function openPicker(page, options = {}) {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/picker.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/style.css', '/file-template-picker.css'].includes(pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', pathname.slice(1))) });
    if (pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/file-template-picker.css"></head><body>${dialogHTML}<script type="module" src="/picker.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => typeof window.templatePicker?.getValue)).toBe('function');
  await page.evaluate(options => openFileTemplate(options), options);
  await expect(page.locator('#new-file-dialog')).toBeVisible();
  await expect(page.locator('#new-file-template')).toBeEnabled();
}

test('空のファイルを初期値とし，標準テンプレートを指定フォルダーへ作成する', async ({ page }) => {
  await openPicker(page, { folder: 'sections' });
  await expect(page.locator('#new-file-template')).toHaveValue('');
  await expect(page.locator('#new-file-path')).toHaveValue('sections/');
  expect(await page.evaluate(() => templatePicker.getValue().content)).toBe('');
  await page.locator('#new-file-template').selectOption('builtin-article');
  await expect(page.locator('#new-file-template-preview')).toContainText('Template article');
  await expect(page.locator('#new-file-path')).toHaveValue('sections/main.tex');
  await page.locator('#create-file').click();
  expect(await page.evaluate(() => createdFiles.map(file => ({ path: file.path, content: file.content })))).toEqual([{ path: 'sections/main.tex', content: contents['builtin-article']['main.tex'] }]);
  expect(await page.evaluate(() => templateRequests.every(request => request.projectRoot === null))).toBe(true);
});

test('自分のテンプレートから 1 ファイルを選び，入力済みの名前を使う', async ({ page }) => {
  await openPicker(page, { folder: 'notes', name: 'notes/my-research.md' });
  await page.locator('#new-file-template').selectOption('custom');
  await expect(page.locator('#new-file-template-file option')).toHaveCount(2);
  await page.locator('#new-file-template-file').selectOption('notes/日本語.md');
  await expect(page.locator('#new-file-template-preview')).toContainText('# 登録したメモ');
  await expect(page.locator('#new-file-template-preview img')).toHaveCount(0);
  await expect(page.locator('#new-file-path')).toHaveValue('notes/my-research.md');
  await expect(page.locator('#new-file-template-note')).toContainText('テキストファイル 1 個');
  await page.locator('#create-file').click();
  const created = await page.evaluate(() => createdFiles);
  expect(created).toHaveLength(1); expect(created[0].path).toBe('notes/my-research.md');
  expect(created[0].templatePath).toBe('notes/日本語.md'); expect(created[0].content).toBe(contents.custom['notes/日本語.md']);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('遅い読込みが次の選択や入力済みの名前を戻さない', async ({ page }) => {
  await openPicker(page, { folder: 'notes' });
  await page.evaluate(() => deferredTemplateRequests.add('builtin-article'));
  await page.locator('#new-file-template').selectOption('builtin-article');
  await expect(page.locator('#create-file')).toBeDisabled();
  await page.locator('#new-file-template').selectOption('builtin-markdown');
  await expect(page.locator('#new-file-template-preview')).toContainText('# Notes');
  await page.evaluate(() => releaseTemplateRequest('builtin-article'));
  await expect(page.locator('#new-file-template')).toHaveValue('builtin-markdown');
  await expect(page.locator('#new-file-path')).toHaveValue('notes/notes.md');
  await page.evaluate(() => deferredTemplateRequests.add('custom|notes/日本語.md'));
  await page.locator('#new-file-template').selectOption('custom');
  await expect(page.locator('#new-file-template-file option')).toHaveCount(2);
  await page.locator('#new-file-template-file').selectOption('notes/日本語.md');
  await page.locator('#new-file-path').fill('notes/typed-name.md');
  await expect(page.locator('#create-file')).toBeDisabled();
  await page.locator('#new-file-template').selectOption('');
  await page.evaluate(() => releaseTemplateRequest('custom|notes/日本語.md'));
  await expect(page.locator('#new-file-template-preview')).toBeHidden();
  await expect(page.locator('#new-file-path')).toHaveValue('notes/typed-name.md');
  await expect(page.locator('#create-file')).toBeEnabled();
  expect(await page.evaluate(() => templatePicker.getValue().content)).toBe('');
});

test('失敗した内容を再読込みし，閉じて開き直した画面に古い内容を出さない', async ({ page }) => {
  await openPicker(page);
  await page.evaluate(() => { failTemplateRequest = 'builtin-article|main.tex'; });
  await page.locator('#new-file-template').selectOption('builtin-article');
  await expect(page.locator('#new-file-template-error')).toBeVisible();
  await expect(page.locator('#create-file')).toBeDisabled();
  await page.locator('#new-file-template-retry').click();
  await expect(page.locator('#new-file-template-preview')).toContainText('Template article');
  await page.locator('#new-file-template').selectOption('pictures');
  await expect(page.locator('#new-file-template-status')).toContainText('編集できるテキストファイルがありません');
  await expect(page.locator('#create-file')).toBeDisabled();
  await page.evaluate(() => deferredTemplateRequests.add('custom'));
  await page.locator('#new-file-template').selectOption('custom');
  await page.evaluate(() => openFileTemplate({ folder: 'again' }));
  await page.evaluate(() => releaseTemplateRequest('custom'));
  await expect(page.locator('#new-file-template')).toHaveValue('');
  await expect(page.locator('#new-file-path')).toHaveValue('again/');
  await expect(page.locator('#new-file-template-preview')).toBeHidden();
  await page.locator('#new-file-template').selectOption('builtin-markdown');
  await expect(page.locator('#new-file-template-preview')).toContainText('# Notes');
  await page.evaluate(() => { failTemplateRequest = 'catalog'; openFileTemplate({ name: 'empty.txt' }); });
  await expect(page.locator('#new-file-template-error')).toContainText('空のファイルは作成できます');
  await expect(page.locator('#create-file')).toBeEnabled();
  await page.locator('#create-file').click();
  expect(await page.evaluate(() => createdFiles.at(-1).content)).toBe('');
});

test('狭い画面でも原稿を確認でき，長い原稿は全文を作成に使う', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPicker(page, { folder: 'notes' });
  const text = '# 日本語の長い原稿\n' + '長い行の本文'.repeat(12_000);
  await page.evaluate(text => { templateContents.custom['notes/日本語.md'] = text; }, text);
  await page.locator('#new-file-template').selectOption('custom');
  await expect(page.locator('#new-file-template-file option')).toHaveCount(2);
  await page.locator('#new-file-template-file').selectOption('notes/日本語.md');
  await expect(page.locator('.file-template-preview-note')).toBeVisible();
  expect(await page.locator('#new-file-template-preview').textContent()).toBe(text.slice(0, 60_000));
  expect(await page.evaluate(() => templatePicker.getValue().content)).toBe(text);
  const layout = await page.locator('#new-file-dialog').evaluate(dialog => ({ width: dialog.clientWidth, scroll: dialog.scrollWidth, right: dialog.getBoundingClientRect().right, viewport: innerWidth }));
  expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1); expect(layout.right).toBeLessThanOrEqual(layout.viewport);
  await page.screenshot({ path: testInfo.outputPath('file-template-picker.png') });
});
