import { test as base, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41545';
let javascript;
const test = base.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});

test.beforeAll(async () => {
  const bundled = await build({ stdin: {
    resolveDir: path.join(repository, 'web/src'),
    contents: `import { createFileImporter } from './file-import.js';
      import { setLanguage } from './i18n.js';
      setLanguage('ja');
      const project = { root: '/fixture/project', directories: ['figures'], files: [] };
      const pending = new Map();
      let nextRequest = 0, locked = false;
      window.inspections = []; window.uploads = []; window.imported = []; window.errors = []; window.notices = [];
      window.begins = 0; window.ends = 0;
      window.failNextState = false; window.failUploadPath = '';
      window.pendingInspectionPaths = () => [...pending.values()].map(request => request.path);
      window.releaseInspection = (path, target = {}) => {
        const request = [...pending.values()].find(request => request.path === path);
        if (!request) throw new Error('No pending inspection for ' + path);
        request.resolve({ path, exists: false, directory: false, replaceable: false, size: 0, ...target });
      };
      window.importer = createFileImporter({
        getProject: () => project, isBlocked: () => locked,
        begin: async () => { locked = true; begins++; }, end: () => { locked = false; ends++; },
        api: async (endpoint, options = {}) => {
          const url = new URL(endpoint, location.origin);
          if (url.pathname === '/api/state') {
            if (failNextState) { failNextState = false; throw new Error('The project list is temporarily unavailable.'); }
            return { project };
          }
          if (url.pathname !== '/api/files/import') throw new Error('Unexpected API request: ' + endpoint);
          const path = url.searchParams.get('path'), id = ++nextRequest;
          inspections.push({ id, path, projectRoot: options.projectRoot });
          return new Promise((resolve, reject) => {
            const abort = () => { pending.delete(id); reject(new DOMException('Cancelled', 'AbortError')); };
            const finish = result => { pending.delete(id); options.signal?.removeEventListener('abort', abort); resolve(result); };
            pending.set(id, { id, path, resolve: finish });
            if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
          });
        },
        uploadFile: async (path, file, options) => {
          uploads.push({ path, content: await file.text(), projectRoot: options.projectRoot, revision: options.revision });
          if (path === failUploadPath) {
            failUploadPath = '';
            throw Object.assign(new Error('The destination changed.'), { status: 409, data: { reviewRequired: true,
              target: { path, exists: true, replaceable: true, directory: false, revision: 'changed', size: 16 } } });
          }
          return { path, state: { project } };
        },
        onImported: result => imported.push(result), onError: error => errors.push(String(error.message || error)),
        onNotice: message => notices.push(message),
      });
      document.getElementById('import-files').addEventListener('click', () => importer.open());`,
  }, bundle: true, format: 'esm', write: false });
  javascript = bundled.outputFiles[0].text;
});

