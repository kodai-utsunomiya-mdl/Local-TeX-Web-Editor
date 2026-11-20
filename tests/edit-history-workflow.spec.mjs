import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const sourceText = async page => (await source(page).locator('.cm-line').allTextContents()).join('\n');
const history = page => page.getByTestId('edit-history-dialog');
const versionBoxes = page => page.locator('input[data-history-select]');
const selectedIDs = page => versionBoxes(page).evaluateAll(boxes => boxes.filter(box => box.checked).map(box => box.dataset.historySelect));
const selectedHunks = page => page.locator('input[data-hunk]').evaluateAll(boxes => boxes.filter(box => box.checked).map(box => Number(box.dataset.hunk)));

async function prepare(page, session, current, versions) {
  await writeFile(path.join(session.project, 'history.tex'), current);
  await openProject(session);
  const document = await json(session, '/api/file?path=history.tex');
  for (const version of versions) await json(session, '/api/history', {
    method: 'POST', data: { path: 'history.tex', content: version.content, revision: document.revision, label: version.label },
  });
  const recorded = (await json(session, '/api/history?path=history.tex')).entries;
  await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-history.tex').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'history.tex');
  return recorded;
}

async function openHistory(page) {
  await page.locator('#writing-menu > summary').click();
  await page.locator('#document-history').click();
  await expect(history(page)).toBeVisible();
}

test('複数の版を選び，削除の確認を取り消した後に選んだ版だけを削除できる', async ({ page, session }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const saved = 'Current saved text.\n';
  const versions = ['First version', 'Second version', 'Third version', 'Fourth version'].map(label => ({ label, content: `${label}\n` }));
  const recorded = await prepare(page, session, saved, versions);
  const unsaved = 'Current saved text.\nUnsaved paragraph.\n';
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(unsaved);
  await openHistory(page);
  await expect(versionBoxes(page)).toHaveCount(4);
  await page.locator('#history-select-all-versions').check();
  await expect.poll(() => selectedIDs(page)).toEqual(recorded.map(entry => entry.id));
  await page.locator('#history-select-all-versions').uncheck();
  await expect.poll(() => selectedIDs(page)).toEqual([]);
  await versionBoxes(page).nth(0).click();
  await versionBoxes(page).nth(2).click({ modifiers: ['Shift'] });
  const removed = recorded.slice(0, 3), remaining = recorded[3];
  await expect.poll(() => selectedIDs(page)).toEqual(removed.map(entry => entry.id));
  await page.locator(`.history-entry[data-history-id="${remaining.id}"]`).click();
  await expect.poll(() => selectedIDs(page)).toEqual(removed.map(entry => entry.id));
  await page.locator('#history-delete-selected').click();
  await expect(page.locator('#history-delete-dialog')).toBeVisible();
  for (const entry of removed) await expect(page.locator('#history-delete-entries')).toContainText(entry.label);
  await expect(page.locator('#history-delete-entries')).not.toContainText(remaining.label);
  await testInfo.attach('history-delete-confirmation.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.locator('#history-delete-cancel').click();
  await expect(page.locator('#history-delete-dialog')).not.toBeVisible(); await expect(history(page)).toBeVisible();
  expect((await json(session, '/api/history?path=history.tex')).entries.map(entry => entry.id)).toEqual(recorded.map(entry => entry.id));
  expect(await readFile(path.join(session.project, 'history.tex'), 'utf8')).toBe(saved);
  await expect.poll(() => sourceText(page)).toBe(unsaved);
  await page.locator('#history-delete-selected').click();
  const deletion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/history' && response.request().method() === 'DELETE');
  await page.locator('#history-delete-confirm').click();
  const response = await deletion;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON().ids.sort()).toEqual(removed.map(entry => entry.id).sort());
  await expect(page.locator('#history-delete-dialog')).not.toBeVisible();
  await expect(versionBoxes(page)).toHaveCount(1);
  await expect(page.locator(`.history-entry[data-history-id="${remaining.id}"]`)).toBeVisible();
  expect((await json(session, '/api/history?path=history.tex')).entries.map(entry => entry.id)).toEqual([remaining.id]);
  expect((await json(session, `/api/history?path=history.tex&id=${remaining.id}`)).content).toBe(`${remaining.label}\n`);
  await history(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect.poll(() => sourceText(page)).toBe(unsaved);
  expect(await readFile(path.join(session.project, 'history.tex'), 'utf8')).toBe(saved);
  expect(errors).toEqual([]);
});

test('複数の変更箇所を戻し，選ばなかった本文をそのままにして Undo と Redo を使える', async ({ page, session }) => {
  const previous = 'First before\nKeep A\nSecond before\nKeep B\nThird before\nKeep C\nFourth before\n';
  const current = 'First current\nKeep A\nSecond current\nKeep B\nThird current\nKeep C\nFourth current\n';
  const [entry] = await prepare(page, session, current, [{ label: 'Before editing four paragraphs', content: previous }]);
  await openHistory(page);
  await page.locator(`.history-entry[data-history-id="${entry.id}"]`).click();
  const hunks = page.locator('input[data-hunk]'); await expect(hunks).toHaveCount(4);
  await page.locator('#history-select-all-changes').click(); await expect.poll(() => selectedHunks(page)).toEqual([0, 1, 2, 3]);
  await page.locator('#history-select-all-changes').click(); await expect.poll(() => selectedHunks(page)).toEqual([]);
  await hunks.nth(0).click(); await hunks.nth(2).click({ modifiers: ['Shift'] });
  await expect.poll(() => selectedHunks(page)).toEqual([0, 1, 2]);
  await hunks.nth(1).click(); await expect.poll(() => selectedHunks(page)).toEqual([0, 2]);
  await page.getByTestId('restore-history-selection').click(); await expect(history(page)).not.toBeVisible();
  const restored = current.replace('First current', 'First before').replace('Third current', 'Third before');
  await expect.poll(() => sourceText(page)).toBe(restored);
  expect(await readFile(path.join(session.project, 'history.tex'), 'utf8')).toBe(current);
  await source(page).click(); await page.keyboard.press(`${modifier}+z`);
  await expect.poll(() => sourceText(page)).toBe(current);
  await page.keyboard.press(modifier === 'Meta' ? 'Meta+Shift+z' : 'Control+y');
  await expect.poll(() => sourceText(page)).toBe(restored);
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(path.join(session.project, 'history.tex'), 'utf8')).toBe(restored);
});

