import { expect } from '@playwright/test';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
async function tool(page, id) {
  await page.locator('#writing-menu > summary').click();
  await page.locator(`#${id}`).click();
}

export function registerDocumentToolsTests({ test, openProject, openEditor, setAutoSave, exampleFigurePDF }) {
  test('Markdown のページを作成して元の原稿にリンクを挿入し，Undo で戻せる', async ({ page, session }) => {
    await mkdir(path.join(session.project, 'notes'), { recursive: true });
    await writeFile(path.join(session.project, 'current.md'), '# Current\n\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-current.md').click();
    await page.locator('#markdown-editor-mode').selectOption('source');
    await source(page).click(); await page.keyboard.press(`${modifier}+End`);
    await tool(page, 'markdown-new-page');
    await page.locator('#markdown-page-title').fill('Next [chapter]');
    await page.locator('#markdown-page-path').fill('notes/Next #1.md');
    await page.locator('#markdown-page-open').uncheck();
    await page.locator('#markdown-page-confirm').click();
    await expect(page.locator('#markdown-page-dialog')).not.toBeVisible();
    await expect(source(page)).toContainText('[Next \\[chapter\\]](notes/Next%20%231.md)');
    expect(await readFile(path.join(session.project, 'notes/Next #1.md'), 'utf8')).toBe('# Next \\[chapter\\]\n\n');
    expect(await readFile(path.join(session.project, 'current.md'), 'utf8')).toBe('# Current\n\n');
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect.poll(async () => (await source(page).locator('.cm-line').allTextContents()).join('\n')).toBe('# Current\n\n');
    await tool(page, 'markdown-new-page');
    await page.locator('#markdown-page-title').fill('Another title');
    await page.locator('#markdown-page-path').fill('notes/Next #1.md');
    await page.locator('#markdown-page-confirm').click();
    await expect(page.locator('#markdown-page-dialog .form-error')).toBeVisible();
    expect(await readFile(path.join(session.project, 'notes/Next #1.md'), 'utf8')).toBe('# Next \\[chapter\\]\n\n');
  });

  test('新しい Markdown ページはディスクから消えた未保存タブの本文を置き換えない', async ({ page, session }) => {
    await writeFile(path.join(session.project, 'current.md'), '# Current\n');
    await writeFile(path.join(session.project, 'occupied.md'), '# Saved\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-occupied.md').click();
    await page.locator('#markdown-editor-mode').selectOption('source');
    await source(page).click(); await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.insertText('# Unsaved work\n');
    await unlink(path.join(session.project, 'occupied.md'));
    await page.getByTestId('file-current.md').click();
    await tool(page, 'markdown-new-page');
    await page.locator('#markdown-page-title').fill('New page');
    await page.locator('#markdown-page-path').fill('occupied.md');
    await page.locator('#markdown-page-confirm').click();
    await expect(page.locator('#markdown-page-dialog .form-error')).toBeVisible();
    await expect.poll(() => readFile(path.join(session.project, 'occupied.md'), 'utf8').then(() => 'created', error => error.code)).toBe('ENOENT');
    await page.keyboard.press('Escape');
    await page.locator('#editor-tabs .tab-select[data-path="occupied.md"]').click();
    await expect(source(page)).toContainText('# Unsaved work');
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).toContainText('# Saved');
  });

  test('プロジェクトで開いた PDF の文字を TXT として保存する', async ({ page, session }) => {
    await writeFile(path.join(session.project, 'figure.pdf'), exampleFigurePDF());
    await openProject(session); await openEditor(page, session);
    await page.getByTestId('file-figure.pdf').click();
    await expect(page.locator('#asset-preview')).toHaveAttribute('data-state', 'ready');
    await tool(page, 'pdf-export-text');
    await expect(page.locator('#pdf-text-download')).toBeEnabled();
    const promise = page.waitForEvent('download');
    await page.locator('#pdf-text-download').click();
    const download = await promise;
    expect(download.suggestedFilename()).toBe('figure.txt');
    expect(await readFile(await download.path(), 'utf8')).toBe('Figure PDF\n');
  });
}
