import { expect } from '@playwright/test';
import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave, json } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const topPaths = page => page.locator('#file-tree > .tree-list > li > [data-path]').evaluateAll(entries => entries.map(entry => entry.dataset.path));
const nestedPaths = page => page.locator('.tree-directory[data-path="sort-folder10"] > .tree-list > li > .file-button').evaluateAll(entries => entries.map(entry => entry.dataset.path));

async function seedFiles(session) {
  for (const folder of ['sort-folder2', 'sort-folder10']) await mkdir(path.join(session.project, folder));
  const files = [
    ['sort-note1.txt', '2022-01-01'], ['sort-note2.txt', '2023-01-01'], ['sort-note10.txt', '2021-01-01'],
    ['sort-folder10/item2.txt', '2021-01-01'], ['sort-folder10/item10.txt', '2023-01-01'],
  ];
  for (const [relative, date] of files) {
    const file = path.join(session.project, relative);
    await writeFile(file, `Text from ${relative}\n`);
    await utimes(file, new Date(date), new Date(date));
  }
  for (const [folder, date] of [['sort-folder2', '2021-01-01'], ['sort-folder10', '2022-01-01']]) {
    await utimes(path.join(session.project, folder), new Date(date), new Date(date));
  }
  await openProject(session);
}

async function start(page, session) {
  await seedFiles(session); await openEditor(page, session);
  await page.locator('#file-filter').fill('sort-');
}

async function saveText(page, text) {
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/file' && response.request().method() === 'PUT');
  await page.keyboard.press(`${modifier}+s`);
  const response = await saved;
  expect(response.status()).toBe(200);
  return response.json();
}

test('ファイルの名前と更新日時で並び替え，検索中と再読込後にも選んだ順序を使う', async ({ page, session }, testInfo) => {
  await start(page, session);
  const orders = [
    ['name-asc', ['sort-folder2', 'sort-folder10', 'sort-note1.txt', 'sort-note2.txt', 'sort-note10.txt'], ['item2.txt', 'item10.txt']],
    ['name-desc', ['sort-folder10', 'sort-folder2', 'sort-note10.txt', 'sort-note2.txt', 'sort-note1.txt'], ['item10.txt', 'item2.txt']],
    ['modified-desc', ['sort-folder10', 'sort-folder2', 'sort-note2.txt', 'sort-note1.txt', 'sort-note10.txt'], ['item10.txt', 'item2.txt']],
    ['modified-asc', ['sort-folder2', 'sort-folder10', 'sort-note10.txt', 'sort-note1.txt', 'sort-note2.txt'], ['item2.txt', 'item10.txt']],
  ];
  for (const [order, expected, nested] of orders) {
    await page.getByTestId('file-sort').selectOption(order);
    await expect.poll(() => topPaths(page)).toEqual(expected);
    await expect.poll(() => nestedPaths(page)).toEqual(nested.map(name => `sort-folder10/${name}`));
  }
  await page.locator('#file-filter').fill('item');
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder10']);
  await expect.poll(() => nestedPaths(page)).toEqual(['sort-folder10/item2.txt', 'sort-folder10/item10.txt']);
  await expect(page.locator('.tree-directory[data-path="sort-folder10"] > summary')).toHaveAttribute('data-modified-at', '2022-01-01T00:00:00Z');
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.fileSort).toBe('modified-asc');
  await page.reload(); await expect(source(page)).toBeVisible();
  await expect(page.getByTestId('file-sort')).toHaveValue('modified-asc');
  await page.locator('#file-filter').fill('sort-');
  await expect.poll(() => topPaths(page)).toEqual(orders.at(-1)[1]);
  await page.getByTestId('outline-tab').click(); await expect(page.getByTestId('file-sort')).not.toBeVisible();
  await page.getByTestId('files-tab').click(); await expect(page.getByTestId('file-sort')).toBeVisible();
  await expect(page.getByTestId('file-sort')).toHaveValue('modified-asc');
  await page.locator('#file-filter').fill('sort-');
  await page.screenshot({ path: testInfo.outputPath('files-sorted-by-modification-time.png') });
});

