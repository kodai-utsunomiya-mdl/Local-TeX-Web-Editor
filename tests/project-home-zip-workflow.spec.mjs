import { expect } from '@playwright/test';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const card = (page, root) => page.locator('.project-home-card').filter({ has: page.locator('.project-home-path', { hasText: root }) });
const menu = page => page.locator('#project-home-zip-menu');
const storageURL = (kind, root) => `/api/storage?${new URLSearchParams({ key: `${kind}:${root}` })}`;
const normalized = content => content.replace(/\r\n/g, '\n');

const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Research project' });

async function replaceSource(page, text) {
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
  await expect(source(page)).toContainText(text.trim());
}

async function openHome(page) {
  await page.locator('#go-home').click();
  await expect(page.locator('#welcome')).toBeVisible(); await expect(page.locator('#workbench')).toBeHidden();
}

async function openZIPMenu(page, root) {
  await card(page, root).locator('[data-action="zip"]').click();
  await expect(menu(page)).toBeVisible();
}

async function addEarlierProject(session, name = 'Earlier paper') {
  const folder = path.join(session.temp, name);
  await mkdir(folder); await writeFile(path.join(folder, 'main.tex'), 'Saved earlier manuscript\n');
  await writeFile(path.join(folder, 'references.bib'), '@book{earlier,title={Earlier research}}\n');
  return (await json(session, '/api/project/open', { method: 'POST', data: { path: folder } })).project.root;
}

async function inspectDownloadedZIP(session, download, name) {
  const archive = await readFile(await download.path());
  const body = new FormData();
  body.append('archive', new Blob([archive], { type: 'application/zip' }), download.suggestedFilename());
  body.append('parent', session.temp); body.append('name', name);
  const response = await fetch(new URL('/api/project/import', session.url), {
    method: 'POST', headers: { 'X-Local-Token': session.token, Origin: new URL(session.url).origin }, body,
    signal: AbortSignal.timeout(20_000),
  });
  const content = await response.text();
  expect(response.status, content).toBe(201);
  return JSON.parse(content).path;
}

test('ホームで現在のプロジェクトを ZIP にすると全ての未保存本文が入り，同じ編集画面へ戻る', async ({ page, session }, testInfo) => {
  await writeFile(path.join(session.project, 'notes.md'), '# Saved notes\n');
  const current = (await openProject(session)).project.root;
  const main = normalized(await readFile(path.join(current, 'main.tex'), 'utf8')) + '\n% Latest text from Home\n';
  await openEditor(page, session); await setAutoSave(page, false); await replaceSource(page, main);
  await page.getByTestId('file-notes.md').click(); await page.locator('#markdown-editor-mode').selectOption('source');
  const notes = '# Unsaved research notes\n\nThis text belongs in the ZIP.';
  await replaceSource(page, notes);
  const editorElement = await source(page).elementHandle(), cursor = await page.locator('#cursor-status').innerText();
  await openHome(page); await openZIPMenu(page, current);
  await expect(menu(page)).toContainText('Save unsaved changes');
  await testInfo.attach('project-home-current-zip-en.png', { body: await page.screenshot(), contentType: 'image/png' });
  const pending = page.waitForEvent('download'); await menu(page).locator('[data-action="download"]').click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Research project.zip');
  await expect(card(page, current).locator('[data-action="zip"]')).toBeFocused();
  await expect(page.locator('#welcome')).toBeVisible(); await expect(page).toHaveTitle('Projects — Local TeX Web Editor');
  expect((await json(session, '/api/state')).project.root).toBe(current);
  expect(normalized(await readFile(path.join(current, 'main.tex'), 'utf8'))).toBe(main);
  expect(await readFile(path.join(current, 'notes.md'), 'utf8')).toBe(notes);
  const imported = await inspectDownloadedZIP(session, download, 'Verify current project ZIP');
  expect(normalized(await readFile(path.join(imported, 'main.tex'), 'utf8'))).toBe(main);
  expect(await readFile(path.join(imported, 'notes.md'), 'utf8')).toBe(notes);
  await card(page, current).locator('[data-action="resume"]').click();
  expect(await editorElement.evaluate(element => element === document.querySelector('#editor .cm-content'))).toBe(true);
  await expect(source(page)).toHaveText(notes); await expect(page.locator('#cursor-status')).toHaveText(cursor);
  await page.keyboard.insertText(' Continued here.'); await expect(source(page)).toHaveText(notes + ' Continued here.');
});

