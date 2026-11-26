import { expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const menu = page => page.locator('#file-context-menu');
const editor = page => page.getByTestId('editor').locator('.cm-content');

async function fileMenu(page, name) {
  await page.getByTestId(`file-${name}`).click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: 'ダウンロード', exact: true })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: '名前を付けて保存…', exact: true })).toBeVisible();
}

async function download(page, name) {
  await fileMenu(page, name);
  const pending = page.waitForEvent('download');
  await menu(page).getByRole('menuitem', { name: 'ダウンロード', exact: true }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe(path.basename(name));
  return readFile(await file.path());
}

test('ファイル一覧からテキストとバイナリをダウンロードできる', async ({ page, session }, testInfo) => {
  const text = Buffer.from('\ufeff# 日本語の原稿\r\n本文\r\n');
  const binary = Buffer.from([0, 255, 1, 13, 10, 128]);
  await writeFile(path.join(session.project, '日本語の 原稿.md'), text);
  await writeFile(path.join(session.project, 'data.bin'), binary);
  await mkdir(path.join(session.project, 'empty'));
  await openProject(session); await openEditor(page, session);
  expect(await download(page, '日本語の 原稿.md')).toEqual(text);
  expect(await download(page, 'data.bin')).toEqual(binary);
  await fileMenu(page, '日本語の 原稿.md');
  await page.screenshot({ path: testInfo.outputPath('file-download-and-save-as.png') });
  await page.keyboard.press('Escape');
  await page.locator('.tree-directory[data-path="empty"] > summary').click({ button: 'right' });
  await expect(menu(page).locator('[data-action="download"], [data-action="saveAs"]')).toHaveCount(0);
});

test('未保存の本文をダウンロードしても元のファイルと編集中のタブはそのままである', async ({ page, session }) => {
  const saved = '\ufeff# Saved\r\n';
  await writeFile(path.join(session.project, 'notes.md'), saved);
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-notes.md').click(); await page.locator('#markdown-editor-mode').selectOption('source');
  await editor(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText('# Current\n編集中の本文\n');
  expect(await download(page, 'notes.md')).toEqual(Buffer.from('\ufeff# Current\r\n編集中の本文\r\n'));
  expect(await readFile(path.join(session.project, 'notes.md'), 'utf8')).toBe(saved);
  await expect(editor(page)).toContainText('編集中の本文');
  await expect(page.locator('#toast')).toContainText('編集中の内容');
  await editor(page).click(); await page.keyboard.press(`${modifier}+z`);
  await expect(editor(page)).toContainText('Saved');
});

test('名前を付けて保存では現在の本文を渡し，キャンセル後も編集を続けられる', async ({ page, session }) => {
  await writeFile(path.join(session.project, 'notes.md'), '# Saved\n');
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-notes.md').click(); await page.locator('#markdown-editor-mode').selectOption('source');
  await editor(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText('# Unsaved\n');
  const requests = [];
  await page.route('**/api/file/save-as', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
  });
  await fileMenu(page, 'notes.md');
  await menu(page).getByRole('menuitem', { name: '名前を付けて保存…', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ path: 'notes.md', content: '# Unsaved\n', lineEnding: 'lf' });
  expect(requests[0].revision).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.locator('#file-tree .file-button').first()).toBeEnabled();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  expect(await readFile(path.join(session.project, 'notes.md'), 'utf8')).toBe('# Saved\n');
  await editor(page).click(); await page.keyboard.press('End'); await page.keyboard.insertText('Continued editing');
  await expect(editor(page)).toContainText('Continued editing');
  await expect(page.locator('#app-error')).toBeHidden();
});
