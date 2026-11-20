import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const file = (page, name) => page.getByTestId(`file-${name}`);
const folder = (page, name) => page.locator(`.tree-directory[data-path="${name}"] > summary`);
const topPaths = page => page.locator('#file-tree > .tree-list > li > [data-path]').evaluateAll(entries => entries.map(entry => entry.dataset.path));
const exists = name => stat(name).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nS8AAAAASUVORK5CYII=', 'base64');

async function start(page, session) {
  await openProject(session); await openEditor(page, session);
  await page.locator('#file-filter').fill('drag-');
}

async function drag(source, target, placement) {
  await expect(source).toBeEnabled();
  await expect(source).toHaveAttribute('draggable', 'true');
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  expect(bounds).toBeTruthy();
  const y = placement === 'before' ? 3 : placement === 'after' ? bounds.height - 3 : bounds.height / 2;
  await source.dragTo(target, { sourcePosition: { x: 40, y: 12 }, targetPosition: { x: 40, y } });
  await expect(source.page().locator('.file-tree-drag-status')).toHaveText(/移動しました．$|^移動できませんでした．$/);
}

async function edit(page, text) {
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
}

async function storedSession(session) {
  const root = (await json(session, '/api/state')).project.root;
  return (await json(session, `/api/storage?key=${encodeURIComponent(`session:${root}`)}`)).value;
}

test('行の上下へドラッグして手動の順序に切り替え，再読込と並び替えの変更後もその順序を使う', async ({ page, session }, testInfo) => {
  await mkdir(path.join(session.project, 'drag-folder'));
  for (const [name, day] of [['drag-note1.txt', 1], ['drag-note2.txt', 3], ['drag-note10.txt', 2]]) {
    const nameOnDisk = path.join(session.project, name);
    await writeFile(nameOnDisk, `Text from ${name}\n`);
    const time = new Date(`2025-01-0${day}T00:00:00Z`); await utimes(nameOnDisk, time, time);
  }
  await start(page, session);
  const moves = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/entry' && request.method() === 'PATCH') moves.push(request.postDataJSON()); });
  await expect.poll(() => topPaths(page)).toEqual(['drag-folder', 'drag-note1.txt', 'drag-note2.txt', 'drag-note10.txt']);
  await drag(file(page, 'drag-note10.txt'), folder(page, 'drag-folder'), 'before');
  await expect(page.getByTestId('file-sort')).toHaveValue('manual');
  await expect.poll(() => topPaths(page)).toEqual(['drag-note10.txt', 'drag-folder', 'drag-note1.txt', 'drag-note2.txt']);
  await expect(file(page, 'drag-note10.txt')).toBeFocused();
  await drag(file(page, 'drag-note2.txt'), file(page, 'drag-note10.txt'), 'after');
  const manual = ['drag-note10.txt', 'drag-note2.txt', 'drag-folder', 'drag-note1.txt'];
  await expect.poll(() => topPaths(page)).toEqual(manual);
  await expect.poll(async () => (await storedSession(session))?.fileOrder?.['']?.filter(name => name.startsWith('drag-'))).toEqual(manual);
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.fileSort).toBe('manual');
  await page.reload(); await expect(source(page)).toBeVisible();
  await page.locator('#file-filter').fill('drag-');
  await expect(page.getByTestId('file-sort')).toHaveValue('manual');
  await expect.poll(() => topPaths(page)).toEqual(manual);
  await page.getByTestId('file-sort').selectOption('name-asc');
  await expect.poll(() => topPaths(page)).toEqual(['drag-folder', 'drag-note1.txt', 'drag-note2.txt', 'drag-note10.txt']);
  await page.getByTestId('file-sort').selectOption('modified-desc');
  await expect.poll(() => topPaths(page)).toEqual(['drag-folder', 'drag-note2.txt', 'drag-note10.txt', 'drag-note1.txt']);
  await page.getByTestId('file-sort').selectOption('manual');
  await expect.poll(() => topPaths(page)).toEqual(manual);
  expect(moves).toEqual([]);
  expect(await readFile(path.join(session.project, 'drag-note2.txt'), 'utf8')).toBe('Text from drag-note2.txt\n');
  await page.screenshot({ path: testInfo.outputPath('file-tree-manual-order.png') });
});