test('別の履歴を ZIP にしても現在の本文と草稿が残り，対象の保存済みファイルを書き出す', async ({ page, session }) => {
  const previous = await addEarlierProject(session);
  const earlierDraft = { entries: [{ path: 'main.tex', content: 'Earlier draft awaiting review', baseRevision: 'old' }] };
  await json(session, '/api/storage', { method: 'PUT', data: { key: `drafts:${previous}`, value: earlierDraft } });
  const current = (await openProject(session)).project.root;
  const original = await readFile(path.join(current, 'main.tex'), 'utf8');
  await openEditor(page, session); await setAutoSave(page, false);
  const text = '% Current manuscript remains unsaved while exporting another project';
  await replaceSource(page, text); const editorElement = await source(page).elementHandle();
  const openings = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/project/open') openings.push(request); });
  await openHome(page); await openZIPMenu(page, previous);
  await expect(menu(page)).toContainText('saved files from this project');
  const pending = page.waitForEvent('download'); await menu(page).locator('[data-action="download"]').click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Earlier paper.zip');
  await expect(card(page, previous).locator('[data-action="zip"]')).toBeFocused();
  const imported = await inspectDownloadedZIP(session, download, 'Verify earlier project ZIP');
  expect(await readFile(path.join(imported, 'main.tex'), 'utf8')).toBe('Saved earlier manuscript\n');
  expect(await readFile(path.join(imported, 'references.bib'), 'utf8')).toBe('@book{earlier,title={Earlier research}}\n');
  expect((await json(session, '/api/state')).project.root).toBe(current);
  expect(await readFile(path.join(current, 'main.tex'), 'utf8')).toBe(original);
  expect((await json(session, storageURL('drafts', current))).value.entries.some(entry => entry.content === text)).toBe(true);
  expect((await json(session, storageURL('drafts', previous))).value).toEqual(earlierDraft);
  expect(openings).toHaveLength(0);
  await expect(page.locator('#welcome')).toBeVisible(); await expect(page).toHaveTitle('Projects — Local TeX Web Editor');
  await card(page, current).locator('[data-action="resume"]').click();
  expect(await editorElement.evaluate(element => element === document.querySelector('#editor .cm-content'))).toBe(true);
  await expect(source(page)).toHaveText(text); await page.keyboard.insertText(' and continue editing');
  await expect(source(page)).toHaveText(text + ' and continue editing');
});

test('履歴の ZIP を名前を付けて保存する操作を取り消し，エラーの後も元の本文を編集できる', async ({ page, session }) => {
  const previous = await addEarlierProject(session), current = (await openProject(session)).project.root;
  const original = await readFile(path.join(current, 'main.tex'), 'utf8');
  await openEditor(page, session); await setAutoSave(page, false);
  const text = '% Unsaved text while a destination is chosen'; await replaceSource(page, text);
  const requests = [];
  await page.route('**/api/project/save-as', async route => {
    requests.push({ body: route.request().postDataJSON(), root: route.request().headers()['x-project-root'] || null });
    await route.fulfill({ status: requests.length === 1 ? 200 : 503, json: requests.length === 1 ? { cancelled: true } : { error: 'The destination is unavailable.' } });
  });
  await openHome(page);
  const button = card(page, previous).locator('[data-action="zip"]');
  await button.focus(); await page.keyboard.press('ArrowUp');
  await expect(menu(page).locator('[data-action="save-as"]')).toBeFocused(); await page.keyboard.press('Enter');
  await expect.poll(() => requests.length).toBe(1); await expect(button).toBeFocused();
  expect(requests[0]).toEqual({ body: { path: previous }, root: null });
  await expect(page.locator('#app-error')).toBeHidden(); await expect(page.locator('#welcome')).toBeVisible();
  await button.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.locator('#app-error')).toContainText('The destination is unavailable.');
  await expect(button).toBeFocused(); await expect(button).toBeEnabled();
  expect(requests[1]).toEqual(requests[0]); expect((await json(session, '/api/state')).project.root).toBe(current);
  expect(await readFile(path.join(current, 'main.tex'), 'utf8')).toBe(original);
  await card(page, current).locator('[data-action="resume"]').click(); await expect(source(page)).toHaveText(text);
  await expect(source(page)).toHaveAttribute('contenteditable', 'true');
});

