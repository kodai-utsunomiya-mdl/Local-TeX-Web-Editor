import { expect } from '@playwright/test';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const menu = page => page.locator('#file-context-menu');
const dialog = page => page.locator('#file-action-dialog');
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function edit(page, text) {
  await source(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
}
async function action(page, target, name) {
  await target.click({ button: 'right' }); await expect(menu(page)).toBeVisible();
  await menu(page).locator(`[data-action="${name}"]`).click();
}
async function submitPath(page, value) {
  await expect(dialog(page)).toBeVisible(); await page.locator('#file-action-path').fill(value); await page.locator('#file-action-submit').click();
  await expect(dialog(page)).not.toBeVisible();
}

export function registerFileOperationTests({ test, openProject, openEditor, setAutoSave, json }) {
  test('外部で削除されたファイルの未保存タブがある場合は同名の作成と名前変更を止める', async ({ page, session }) => {
    await writeFile(path.join(session.project, 'source.py'), 'print("source")\n');
    await writeFile(path.join(session.project, 'working.py'), 'print("saved")\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-working.py').click(); await edit(page, 'print("unsaved")\n');
    await unlink(path.join(session.project, 'working.py'));
    await action(page, page.getByTestId('file-source.py'), 'rename');
    await page.locator('#file-action-path').fill('working.py'); await page.locator('#file-action-submit').click();
    await expect(dialog(page).locator('.form-error')).toContainText('未保存の草稿');
    await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
    await expect(source(page)).toContainText('unsaved');
    expect(await readFile(path.join(session.project, 'source.py'), 'utf8')).toBe('print("source")\n');
    expect(await exists(path.join(session.project, 'working.py'))).toBe(false);
    await page.locator('#new-file').click(); await page.locator('#new-file-path').fill('working.py');
    await page.locator('#new-file-form button[type="submit"]').click();
    await expect(page.locator('#new-file-error')).toContainText('未保存の草稿');
    await page.locator('#new-file-dialog [data-close-dialog="new-file-dialog"]').last().click();
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).toContainText('saved');
    expect(await exists(path.join(session.project, 'working.py'))).toBe(false);
  });

  test('Python の未保存の本文を名前の変更後も編集し，Undo と保存を使える', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const original = '# Python の例\ndef square(value):\n    return value ** 2\n';
    const edited = '# 編集後\nprint(square(3))\n';
    await writeFile(path.join(session.project, 'analysis.py'), original);
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-analysis.py').click(); await expect(source(page)).toContainText('def square');
    await edit(page, edited);
    await action(page, page.getByTestId('file-analysis.py'), 'rename'); await submitPath(page, 'analysis-renamed.py');
    await expect(page.getByTestId('file-analysis.py')).toHaveCount(0);
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'analysis-renamed.py');
    await expect(source(page)).toContainText('print(square(3))');
    expect(await readFile(path.join(session.project, 'analysis-renamed.py'), 'utf8')).toBe(original);
    expect(await exists(path.join(session.project, 'analysis.py'))).toBe(false);
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).toContainText('def square');
    await page.keyboard.press(modifier === 'Meta' ? 'Meta+Shift+z' : 'Control+y'); await expect(source(page)).toContainText('print(square(3))');
    await page.keyboard.press(`${modifier}+s`);
    await expect.poll(() => readFile(path.join(session.project, 'analysis-renamed.py'), 'utf8')).toBe(edited);
    const root = (await json(session, '/api/state')).project.root;
    await expect.poll(async () => (await json(session, `/api/storage?key=${encodeURIComponent(`session:${root}`)}`)).value?.tabs).toContain('analysis-renamed.py');
    expect((await json(session, `/api/storage?key=${encodeURIComponent(`session:${root}`)}`)).value.tabs).not.toContain('analysis.py');
    await page.screenshot({ path: testInfo.outputPath('program-file-after-rename.png') });
    await page.reload(); await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'analysis-renamed.py');
    await expect(source(page)).toContainText('print(square(3))'); expect(errors).toEqual([]);
  });

  test('キーボードのメニューでフォルダーと原稿を作成し，パスをコピーして名前を変更する', async ({ page, session }, testInfo) => {
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.evaluate(() => { window.copiedProjectPaths = []; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async value => { window.copiedProjectPaths.push(value); } }); });
    await page.locator('#file-tree').focus(); await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible(); await expect(menu(page).locator('[data-action="newFile"]')).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await submitPath(page, 'drafts');
    const summary = () => page.locator('.tree-directory[data-path="drafts"] > summary');
    await action(page, summary(), 'newFile');
    await expect(page.locator('#new-file-path')).toHaveValue('drafts/');
    await page.locator('#new-file-path').fill('drafts/readme.md'); await page.locator('#new-file-form button[type="submit"]').click();
    await expect(page.locator('#new-file-dialog')).not.toBeVisible();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'drafts/readme.md');
    await edit(page, '# Notes\nUnsaved text.\n');
    await action(page, page.getByTestId('file-drafts/readme.md'), 'relative');
    await expect.poll(() => page.evaluate(() => window.copiedProjectPaths.at(-1))).toBe('drafts/readme.md');
    await action(page, page.getByTestId('file-drafts/readme.md'), 'absolute');
    expect(await page.evaluate(() => window.copiedProjectPaths.at(-1))).toMatch(/[\\/]drafts[\\/]readme\.md$/);
    await summary().focus(); await page.keyboard.press('F2'); await submitPath(page, 'notes');
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'notes/readme.md');
    await expect(source(page)).toContainText('Unsaved text.');
    await source(page).click(); await page.keyboard.press(`${modifier}+s`);
    await expect.poll(() => readFile(path.join(session.project, 'notes', 'readme.md'), 'utf8')).toBe('# Notes\nUnsaved text.\n');
    await action(page, page.locator('.tree-directory[data-path="notes"] > summary'), 'remove');
    await page.locator('#file-action-submit').click(); await expect(dialog(page).locator('.form-error')).toBeVisible();
    // Read the next control before the browser delivers the queued close event.
    const afterCancel = await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).evaluate(button => {
      button.click();
      return {
        dialogOpen: document.getElementById('file-action-dialog').open,
        nextFileDisabled: document.querySelector('[data-testid="file-notes/readme.md"]').disabled,
      };
    });
    expect(afterCancel).toEqual({ dialogOpen: false, nextFileDisabled: false });
    await page.getByTestId('file-notes/readme.md').focus(); await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible(); await expect(menu(page).locator('[data-action="newFile"]')).toBeFocused();
    await page.keyboard.press('End'); await expect(menu(page).locator('[data-action="remove"]')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('file-context-menu-keyboard.png') });
    await page.keyboard.press('Escape'); await expect(menu(page)).not.toBeVisible();
    await expect(page.getByTestId('file-notes/readme.md')).toBeFocused();
    await page.keyboard.press('Delete'); await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog(page)).not.toBeVisible();
    await expect(page.getByTestId('file-notes/readme.md')).toBeFocused();
    await expect(page.getByTestId('file-notes/readme.md')).toBeEnabled();
  });

  test('削除には未保存の本文の確認があり，キャンセル時はファイルと本文が残る', async ({ page, session }) => {
    await mkdir(path.join(session.project, 'remove-me'));
    await writeFile(path.join(session.project, 'remove-me', 'draft.md'), '# Saved\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.locator('.tree-directory[data-path="remove-me"] > summary').click();
    await page.getByTestId('file-remove-me/draft.md').click(); await edit(page, '# Unsaved\n');
    await page.getByTestId('file-remove-me/draft.md').focus(); await page.keyboard.press('Delete');
    await expect(dialog(page).locator('.file-action-unsaved')).toContainText('remove-me/draft.md');
    await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect(await exists(path.join(session.project, 'remove-me', 'draft.md'))).toBe(true);
    await expect(source(page)).toContainText('Unsaved');
    await action(page, page.getByTestId('file-remove-me/draft.md'), 'remove'); await page.locator('#file-action-submit').click();
    await expect(dialog(page)).not.toBeVisible();
    await expect(page.getByTestId('file-remove-me/draft.md')).toHaveCount(0);
    await expect(page.locator('#editor-tabs .tab-select[data-path="remove-me/draft.md"]')).toHaveCount(0);
    expect(await exists(path.join(session.project, 'remove-me', 'draft.md'))).toBe(false);
    await action(page, page.locator('.tree-directory[data-path="remove-me"] > summary'), 'remove'); await page.locator('#file-action-submit').click();
    await expect(dialog(page)).not.toBeVisible(); expect(await exists(path.join(session.project, 'remove-me'))).toBe(false);
    await page.reload(); await expect(page.getByTestId('file-remove-me/draft.md')).toHaveCount(0);
    await expect(page.locator('#recovery-banner')).not.toBeVisible();
  });

  test('名前の変更の確認中にファイルが更新された場合はその内容を変更しない', async ({ page, session }) => {
    await writeFile(path.join(session.project, 'external.py'), 'print("before")\n');
    await openProject(session); await openEditor(page, session);
    await action(page, page.getByTestId('file-external.py'), 'rename'); await expect(dialog(page)).toBeVisible();
    await writeFile(path.join(session.project, 'external.py'), 'print("external")\n');
    await page.locator('#file-action-path').fill('renamed.py'); await page.locator('#file-action-submit').click();
    await expect(dialog(page).locator('.form-error')).toBeVisible();
    expect(await readFile(path.join(session.project, 'external.py'), 'utf8')).toBe('print("external")\n');
    expect(await exists(path.join(session.project, 'renamed.py'))).toBe(false);
    await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  });
}
