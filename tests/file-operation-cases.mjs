import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
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
    await page.locator('#markdown-editor-mode').selectOption('source');
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
    await expect(dialog(page).locator('.file-action-contents')).toContainText('notes/readme.md');
    await expect(dialog(page).locator('.file-action-counts')).toHaveText('ファイル 1 個，フォルダー 0 個');
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
    await page.getByTestId('file-remove-me/draft.md').click();
    await page.locator('#markdown-editor-mode').selectOption('source');
    await edit(page, '# Unsaved\n');
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

  test('フォルダー内の項目と未保存の原稿を確認してから，フォルダーごと削除する', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const folder = path.join(session.project, 'remove-folder');
    await mkdir(path.join(folder, 'nested', 'empty'), { recursive: true });
    await writeFile(path.join(folder, 'first.md'), '# Saved note\n');
    await writeFile(path.join(folder, 'nested', 'second.tex'), 'Saved chapter.\n');
    await writeFile(path.join(folder, 'nested', 'image.bin'), Buffer.from([0, 1, 2]));
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    const summary = page.locator('.tree-directory[data-path="remove-folder"] > summary');
    await summary.click();
    await page.getByTestId('file-remove-folder/first.md').click();
    await page.locator('#markdown-editor-mode').selectOption('source');
    await edit(page, '# Unsaved note\n');
    await page.locator('.tree-directory[data-path="remove-folder/nested"] > summary').click();
    await page.getByTestId('file-remove-folder/nested/second.tex').click();
    await edit(page, 'Unsaved chapter.\n');
    await summary.focus(); await page.keyboard.press('Delete');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).locator('.file-action-current')).toHaveText('remove-folder');
    await expect(dialog(page).locator('.file-action-counts')).toHaveText('ファイル 3 個，フォルダー 2 個');
    await expect(dialog(page).locator('.file-action-contents li')).toHaveText([
      'remove-folder/first.md', 'remove-folder/nested/', 'remove-folder/nested/empty/',
      'remove-folder/nested/image.bin', 'remove-folder/nested/second.tex',
    ]);
    await expect(dialog(page).locator('.file-action-unsaved')).toContainText('remove-folder/first.md');
    await expect(dialog(page).locator('.file-action-unsaved')).toContainText('remove-folder/nested/second.tex');
    await page.screenshot({ path: testInfo.outputPath('folder-delete-confirmation.png') });
    await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect(await readFile(path.join(folder, 'first.md'), 'utf8')).toBe('# Saved note\n');
    expect(await readFile(path.join(folder, 'nested', 'second.tex'), 'utf8')).toBe('Saved chapter.\n');
    await expect(source(page)).toContainText('Unsaved chapter.');
    await action(page, summary, 'remove'); await page.locator('#file-action-submit').click();
    await expect(dialog(page)).not.toBeVisible();
    await expect(page.locator('.tree-directory[data-path="remove-folder"]')).toHaveCount(0);
    await expect(page.locator('#editor-tabs .tab-select[data-path^="remove-folder/"]')).toHaveCount(0);
    expect(await exists(folder)).toBe(false);
    expect(await exists(path.join(session.project, 'main.tex'))).toBe(true);
    await page.reload(); await expect(page.locator('.tree-directory[data-path="remove-folder"]')).toHaveCount(0);
    await expect(page.locator('#recovery-banner')).not.toBeVisible(); expect(errors).toEqual([]);
  });

  test('確認後にフォルダーへ追加された項目を表示し，もう一度確定するまで削除しない', async ({ page, session }) => {
    const folder = path.join(session.project, 'review-folder');
    await mkdir(folder); await writeFile(path.join(folder, 'first.py'), 'print("first")\n');
    await openProject(session); await openEditor(page, session);
    await action(page, page.locator('.tree-directory[data-path="review-folder"] > summary'), 'remove');
    await expect(dialog(page).locator('.file-action-counts')).toHaveText('ファイル 1 個，フォルダー 0 個');
    await writeFile(path.join(folder, 'new.md'), '# Added after confirmation\n');
    const response = page.waitForResponse(response => response.url().endsWith('/api/entry') && response.request().method() === 'DELETE');
    await page.locator('#file-action-submit').click(); expect((await response).status()).toBe(409);
    await expect(dialog(page).locator('.form-error')).toBeVisible();
    await expect(dialog(page).locator('.file-action-counts')).toHaveText('ファイル 2 個，フォルダー 0 個');
    await expect(dialog(page).locator('.file-action-contents li')).toHaveText(['review-folder/first.py', 'review-folder/new.md']);
    await expect(dialog(page).getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused();
    expect(await exists(path.join(folder, 'first.py'))).toBe(true);
    expect(await readFile(path.join(folder, 'new.md'), 'utf8')).toBe('# Added after confirmation\n');
    await page.locator('#file-action-submit').click(); await expect(dialog(page)).not.toBeVisible();
    expect(await exists(folder)).toBe(false);
  });

  test('フォルダー内で外部から消された原稿の未保存の本文も削除前に確認できる', async ({ page, session }) => {
    const folder = path.join(session.project, 'missing-note');
    await mkdir(folder); await writeFile(path.join(folder, 'draft.py'), 'print("saved")\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.locator('.tree-directory[data-path="missing-note"] > summary').click();
    await page.getByTestId('file-missing-note/draft.py').click(); await edit(page, 'print("unsaved")\n');
    await unlink(path.join(folder, 'draft.py'));
    await action(page, page.locator('.tree-directory[data-path="missing-note"] > summary'), 'remove');
    await expect(dialog(page).locator('.file-action-counts')).toHaveText('このフォルダーは空です．');
    await expect(dialog(page).locator('.file-action-unsaved')).toContainText('missing-note/draft.py');
    await page.locator('#file-action-submit').click(); await expect(dialog(page)).not.toBeVisible();
    await expect(page.locator('#editor-tabs .tab-select[data-path="missing-note/draft.py"]')).toHaveCount(0);
    expect(await exists(folder)).toBe(false);
    await page.reload(); await expect(page.locator('#recovery-banner')).not.toBeVisible();
  });

  test('コンピューターのファイルを複数選び，選んだフォルダーへ元のファイルを変えずに追加する', async ({ page, session }) => {
    const originalFolder = path.join(session.temp, 'computer-files');
    const destination = path.join(session.project, 'copies');
    await mkdir(originalFolder); await mkdir(destination);
    const note = path.join(originalFolder, 'notes.md'), image = path.join(originalFolder, 'image.png');
    const originalNote = '\ufeff# Notes\r\n日本語の本文．\r\n';
    const originalImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nS8AAAAASUVORK5CYII=', 'base64');
    await writeFile(note, originalNote); await writeFile(image, originalImage);
    await openProject(session); await openEditor(page, session);
    const importDialog = page.locator('#file-import-dialog');
    let chooser = page.waitForEvent('filechooser'); await page.locator('#import-files').click();
    await (await chooser).setFiles([]); await expect(importDialog).not.toBeVisible();
    await expect(page.locator('#import-files')).toBeEnabled();
    const summary = page.locator('.tree-directory[data-path="copies"] > summary');
    chooser = page.waitForEvent('filechooser'); await action(page, summary, 'importFiles');
    await (await chooser).setFiles([note, image]);
    await expect(importDialog).toBeVisible(); await expect(page.locator('#file-import-folder')).toHaveValue('copies');
    await expect(page.locator('#file-import-list > li')).toHaveCount(2);
    await expect(page.locator('#file-import-confirm')).toBeEnabled();
    await importDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect(await readdir(destination)).toEqual([]); await expect(summary).toBeFocused();
    chooser = page.waitForEvent('filechooser'); await action(page, summary, 'importFiles');
    await (await chooser).setFiles([note, image]);
    await expect(page.locator('#file-import-confirm')).toBeEnabled();
    await page.locator('#file-import-path-0').fill('copies/renamed-notes.md'); await page.locator('#file-import-path-0').press('Tab');
    await expect(page.locator('#file-import-confirm')).toBeEnabled();
    await page.locator('#file-import-confirm').click(); await expect(importDialog).not.toBeVisible();
    expect(await readFile(path.join(destination, 'renamed-notes.md'), 'utf8')).toBe(originalNote);
    expect(await readFile(path.join(destination, 'image.png'))).toEqual(originalImage);
    expect(await readFile(note, 'utf8')).toBe(originalNote); expect(await readFile(image)).toEqual(originalImage);
    await expect(page.locator('.tree-directory[data-path="copies"] > summary')).toBeFocused();
  });

  test('同名のファイルの置換を選び，コピー先が変わった場合は再確認して別名も選べる', async ({ page, session }) => {
    const original = path.join(session.temp, 'figure.png');
    const destination = path.join(session.project, 'figure.png');
    await writeFile(original, Buffer.from([0, 1, 2, 255])); await writeFile(destination, 'existing image');
    await openProject(session); await openEditor(page, session);
    const importDialog = page.locator('#file-import-dialog');
    let chooser = page.waitForEvent('filechooser'); await page.locator('#import-files').click(); await (await chooser).setFiles(original);
    await expect(page.locator('#file-import-action-0')).toBeEnabled();
    await expect(page.locator('#file-import-action-0')).toHaveValue(''); await expect(page.locator('#file-import-confirm')).toBeDisabled();
    await page.locator('#file-import-action-0').selectOption('replace');
    await writeFile(destination, 'changed outside the editor');
    const conflict = page.waitForResponse(response => response.url().includes('/api/files/import?') && response.request().method() === 'POST');
    await page.locator('#file-import-confirm').click(); expect((await conflict).status()).toBe(409);
    await expect(page.locator('#file-import-action-0')).toHaveValue('');
    await expect(importDialog.locator('> .form-error')).toBeVisible();
    expect(await readFile(destination, 'utf8')).toBe('changed outside the editor');
    await page.locator('#file-import-action-0').selectOption('copy');
    await expect(page.locator('#file-import-path-0')).toHaveValue('figure-2.png');
    await expect(page.locator('#file-import-confirm')).toBeEnabled(); await page.locator('#file-import-confirm').click();
    await expect(importDialog).not.toBeVisible();
    expect(await readFile(path.join(session.project, 'figure-2.png'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(destination, 'utf8')).toBe('changed outside the editor');
    chooser = page.waitForEvent('filechooser'); await page.locator('#import-files').click(); await (await chooser).setFiles(original);
    await expect(page.locator('#file-import-action-0')).toBeEnabled(); await page.locator('#file-import-action-0').selectOption('replace');
    await page.locator('#file-import-confirm').click(); await expect(importDialog).not.toBeVisible();
    expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(original)).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  test('停止する直前にコピーが完了した場合も一覧を更新し，応答がない行はもう一度確認する', async ({ page, session }) => {
    await openProject(session); await openEditor(page, session);
    let notifyCopied, releaseResponse;
    const copied = new Promise(resolve => { notifyCopied = resolve; });
    const release = new Promise(resolve => { releaseResponse = resolve; });
    await page.route('**/api/files/import?*', async route => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).searchParams.get('path') === 'second.md') {
        const response = await route.fetch(); expect(response.status()).toBe(201);
        notifyCopied(); await release; await route.abort('aborted').catch(() => {});
      } else await route.continue();
    });
    const chooser = page.waitForEvent('filechooser'); await page.locator('#import-files').click();
    await (await chooser).setFiles([
      { name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from('# First\n') },
      { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('# Second\n') },
    ]);
    await expect(page.locator('#file-import-confirm')).toBeEnabled(); await page.locator('#file-import-confirm').click();
    await copied;
    await page.locator('#file-import-dialog .dialog-actions').getByRole('button', { name: '停止', exact: true }).click(); releaseResponse();
    await expect(page.locator('#file-import-progress')).toContainText('処理を停止しました．追加済み: 1 / 2 個');
    await expect(page.locator('#file-import-action-1')).toBeEnabled(); await expect(page.locator('#file-import-action-1')).toHaveValue('');
    await expect(page.getByTestId('file-first.md')).toBeVisible(); await expect(page.getByTestId('file-second.md')).toBeVisible();
    expect(await readFile(path.join(session.project, 'first.md'), 'utf8')).toBe('# First\n');
    expect(await readFile(path.join(session.project, 'second.md'), 'utf8')).toBe('# Second\n');
    await page.locator('#file-import-dialog .dialog-actions').getByRole('button', { name: '閉じる', exact: true }).click();
    await expect(page.locator('#file-import-dialog')).not.toBeVisible(); await expect(page.locator('#import-files')).toBeFocused();
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