test('見つからないフォルダーでは ZIP 操作を止め，再確認後に同じ履歴から書き出せる', async ({ page, session }) => {
  const previous = await addEarlierProject(session), current = (await openProject(session)).project.root;
  await openEditor(page, session);
  const moved = previous + ' moved'; await rename(previous, moved); await openHome(page);
  const previousCard = card(page, previous), button = previousCard.locator('[data-action="zip"]');
  await expect(previousCard).toHaveAttribute('data-project-status', 'missing'); await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /project folder/i);
  await rename(moved, previous); await previousCard.locator('[data-action="refresh"]').click();
  await expect(button).toBeEnabled(); await openZIPMenu(page, previous);
  const pending = page.waitForEvent('download'); await menu(page).locator('[data-action="download"]').click();
  expect((await pending).suggestedFilename()).toBe('Earlier paper.zip');
  await expect(button).toBeFocused(); expect((await json(session, '/api/state')).project.root).toBe(current);
});

test('ホームで現在の本文の保存が競合した場合は ZIP を作らず，変更内容の確認を開ける', async ({ page, session }) => {
  const current = (await openProject(session)).project.root;
  const original = await readFile(path.join(current, 'main.tex'), 'utf8');
  await openEditor(page, session); await setAutoSave(page, false);
  await replaceSource(page, normalized(original) + '\n% Edited in this window\n');
  await writeFile(path.join(current, 'main.tex'), original + '\n% Changed outside the app\n');
  const archives = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/project/download') archives.push(request); });
  await openHome(page); await openZIPMenu(page, current); await menu(page).locator('[data-action="download"]').click();
  await expect(page.locator('#app-error')).toBeVisible(); await expect(page.locator('#error-action')).toBeVisible();
  await expect(card(page, current).locator('[data-action="zip"]')).toBeEnabled(); expect(archives).toHaveLength(0);
  await expect(page.locator('#welcome')).toBeVisible();
  await page.locator('#error-action').click(); await expect(page.locator('#conflict-dialog')).toBeVisible();
  await expect(page.locator('#editing-content')).toHaveValue(/Edited in this window/);
  await expect(page.locator('#disk-content')).toHaveValue(/Changed outside the app/);
});

for (const language of ['en', 'ja']) test.describe(`${language} project ZIP on Home`, () => {
  test.use({ interfaceLanguage: language });
  test('ホームの行と ZIP メニューを日英で表示し，狭い画面でもキーで操作できる', async ({ page, session }, testInfo) => {
    const previous = await addEarlierProject(session, language === 'ja' ? '以前の研究原稿' : 'Earlier research paper');
    const current = (await openProject(session)).project.root;
    await openEditor(page, session); await openHome(page);
    await testInfo.attach(`project-home-${language}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await openZIPMenu(page, previous);
    await expect(menu(page).getByRole('menuitem')).toHaveCount(2);
    await expect(menu(page).locator('[data-action="download"]')).toHaveText(language === 'ja' ? 'プロジェクトを ZIP でダウンロード' : 'Download project as ZIP');
    await testInfo.attach(`project-home-zip-${language}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape'); await expect(card(page, previous).locator('[data-action="zip"]')).toBeFocused();
    await page.locator('#theme-toggle').click(); await openZIPMenu(page, current);
    await testInfo.attach(`project-home-zip-${language}-light.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 390, height: 844 });
    const button = card(page, previous).locator('[data-action="zip"]');
    await button.scrollIntoViewIfNeeded(); await button.focus(); await page.keyboard.press('ArrowUp');
    await expect(menu(page).locator('[data-action="save-as"]')).toBeFocused();
    await expect(menu(page).locator('[data-action="download"]')).toBeInViewport();
    await expect(menu(page).locator('[data-action="save-as"]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await testInfo.attach(`project-home-zip-${language}-narrow.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape'); await expect(button).toBeFocused();
    await page.keyboard.press('Tab'); await expect(card(page, previous).locator('[data-action="delete"]')).toBeFocused();
  });
});