async function openImporter(page, names) {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/importer.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/style.css', '/imports.css', '/file-import.css'].includes(pathname)) {
      return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', pathname.slice(1))) });
    }
    if (pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/file-import.css">
      </head><body><button id="import-files" type="button">コンピューターからファイルを追加…</button>
      <script type="module" src="/importer.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.importer))).toBe(true);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#import-files').click()]);
  await chooser.setFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Contents of ${name}\n`) })));
  await expect(page.locator('#file-import-dialog')).toBeVisible();
  await expect(page.locator('.file-import-row')).toHaveCount(names.length);
}
async function pending(page, path) { await expect.poll(() => page.evaluate(() => pendingInspectionPaths())).toContain(path); }
async function release(page, path) { await pending(page, path); await page.evaluate(path => releaseInspection(path), path); }
async function checkResult(page, paths) {
  await expect(page.locator('#file-import-dialog')).toBeHidden();
  expect(await page.evaluate(() => uploads.map(upload => upload.path))).toEqual(paths);
  expect(await page.evaluate(() => imported.at(-1).importedPaths)).toEqual(paths);
  expect(await page.evaluate(() => errors)).toEqual([]);
  expect(await page.evaluate(() => [begins, ends])).toEqual([1, 1]);
  await expect(page.locator('#import-files')).toBeFocused();
}

test('別のファイルの保存先を確認している間も，入力中の名前がそのまま続く', async ({ page }) => {
  await openImporter(page, ['first.txt', 'second.txt']);
  await release(page, 'first.txt'); await pending(page, 'second.txt');
  const first = page.locator('#file-import-path-0');
  await first.fill('renamed.txt');
  await expect(first).toBeFocused();
  await release(page, 'second.txt');
  await expect(page.locator('#file-import-action-1')).toBeEnabled();
  await expect(first).toHaveValue('renamed.txt');
  await expect(first).toBeFocused();
  await expect(page.locator('#file-import-confirm')).toBeDisabled();
  await first.press('Tab');
  await release(page, 'renamed.txt');
  await expect(page.locator('#file-import-confirm')).toBeEnabled();
  await page.locator('#file-import-confirm').click();
  await checkResult(page, ['renamed.txt', 'second.txt']);
});

test('日本語の変換を確定する Enter では保存先の入力欄から出ない', async ({ page }) => {
  await openImporter(page, ['source.txt']);
  await release(page, 'source.txt');
  const input = page.locator('#file-import-path-0');
  await input.fill('日本語の原稿.txt');
  expect(await input.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '日本語の原稿' }));
    const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return { focused: document.activeElement === node, prevented: event.defaultPrevented };
  })).toEqual({ focused: true, prevented: false });
  await expect(input).toHaveValue('日本語の原稿.txt');
  expect(await page.evaluate(() => inspections.map(request => request.path))).toEqual(['source.txt']);
  await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語の原稿' })));
  await input.press('Enter');
  await release(page, '日本語の原稿.txt');
  await expect(page.locator('#file-import-confirm')).toBeEnabled();
  await page.locator('#file-import-confirm').click();
  await checkResult(page, ['日本語の原稿.txt']);
});

test('保存先を確認する前の行は操作を待ち，確認後に選んだスキップは次の応答でも続く', async ({ page }) => {
  await openImporter(page, ['first.txt', 'second.txt', 'third.txt']);
  for (const index of [0, 1, 2]) await expect(page.locator(`#file-import-action-${index}`)).toBeDisabled();
  await expect(page.locator('#file-import-confirm')).toBeDisabled();
  await release(page, 'first.txt'); await pending(page, 'second.txt');
  await expect(page.locator('#file-import-action-0')).toBeEnabled();
  await expect(page.locator('#file-import-action-1')).toBeDisabled();
  await expect(page.locator('#file-import-action-2')).toBeDisabled();
  await release(page, 'second.txt'); await pending(page, 'third.txt');
  await page.locator('#file-import-action-1').selectOption('skip');
  await release(page, 'third.txt');
  await expect(page.locator('#file-import-action-1')).toHaveValue('skip');
  await expect(page.locator('#file-import-confirm')).toBeEnabled();
  await page.locator('#file-import-confirm').click();
  await checkResult(page, ['first.txt', 'third.txt']);
});

test('一覧を取得し直す操作では，保存先を確認している途中のファイルを送信しない', async ({ page }) => {
  await openImporter(page, ['first.txt', 'second.txt', 'third.txt']);
  for (const path of ['first.txt', 'second.txt', 'third.txt']) await release(page, path);
  await expect(page.locator('#file-import-confirm')).toBeEnabled();
  await page.evaluate(() => { failUploadPath = 'second.txt'; failNextState = true; });
  await page.locator('#file-import-confirm').click();
  const confirm = page.locator('#file-import-confirm');
  await expect(confirm).toHaveText('一覧を更新'); await expect(confirm).toBeEnabled();
  expect(await page.evaluate(() => uploads.map(upload => upload.path))).toEqual(['first.txt', 'second.txt']);
  await page.locator('#file-import-action-1').selectOption('skip');
  await page.locator('#file-import-path-2').fill('renamed-third.txt');
  await confirm.click();
  await pending(page, 'renamed-third.txt');
  await expect(confirm).toHaveText('ファイルを追加'); await expect(confirm).toBeDisabled();
  await expect(page.locator('#file-import-dialog')).toBeVisible();
  expect(await page.evaluate(() => uploads.map(upload => upload.path))).toEqual(['first.txt', 'second.txt']);
  expect(await page.evaluate(() => imported.at(-1).importedPaths)).toEqual(['first.txt', 'second.txt']);
  await release(page, 'renamed-third.txt');
  await expect(confirm).toBeEnabled(); await confirm.click();
  await expect(page.locator('#file-import-dialog')).toBeHidden();
  expect(await page.evaluate(() => uploads.map(upload => upload.path))).toEqual(['first.txt', 'second.txt', 'renamed-third.txt']);
  expect(await page.evaluate(() => imported.at(-1).importedPaths)).toEqual(['first.txt', 'renamed-third.txt']);
  expect(await page.evaluate(() => [begins, ends])).toEqual([1, 1]);
  expect(await page.evaluate(() => errors)).toEqual([]);
  await expect(page.locator('#import-files')).toBeFocused();
});