test('確認中に別の画面で版が消えても残りを削除でき，空の履歴から新しい版を記録できる', async ({ page, session }) => {
  const current = 'The document stays here.\n';
  const recorded = await prepare(page, session, current, [
    { label: 'Earlier one', content: 'Earlier one\n' },
    { label: 'Earlier two', content: 'Earlier two\n' },
    { label: 'Earlier three', content: 'Earlier three\n' },
  ]);
  await openHistory(page); await expect(versionBoxes(page)).toHaveCount(3);
  await page.locator('#history-select-all-versions').check(); await page.locator('#history-delete-selected').click();
  await expect(page.locator('#history-delete-dialog')).toBeVisible();
  await json(session, '/api/history', { method: 'DELETE', data: { path: 'history.tex', ids: [recorded[0].id] } });
  const deletion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/history' && response.request().method() === 'DELETE');
  await page.locator('#history-delete-confirm').click();
  const result = await (await deletion).json();
  expect(result.deleted.sort()).toEqual(recorded.slice(1).map(entry => entry.id).sort());
  await expect(page.locator('#history-delete-dialog')).not.toBeVisible(); await expect(versionBoxes(page)).toHaveCount(0);
  await expect(page.getByTestId('history-entries')).toContainText('記録した版はまだありません．');
  await expect(page.locator('#history-delete-selected')).toBeDisabled();
  await page.getByTestId('history-label').fill('After removing old versions'); await page.getByTestId('record-history').click();
  await expect(page.getByTestId('history-status')).toContainText('現在の内容を記録');
  await expect(versionBoxes(page)).toHaveCount(1);
  const [remaining] = (await json(session, '/api/history?path=history.tex')).entries;
  expect(remaining.label).toBe('After removing old versions');
  expect((await json(session, `/api/history?path=history.tex&id=${remaining.id}`)).content).toBe(current);
  await history(page).getByRole('button', { name: '閉じる', exact: true }).click();
  await expect.poll(() => sourceText(page)).toBe(current);
  expect(await readFile(path.join(session.project, 'history.tex'), 'utf8')).toBe(current);
});
