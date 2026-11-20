import { expect } from '@playwright/test';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const card = (page, root) => page.locator('.project-home-card').filter({ hasText: root });
const storageURL = (kind, root) => `/api/storage?${new URLSearchParams({ key: `${kind}:${root}` })}`;
const exists = file => stat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

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
  await source(page).click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(text);
  await expect(source(page)).toContainText(text.trim());
}

async function openHome(page) {
  await page.locator('#go-home').click();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#workbench')).toBeHidden();
  await expect(page).toHaveTitle('Projects — Local TeX Web Editor');
}

async function inspectDeletion(page, root) {
  await card(page, root).locator('[data-action="delete"]').click();
  await expect(page.locator('#project-delete-dialog')).toBeVisible();
  await expect(page.locator('#project-delete-path')).toHaveText(root);
  await expect(page.locator('#project-delete-cancel')).toBeFocused();
  await expect(page.locator('#project-delete-confirm')).toBeDisabled();
}

async function confirmDeletion(page, root) {
  await page.locator('#project-delete-acknowledge').check();
  await page.locator('#project-delete-name').fill(path.basename(root));
  await expect(page.locator('#project-delete-confirm')).toBeEnabled();
  await page.locator('#project-delete-confirm').click();
}

test('ロゴでホームへ移り，削除をキャンセルして同じエディタで編集を続ける', async ({ page, session }, testInfo) => {
  const meta = await openProject(session);
  const root = meta.project.root;
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  await openEditor(page, session);
  await setAutoSave(page, false);
  const text = '% Unsaved text before visiting Home';
  await replaceSource(page, text);
  const editorElement = await source(page).elementHandle();

  await openHome(page);
  await expect(card(page, root).locator('[data-action="resume"]')).toBeVisible();
  await expect(card(page, root)).toContainText('Current project');
  expect(await editorElement.evaluate(element => element.isConnected)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('project-home.png') });
  await inspectDeletion(page, root);
  await expect(page.locator('#project-delete-unsaved')).toContainText('main.tex');
  await page.locator('#project-delete-cancel').click();
  await expect(page.locator('#project-delete-dialog')).toBeHidden();
  await expect(card(page, root).locator('[data-action="delete"]')).toBeFocused();
  await card(page, root).locator('[data-action="resume"]').click();

  await expect(source(page)).toBeVisible();
  await expect(source(page)).toHaveText(text);
  expect(await editorElement.evaluate(element => element === document.querySelector('#editor .cm-content'))).toBe(true);
  await page.keyboard.insertText(' and after returning');
  await expect(source(page)).toHaveText(text + ' and after returning');
  expect(await readFile(path.join(root, 'main.tex'), 'utf8')).toBe(original);
});

test('現在のプロジェクトを確認して削除すると，ホームと草稿の記録も更新される', async ({ page, session }) => {
  await mkdir(path.join(session.project, 'figures', 'drafts'), { recursive: true });
  await writeFile(path.join(session.project, 'figures', 'drafts', 'caption.txt'), 'Figure caption');
  await mkdir(path.join(session.project, '.private'), { recursive: true });
  await writeFile(path.join(session.project, '.private', 'note.txt'), 'Hidden project note');
  const outside = path.join(session.temp, 'keep.txt');
  await writeFile(outside, 'Outside the project');
  const meta = await openProject(session);
  const root = meta.project.root;
  await openEditor(page, session);
  await setAutoSave(page, false);
  await replaceSource(page, '% Unsaved document to review before deletion');
  await openHome(page);
  await inspectDeletion(page, root);
  await expect(page.locator('#project-delete-entries')).toContainText('figures/drafts/caption.txt');
  await expect(page.locator('#project-delete-entries')).toContainText('.private/note.txt');
  await expect(page.locator('#project-delete-unsaved')).toContainText('main.tex');
  await expect(page.locator('#project-delete-drafts')).toContainText('main.tex');
  await page.locator('#project-delete-acknowledge').check();
  await page.locator('#project-delete-name').fill('Another project');
  await expect(page.locator('#project-delete-confirm')).toBeDisabled();
  await page.locator('#project-delete-name').fill(path.basename(root));
  await page.locator('#project-delete-name').press('Enter');
  await expect(page.locator('#project-delete-dialog')).toBeVisible();
  expect(await exists(root)).toBe(true);
  await page.locator('#project-delete-confirm').click();

  await expect(page.locator('#project-delete-dialog')).toBeHidden();
  await expect(card(page, root)).toHaveCount(0);
  await expect(page.locator('#welcome')).toBeVisible();
  expect(await exists(root)).toBe(false);
  expect(await readFile(outside, 'utf8')).toBe('Outside the project');
  expect((await json(session, '/api/state')).project).toBeNull();
  expect((await json(session, storageURL('drafts', root))).value).toBeNull();
  expect((await json(session, storageURL('session', root))).value).toBeNull();
  await page.reload();
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('.project-home-card')).toHaveCount(0);
  expect((await json(session, storageURL('drafts', root))).value).toBeNull();
});

