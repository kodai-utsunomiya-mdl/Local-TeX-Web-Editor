import { expect } from '@playwright/test';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave, json } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function syncFromComputer(page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/state');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await response;
}

test('PC 上で変更した原稿を読み直し，未保存の編集がある場合は両方の内容を確認できる', async ({ page, session }, testInfo) => {
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  const file = path.join(session.project, 'main.tex'), original = await readFile(file, 'utf8');
  const first = `${original}\n% first change from another editor\n`;
  await writeFile(file, first); await syncFromComputer(page);
  await expect(source(page)).toContainText('first change from another editor');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#conflict-banner')).not.toBeVisible();

  await source(page).click(); await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.insertText('\n% unsaved work in this editor\n');
  const second = `${original}\n% second change on this computer\n`;
  await writeFile(file, second); await syncFromComputer(page);
  await expect(page.locator('#conflict-banner')).toBeVisible();
  await expect(source(page)).toContainText('unsaved work in this editor');
  await expect(source(page)).not.toContainText('second change on this computer');
  expect(await readFile(file, 'utf8')).toBe(second);
  await page.locator('#review-conflict').click();
  await expect(page.locator('#disk-content')).toHaveValue(second.replaceAll('\r\n', '\n'));
  await expect(page.locator('#editing-content')).toHaveValue(/unsaved work in this editor/);
  await page.screenshot({ path: testInfo.outputPath('review-external-file-change.png') });
  await page.locator('#conflict-cancel').click();
  expect(await readFile(file, 'utf8')).toBe(second);
  await page.locator('#review-conflict').click(); await page.locator('#conflict-overwrite').click();
  await expect(page.locator('#conflict-dialog')).not.toBeVisible();
  await expect.poll(() => readFile(file, 'utf8')).toContain('unsaved work in this editor');
  await expect(page.locator('#conflict-banner')).not.toBeVisible();
  await source(page).click(); await page.keyboard.press(`${modifier}+z`);
  await expect(source(page)).not.toContainText('unsaved work in this editor');
  await expect(source(page)).toContainText('first change from another editor');
});

test('PC 上で削除した原稿は草稿と確認画面から作成し直せる', async ({ page, session }) => {
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  const file = path.join(session.project, 'main.tex'), original = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  await rm(file); await syncFromComputer(page);
  await expect(page.getByTestId('file-main.tex')).toHaveCount(0);
  await expect(page.locator('#conflict-banner')).toContainText('PC 上のファイルが見つかりません');
  await expect(source(page)).toContainText('documentclass');
  const drafts = `/api/storage?key=${encodeURIComponent(`drafts:${session.project}`)}`;
  await expect.poll(async () => (await json(session, drafts)).value?.entries?.find(entry => entry.path === 'main.tex')?.content).toBe(original);
  await page.locator('#review-conflict').click();
  await expect(page.locator('#conflict-description')).toContainText('ファイルを作成し直します');
  await expect(page.locator('#conflict-use-disk')).toBeDisabled();
  await page.locator('#conflict-cancel').click(); expect(await exists(file)).toBe(false);
  await page.locator('#review-conflict').click(); await page.locator('#conflict-overwrite').click();
  await expect(page.locator('#conflict-dialog')).not.toBeVisible();
  await expect(page.getByTestId('file-main.tex')).toBeVisible();
  expect((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).toBe(original);
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#conflict-banner')).not.toBeVisible();
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.press('Backspace');
  await rm(file);
  await page.locator('#save-button').click();
  await expect(page.locator('#conflict-banner')).toBeVisible();
  await page.locator('#review-conflict').click();
  await expect(page.locator('#conflict-use-disk')).toBeDisabled();
  await page.locator('#conflict-overwrite').click();
  await expect(page.locator('#conflict-dialog')).not.toBeVisible();
  await expect.poll(() => readFile(file, 'utf8')).toBe('');
});
