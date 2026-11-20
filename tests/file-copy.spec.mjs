import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const dialog = page => page.locator('#file-action-dialog');
const folder = (page, name) => page.locator(`.tree-directory[data-path="${name}"] > summary`);
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nS8AAAAASUVORK5CYII=', 'base64');

async function openCopy(page, target) {
  await target.click({ button: 'right' });
  await page.locator('#file-context-menu [data-action="duplicate"]').click();
  await expect(dialog(page)).toBeVisible();
}

test('ファイルのコピーには保存済みの内容を使い，元の未保存の編集を続けられる', async ({ page, session }, testInfo) => {
  const saved = '\ufeff# Saved\r\n日本語の本文．\r\n';
  await writeFile(path.join(session.project, 'notes.md'), saved);
  await writeFile(path.join(session.project, 'notes-copy.md'), '# Existing copy\n');
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-notes.md').click(); await page.locator('#markdown-editor-mode').selectOption('source');
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText('# Unsaved original\n');
  await openCopy(page, page.getByTestId('file-notes.md'));
  await expect(page.locator('#file-action-path')).toHaveValue('notes-copy-2.md');
  await expect(dialog(page).locator('.file-action-unsaved')).toContainText('notes.md');
  await expect(dialog(page).locator('.file-action-unsaved')).toContainText('保存済みの内容');
  await page.screenshot({ path: testInfo.outputPath('create-file-copy.png') });
  await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect(await exists(path.join(session.project, 'notes-copy-2.md'))).toBe(false);
  await openCopy(page, page.getByTestId('file-notes.md')); await page.locator('#file-action-submit').click();
  await expect(dialog(page)).not.toBeVisible();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'notes-copy-2.md');
  expect(await readFile(path.join(session.project, 'notes-copy-2.md'), 'utf8')).toBe(saved);
  expect(await readFile(path.join(session.project, 'notes.md'), 'utf8')).toBe(saved);
  await page.getByTestId('file-notes.md').click(); await expect(source(page)).toContainText('Unsaved original');
  await source(page).click(); await page.keyboard.press(`${modifier}+z`); await expect(source(page)).toContainText('Saved');
});

test('画像を別の既存フォルダーへコピーし，同名の項目を置き換えない', async ({ page, session }) => {
  await mkdir(path.join(session.project, 'figures')); await writeFile(path.join(session.project, 'image.png'), png);
  await writeFile(path.join(session.project, 'figures', 'image.png'), Buffer.from('existing bytes'));
  await openProject(session); await openEditor(page, session);
  await openCopy(page, page.getByTestId('file-image.png')); await page.locator('#file-action-path').fill('figures/image.png');
  await page.locator('#file-action-submit').click(); await expect(dialog(page).locator('.form-error')).toBeVisible();
  expect(await readFile(path.join(session.project, 'figures', 'image.png'), 'utf8')).toBe('existing bytes');
  await page.locator('#file-action-path').fill('figures/image-copy.png'); await page.locator('#file-action-submit').click();
  await expect(dialog(page)).not.toBeVisible(); await expect(page.getByTestId('file-figures/image-copy.png')).toBeVisible();
  expect(await readFile(path.join(session.project, 'figures', 'image-copy.png'))).toEqual(png);
  expect(await readFile(path.join(session.project, 'image.png'))).toEqual(png);
});

test('フォルダーの中身と空のフォルダーをコピーし，確認後の変更を再確認できる', async ({ page, session }) => {
  const original = path.join(session.project, 'chapter');
  await mkdir(path.join(original, 'empty'), { recursive: true }); await mkdir(path.join(original, 'images'));
  await writeFile(path.join(original, 'body.tex'), 'Original body\n'); await writeFile(path.join(original, 'images', 'figure.png'), png);
  await openProject(session); await openEditor(page, session);
  await openCopy(page, folder(page, 'chapter')); await expect(page.locator('#file-action-path')).toHaveValue('chapter-copy');
  await writeFile(path.join(original, 'extra.md'), '# Added after opening the dialog\n');
  await page.locator('#file-action-submit').click(); await expect(dialog(page).locator('.form-error')).toBeVisible();
  await expect(dialog(page).locator('.file-action-contents')).toContainText('chapter/extra.md');
  expect(await exists(path.join(session.project, 'chapter-copy'))).toBe(false);
  await page.locator('#file-action-submit').click(); await expect(dialog(page)).not.toBeVisible();
  await expect(folder(page, 'chapter-copy')).toBeVisible();
  expect(await readFile(path.join(session.project, 'chapter-copy', 'body.tex'), 'utf8')).toBe('Original body\n');
  expect(await readFile(path.join(session.project, 'chapter-copy', 'images', 'figure.png'))).toEqual(png);
  expect(await readdir(path.join(session.project, 'chapter-copy', 'empty'))).toEqual([]);
  expect(await readFile(path.join(session.project, 'chapter-copy', 'extra.md'), 'utf8')).toBe('# Added after opening the dialog\n');
  expect(await readFile(path.join(original, 'body.tex'), 'utf8')).toBe('Original body\n');
});