test('保存と新規作成で更新日時をすぐに反映し，名前の変更後も選んだ順に並べる', async ({ page, session }) => {
  await start(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-sort').selectOption('modified-desc');
  await page.getByTestId('file-sort-note10.txt').click();
  const saved = await saveText(page, 'Saved from the editor.\n');
  await expect(page.getByTestId('file-sort-note10.txt')).toHaveAttribute('data-modified-at', saved.entry.modifiedAt);
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder10', 'sort-folder2', 'sort-note10.txt', 'sort-note2.txt', 'sort-note1.txt']);
  expect(await readFile(path.join(session.project, 'sort-note10.txt'), 'utf8')).toBe('Saved from the editor.\n');
  expect(Math.abs(Date.parse(saved.entry.modifiedAt) - (await stat(path.join(session.project, 'sort-note10.txt'))).mtimeMs)).toBeLessThan(1);
  await page.locator('#new-file').click(); await page.locator('#new-file-path').fill('sort-folder2/added.txt');
  await page.locator('#new-file-form button[type="submit"]').click();
  await expect(page.locator('#new-file-dialog')).not.toBeVisible();
  await expect(page.getByTestId('file-sort-folder2/added.txt')).toBeVisible();
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder2', 'sort-folder10', 'sort-note10.txt', 'sort-note2.txt', 'sort-note1.txt']);
  await page.getByTestId('file-sort').selectOption('name-asc');
  await page.getByTestId('file-sort-note10.txt').click({ button: 'right' });
  await page.locator('#file-context-menu [data-action="rename"]').click();
  await page.locator('#file-action-path').fill('sort-zulu.txt'); await page.locator('#file-action-submit').click();
  await expect(page.locator('#file-action-dialog')).not.toBeVisible();
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder2', 'sort-folder10', 'sort-note1.txt', 'sort-note2.txt', 'sort-zulu.txt']);
  await expect(page.getByTestId('file-sort-zulu.txt')).toBeFocused();
  await page.getByTestId('file-sort').selectOption('modified-desc');
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder2', 'sort-folder10', 'sort-zulu.txt', 'sort-note2.txt', 'sort-note1.txt']);
});

test('外部更新で並び替えてもフォーカスが続き，遅い一覧の応答が保存後の日時を戻さない', async ({ page, session }) => {
  await start(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-sort').selectOption('modified-desc');
  await writeFile(path.join(session.project, 'sort-note10.txt'), 'Edited outside the editor.\n');
  await utimes(path.join(session.project, 'sort-note10.txt'), new Date('2024-01-01'), new Date('2024-01-01'));
  await rename(path.join(session.project, 'sort-note1.txt'), path.join(session.project, 'sort-renamed.txt'));
  await utimes(path.join(session.project, 'sort-folder2'), new Date('2024-02-01'), new Date('2024-02-01'));
  await page.getByTestId('file-sort-note2.txt').focus();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => topPaths(page)).toEqual(['sort-folder2', 'sort-folder10', 'sort-note10.txt', 'sort-note2.txt', 'sort-renamed.txt']);
  await expect(page.getByTestId('file-sort-note2.txt')).toBeFocused();
  await expect(page.getByTestId('file-sort-note10.txt')).toHaveAttribute('data-modified-at', '2024-01-01T00:00:00Z');
  await page.getByTestId('file-sort-renamed.txt').click(); await expect(source(page)).toContainText('sort-note1.txt');
  let release, captured;
  const held = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { captured = resolve; });
  let holdNext = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    if (holdNext) { holdNext = false; captured(); await held; }
    await route.fulfill({ response });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await received;
  try {
    const saved = await saveText(page, 'Saved while the old list was on its way.\n');
    await expect(page.getByTestId('file-sort-renamed.txt')).toHaveAttribute('data-modified-at', saved.entry.modifiedAt);
    const outdated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    release(); await (await outdated).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(() => topPaths(page)).toEqual(['sort-folder2', 'sort-folder10', 'sort-renamed.txt', 'sort-note10.txt', 'sort-note2.txt']);
    await expect(page.getByTestId('file-sort-renamed.txt')).toHaveAttribute('data-modified-at', saved.entry.modifiedAt);
    await expect(source(page)).toContainText('Saved while the old list was on its way.');
  } finally { release(); await page.unroute('**/api/state'); }
});
