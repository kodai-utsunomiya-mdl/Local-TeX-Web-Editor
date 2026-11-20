import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, json, openProject, openEditor } from './editor-fixtures.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nS8AAAAASUVORK5CYII=', 'base64');
const dialog = page => page.locator('#new-file-dialog');

async function newFileIn(page, folder) {
  await page.locator(`.tree-directory[data-path="${folder}"] > summary`).click({ button: 'right' });
  await page.locator('#file-context-menu [data-action="newFile"]').click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#new-file-path')).toHaveValue(`${folder}/`);
  await expect(page.locator('#new-file-template')).toBeEnabled();
  await expect(page.locator('#new-file-template')).toHaveValue('');
}

test('フォルダー内のファイル作成で標準と自分のテンプレートを選び，空の原稿も作成できる', async ({ page, session }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const destination = path.join(session.project, 'destination');
  const originals = path.join(session.project, 'template-parts');
  await mkdir(destination); await mkdir(originals);
  const originalText = '\\section{選んだ原稿}\nテンプレートに登録した本文．\n';
  await writeFile(path.join(originals, 'first.tex'), '\\section{最初の原稿}\n');
  await writeFile(path.join(originals, 'second.tex'), originalText);
  await writeFile(path.join(originals, 'figure.png'), png);
  await writeFile(path.join(destination, 'occupied.tex'), 'Keep the existing document.\n');
  await openProject(session);
  const custom = await json(session, '/api/templates', { method: 'POST', data: {
    name: '複数の原稿と画像', paths: ['template-parts/first.tex', 'template-parts/second.tex', 'template-parts/figure.png'],
  } });
  const markdown = await json(session, '/api/templates/files?id=builtin-markdown&path=notes.md');
  await writeFile(path.join(originals, 'second.tex'), 'Changed after registration.\n');
  await openEditor(page, session);

  await newFileIn(page, 'destination');
  await page.locator('#new-file-template').selectOption('builtin-markdown');
  await expect(page.locator('#new-file-template-preview')).toContainText('# Notes');
  await expect(page.locator('#new-file-path')).toHaveValue('destination/notes.md');
  await page.locator('#create-file').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'destination/notes.md');
  expect(await readFile(path.join(destination, 'notes.md'), 'utf8')).toBe(markdown.content);

  await newFileIn(page, 'destination');
  await page.locator('#new-file-path').fill('destination/renamed.tex');
  await page.locator('#new-file-template').selectOption(custom.id);
  await expect(page.locator('#new-file-template-file option')).toHaveCount(2);
  await page.locator('#new-file-template-file').selectOption('template-parts/second.tex');
  await expect(page.locator('#new-file-template-preview')).toContainText('テンプレートに登録した本文');
  await expect(page.locator('#new-file-path')).toHaveValue('destination/renamed.tex');
  await expect(page.locator('#new-file-template-note')).toContainText('テキストファイル 1 個');
  await page.screenshot({ path: testInfo.outputPath('create-file-from-template.png') });
  await page.locator('#create-file').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'destination/renamed.tex');
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('テンプレートに登録した本文');
  expect(await readFile(path.join(destination, 'renamed.tex'), 'utf8')).toBe(originalText);
  expect((await readdir(destination)).sort()).toEqual(['notes.md', 'occupied.tex', 'renamed.tex']);

  await newFileIn(page, 'destination');
  await page.locator('#new-file-template').selectOption('builtin-article');
  await expect(page.locator('#new-file-template-preview')).toContainText('documentclass');
  await page.locator('#new-file-template').selectOption('');
  await expect(page.locator('#new-file-template-preview')).toBeHidden();
  await page.locator('#new-file-path').fill('destination/empty.md');
  await page.locator('#create-file').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'destination/empty.md');
  expect(await readFile(path.join(destination, 'empty.md'), 'utf8')).toBe('');

  await newFileIn(page, 'destination');
  await page.locator('#new-file-template').selectOption(custom.id);
  await expect(page.locator('#new-file-template-file option')).toHaveCount(2);
  await page.locator('#new-file-template-file').selectOption('template-parts/second.tex');
  await expect(page.locator('#new-file-template-preview')).toContainText('テンプレートに登録した本文');
  await page.locator('#new-file-path').fill('destination/occupied.tex');
  await page.locator('#create-file').click();
  await expect(page.locator('#new-file-error')).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  expect(await readFile(path.join(destination, 'occupied.tex'), 'utf8')).toBe('Keep the existing document.\n');
  await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  expect((await readdir(destination)).sort()).toEqual(['empty.md', 'notes.md', 'occupied.tex', 'renamed.tex']);
  expect(errors).toEqual([]);
});