test('ファイルとフォルダーを移動して未保存の本文と Undo を使い，空のフォルダーと画像も移動できる', async ({ page, session }, testInfo) => {
  const saved = 'Saved note.\n', edited = 'Unsaved note after moving.\n';
  const savedChapter = 'Saved chapter.\n', editedChapter = 'Unsaved chapter after moving.\n';
  for (const name of ['drag-target', 'drag-other', 'drag-empty', 'drag-chapter/empty']) await mkdir(path.join(session.project, name), { recursive: true });
  await writeFile(path.join(session.project, 'drag-note.txt'), saved);
  await writeFile(path.join(session.project, 'drag-chapter', 'body.tex'), savedChapter);
  await writeFile(path.join(session.project, 'drag-chapter', 'figure.png'), png);
  await writeFile(path.join(session.project, 'drag-image.png'), png);
  const existing = Buffer.from('Existing image bytes');
  await writeFile(path.join(session.project, 'drag-target', 'drag-image.png'), existing);
  await start(page, session); await setAutoSave(page, false);
  await file(page, 'drag-note.txt').click(); await edit(page, edited);
  await drag(file(page, 'drag-note.txt'), folder(page, 'drag-target'), 'inside');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'drag-target/drag-note.txt');
  await expect(source(page)).toContainText(edited.trim());
  expect(await readFile(path.join(session.project, 'drag-target', 'drag-note.txt'), 'utf8')).toBe(saved);
  expect(await exists(path.join(session.project, 'drag-note.txt'))).toBe(false);
  await source(page).click(); await page.keyboard.press(`${modifier}+z`);
  await expect(source(page)).toContainText(saved.trim());
  await page.keyboard.press(modifier === 'Meta' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(source(page)).toContainText(edited.trim());
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(path.join(session.project, 'drag-target', 'drag-note.txt'), 'utf8')).toBe(edited);
  await file(page, 'drag-chapter/body.tex').click(); await edit(page, editedChapter);
  await drag(folder(page, 'drag-chapter'), folder(page, 'drag-target'), 'inside');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'drag-target/drag-chapter/body.tex');
  await expect(source(page)).toContainText(editedChapter.trim());
  expect(await readFile(path.join(session.project, 'drag-target', 'drag-chapter', 'body.tex'), 'utf8')).toBe(savedChapter);
  expect(await readFile(path.join(session.project, 'drag-target', 'drag-chapter', 'figure.png'))).toEqual(png);
  expect(await readdir(path.join(session.project, 'drag-target', 'drag-chapter', 'empty'))).toEqual([]);
  expect(await exists(path.join(session.project, 'drag-chapter'))).toBe(false);
  await source(page).click(); await page.keyboard.press(`${modifier}+z`);
  await expect(source(page)).toContainText(savedChapter.trim());
  await page.keyboard.press(modifier === 'Meta' ? 'Meta+Shift+Z' : 'Control+y');
  await expect(source(page)).toContainText(editedChapter.trim());
  await drag(folder(page, 'drag-empty'), folder(page, 'drag-target'), 'inside');
  await expect(folder(page, 'drag-target/drag-empty')).toBeVisible();
  expect(await readdir(path.join(session.project, 'drag-target', 'drag-empty'))).toEqual([]);
  expect(await exists(path.join(session.project, 'drag-empty'))).toBe(false);
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/entry' && response.request().method() === 'PATCH');
  await drag(file(page, 'drag-image.png'), folder(page, 'drag-target'), 'inside');
  expect((await rejected).status()).toBe(409);
  await expect(page.locator('#app-error')).toBeVisible();
  await expect(page.locator('#error-text')).toContainText('同じ名前');
  expect(await readFile(path.join(session.project, 'drag-image.png'))).toEqual(png);
  expect(await readFile(path.join(session.project, 'drag-target', 'drag-image.png'))).toEqual(existing);
  await drag(file(page, 'drag-image.png'), folder(page, 'drag-other'), 'inside');
  await expect(file(page, 'drag-other/drag-image.png')).toBeVisible();
  expect(await readFile(path.join(session.project, 'drag-other', 'drag-image.png'))).toEqual(png);
  expect(await exists(path.join(session.project, 'drag-image.png'))).toBe(false);
  await expect(source(page)).toContainText(editedChapter.trim());
  await expect.poll(async () => (await storedSession(session))?.tabs).toContain('drag-target/drag-chapter/body.tex');
  expect((await storedSession(session)).tabs).not.toContain('drag-chapter/body.tex');
  await page.screenshot({ path: testInfo.outputPath('file-tree-after-moving.png') });
});

test('Alt と上下の矢印でファイルとフォルダーの順序を変更し，移動した行へフォーカスを戻す', async ({ page, session }) => {
  for (const name of ['drag-folder-a', 'drag-folder-b']) await mkdir(path.join(session.project, name));
  for (const name of ['drag-note1.txt', 'drag-note2.txt']) await writeFile(path.join(session.project, name), `${name}\n`);
  await start(page, session);
  const initial = ['drag-folder-a', 'drag-folder-b', 'drag-note1.txt', 'drag-note2.txt'];
  await expect.poll(() => topPaths(page)).toEqual(initial);
  await file(page, 'drag-note1.txt').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByTestId('file-sort')).toHaveValue('manual');
  await expect.poll(() => topPaths(page)).toEqual(['drag-folder-a', 'drag-note1.txt', 'drag-folder-b', 'drag-note2.txt']);
  await expect(file(page, 'drag-note1.txt')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => topPaths(page)).toEqual(initial);
  await expect(file(page, 'drag-note1.txt')).toBeFocused();
  await folder(page, 'drag-folder-b').focus(); await page.keyboard.press('Alt+ArrowUp');
  const moved = ['drag-folder-b', 'drag-folder-a', 'drag-note1.txt', 'drag-note2.txt'];
  await expect.poll(() => topPaths(page)).toEqual(moved);
  await expect(folder(page, 'drag-folder-b')).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('.file-tree-drag-status')).toContainText('この階層の先頭');
  await expect.poll(() => topPaths(page)).toEqual(moved);
  expect(await readdir(path.join(session.project, 'drag-folder-b'))).toEqual([]);
});