test('削除の確認後にファイルが増えた場合は一覧を更新して確認し直す', async ({ page, session }) => {
  const meta = await openProject(session);
  const root = meta.project.root;
  await openEditor(page, session);
  await openHome(page);
  await inspectDeletion(page, root);
  await writeFile(path.join(root, 'added-after-preview.txt'), 'A file added by another program');
  await confirmDeletion(page, root);
  await expect(page.locator('#project-delete-message')).toBeVisible();
  await expect(page.locator('#project-delete-entries')).toContainText('added-after-preview.txt');
  await expect(page.locator('#project-delete-name')).toHaveValue('');
  await expect(page.locator('#project-delete-acknowledge')).not.toBeChecked();
  await expect(page.locator('#project-delete-confirm')).toBeDisabled();
  await expect(page.locator('#project-delete-cancel')).toBeFocused();
  expect(await exists(path.join(root, 'main.tex'))).toBe(true);
  expect(await readFile(path.join(root, 'added-after-preview.txt'), 'utf8')).toBe('A file added by another program');
  await page.locator('#project-delete-cancel').click();
  await card(page, root).locator('[data-action="resume"]').click();
  await expect(source(page)).toBeVisible();
});

test('最近使った別のプロジェクトを削除し，編集中の本文と草稿を残す', async ({ page, session }) => {
  const previous = path.join(session.temp, 'Earlier project');
  await mkdir(previous);
  await writeFile(path.join(previous, 'main.tex'), 'Earlier document');
  const previousMeta = await json(session, '/api/project/open', { method: 'POST', data: { path: previous } });
  const previousRoot = previousMeta.project.root;
  await json(session, '/api/storage', { method: 'PUT', data: {
    key: `drafts:${previousRoot}`, value: { entries: [{ path: 'saved-draft.md', content: 'Earlier draft' }] },
  } });
  const meta = await openProject(session);
  const root = meta.project.root;
  await openEditor(page, session);
  await setAutoSave(page, false);
  const currentText = '% Keep editing the current document';
  await replaceSource(page, currentText);
  await openHome(page);
  await inspectDeletion(page, previousRoot);
  await expect(page.locator('#project-delete-drafts')).toContainText('saved-draft.md');
  await expect(page.locator('#project-delete-unsaved')).toBeHidden();
  await confirmDeletion(page, previousRoot);
  await expect(page.locator('#project-delete-dialog')).toBeHidden();
  await expect(card(page, previousRoot)).toHaveCount(0);
  expect(await exists(previousRoot)).toBe(false);
  expect((await json(session, '/api/state')).project.root).toBe(root);
  expect((await json(session, storageURL('drafts', previousRoot))).value).toBeNull();
  expect((await json(session, storageURL('drafts', root))).value.entries.some(entry => entry.content === currentText)).toBe(true);
  await card(page, root).locator('[data-action="resume"]').click();
  await expect(source(page)).toHaveText(currentText);
});

test('ホームで Markdown の草稿を開くと，直接編集で保存したカーソル位置へ戻る', async ({ page, session }) => {
  const text = '# Recovered notes\n\n' + Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1} of the recovered manuscript.\n\n`).join('');
  await writeFile(path.join(session.project, 'notes.md'), '# Notes on disk\n');
  const meta = await openProject(session);
  const root = meta.project.root;
  const file = await json(session, '/api/file?path=notes.md');
  const position = text.indexOf('Paragraph 96');
  await json(session, '/api/storage', { method: 'PUT', data: {
    key: `drafts:${root}`, value: { version: 1, entries: [{
      id: 'recover-markdown-from-home', path: 'notes.md', content: text,
      baseRevision: file.revision, updatedAt: Date.now(), selection: { anchor: position, head: position },
    }] },
  } });
  await openEditor(page, session);
  await setAutoSave(page, false);
  await openHome(page);
  await page.locator('#review-drafts').click();
  await expect(page.locator('#recovery-draft')).toHaveValue(text);
  await page.locator('#restore-draft').click();
  await expect(page.locator('#recovery-dialog')).toBeHidden();
  await expect(page.locator('#welcome')).toBeHidden();
  await expect(page.locator('#markdown-rich-primary .ProseMirror')).toBeVisible();
  await expect(page.locator('#markdown-rich-primary .ProseMirror p').filter({ hasText: 'Paragraph 96 ' })).toBeInViewport();
  await page.keyboard.insertText('Resumed here. ');
  await expect(page.locator('#markdown-rich-primary .ProseMirror p').filter({ hasText: 'Paragraph 96 ' })).toHaveText('Resumed here. Paragraph 96 of the recovered manuscript.');
});

test('外部で移動した最近のプロジェクトを表示し，原稿と草稿を残して一覧から外す', async ({ page, session }) => {
  const previous = path.join(session.temp, 'Project moved outside the app');
  await mkdir(previous);
  await writeFile(path.join(previous, 'notes.md'), '# Keep the moved document\n');
  const prior = await json(session, '/api/project/open', { method: 'POST', data: { path: previous } });
  const previousRoot = prior.project.root;
  await json(session, '/api/storage', { method: 'PUT', data: {
    key: `drafts:${previousRoot}`, value: { entries: [{ path: 'notes.md', content: '# Keep the saved draft\n' }] },
  } });
  const current = await openProject(session);
  await openEditor(page, session);
  const moved = previousRoot + ' moved';
  await rename(previousRoot, moved);
  await openHome(page);
  const previousCard = card(page, previousRoot);
  await expect(previousCard).toHaveAttribute('data-project-status', 'missing');
  await expect(previousCard).toContainText('Folder not found');
  await expect(previousCard.locator('[data-action="open"]')).toBeDisabled();
  await expect(previousCard.locator('[data-action="delete"]')).toBeDisabled();
  await previousCard.locator('[data-action="forget"]').click();
  await expect(previousCard).toHaveCount(0);
  expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# Keep the moved document\n');
  expect((await json(session, storageURL('drafts', previousRoot))).value.entries[0].content).toBe('# Keep the saved draft\n');
  expect((await json(session, '/api/state')).project.root).toBe(current.project.root);
  await page.reload();
  await openHome(page);
  await expect(card(page, previousRoot)).toHaveCount(0);
});

test('現在のフォルダーの移動を再確認し，本文を編集したまま元の場所で保存を再開する', async ({ page, session }) => {
  const opened = await openProject(session);
  const root = opened.project.root, moved = root + ' moved';
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  await openEditor(page, session);
  await setAutoSave(page, false);
  const text = '% Work remains in the editor while the folder is unavailable';
  await replaceSource(page, text);
  await openHome(page);
  await rename(root, moved);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const current = card(page, root);
  await expect(current).toHaveAttribute('data-project-status', 'missing');
  await expect(current.locator('[data-action="delete"]')).toBeDisabled();
  await current.locator('[data-action="resume"]').click();
  await expect(source(page)).toHaveText(text);
  await expect(page.locator('#save-button')).toBeDisabled();
  await expect(page.locator('#compile-button')).toBeDisabled();
  await source(page).click();
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.insertText('\n% Continued while disconnected');
  const edited = text + '\n% Continued while disconnected';
  await expect(source(page)).toHaveText(edited);
  await openHome(page);
  expect(await exists(root)).toBe(false);
  expect(await readFile(path.join(moved, 'main.tex'), 'utf8')).toBe(original);
  await expect.poll(async () => (await json(session, storageURL('drafts', root))).value?.entries.some(entry => entry.content === edited)).toBe(true);
  await rename(moved, root);
  await current.locator('[data-action="refresh"]').click();
  await expect(current).toHaveAttribute('data-project-status', 'available');
  await expect(current.locator('[data-action="delete"]')).toBeEnabled();
  await current.locator('[data-action="resume"]').click();
  await expect(source(page)).toHaveText(edited);
  await expect(page.locator('#save-button')).toBeEnabled();
  await page.locator('#save-button').click();
  await expect.poll(() => readFile(path.join(root, 'main.tex'), 'utf8')).toBe(edited);
});
