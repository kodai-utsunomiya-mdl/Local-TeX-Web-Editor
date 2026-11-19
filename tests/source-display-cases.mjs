import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { showPDFControls } from './pdf-controls.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

export function registerSourceDisplayTests({ test, openProject, openEditor, compileFromUI, exampleFigurePDF }) {
  test('折りたたんだ原稿をアウトラインや PDF から開き，見出しの階層を操作する', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const lines = Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1}.`);
    lines[0] = '\\section{Introduction}';
    lines[35] = '\\subsection{Background}';
    lines[80] = '\\subsubsection{Details}';
    lines[170] = '\\section{Results}';
    await writeFile(path.join(session.project, 'folding.tex'), lines.join('\n'));
    await openProject(session); await openEditor(page, session);
    const { finished } = await compileFromUI(page, session);
    expect(finished.status, finished.log).toBe('success');
    await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('file-folding.tex').click();
    await page.getByTestId('outline-tab').click();
    const outline = page.locator('#outline-tree');
    const heading = name => outline.locator('.outline-link').filter({ has: page.locator('.outline-title', { hasText: name }) });
    const disclosure = heading('Introduction').locator('..').locator('.outline-toggle');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const guide = outline.locator('.outline-item > .outline-level').first();
    await expect(guide).toHaveCSS('border-left-width', '1px');
    await disclosure.click();
    await expect(heading('Details')).not.toBeVisible();
    await disclosure.click();
    await expect(heading('Details')).toBeVisible();

    const editor = page.getByTestId('editor').locator('.cm-content');
    const foldAll = async () => {
      await editor.click(); await page.keyboard.press(`${modifier}+Home`);
      await page.keyboard.press('Control+Alt+[');
      await expect(page.locator('#editor .cm-foldPlaceholder').first()).toBeVisible();
      await expect(editor).not.toContainText('Paragraph 120.');
    };
    await foldAll();
    await heading('Details').click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-line', '81');
    await expect(editor).toContainText('\\subsubsection{Details}');
    const destinationOffset = () => page.locator('#editor .synctex-line').evaluate(node => node.getBoundingClientRect().top - node.closest('.cm-scroller').getBoundingClientRect().top);
    await expect.poll(destinationOffset).toBeGreaterThan(25);
    await expect.poll(destinationOffset).toBeLessThan(105);

    await foldAll();
    await page.route('**/api/synctex/inverse', route => route.fulfill({ json: { path: 'folding.tex', line: 120, column: 1 } }));
    await page.locator('#pdf-stage .textLayer').first().dblclick({ position: { x: 100, y: 100 } });
    await expect(page.getByTestId('editor')).toHaveAttribute('data-line', '120');
    await expect(editor).toContainText('Paragraph 120.');
    await expect.poll(destinationOffset).toBeGreaterThan(25);
    await expect.poll(destinationOffset).toBeLessThan(105);
    await page.screenshot({ path: testInfo.outputPath('folding-and-outline.png') });
    expect(errors).toEqual([]);
  });

  test('PDF の暗い配色を保存し，コンパイルした PDF と取り込んだ PDF に反映する', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const original = exampleFigurePDF();
    await writeFile(path.join(session.project, 'figure.pdf'), original);
    await openProject(session); await openEditor(page, session);
    const { finished } = await compileFromUI(page, session);
    expect(finished.status, finished.log).toBe('success');
    const toggle = page.locator('#pdf-dark-mode');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await showPDFControls(page);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pdf-scroll')).toHaveAttribute('data-pdf-theme', 'dark');
    await page.getByTestId('file-figure.pdf').click();
    const assetToggle = page.locator('#asset-dark-mode');
    await expect(assetToggle).toBeEnabled();
    await expect(assetToggle).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByTestId('file-figure.pdf')).toBeVisible();
    await page.getByTestId('file-figure.pdf').click();
    await expect(assetToggle).toBeEnabled();
    await expect(assetToggle).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('pdf-dark-view.png') });
    await showPDFControls(page, 'asset');
    await assetToggle.click();
    await expect(assetToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await readFile(path.join(session.project, 'figure.pdf'))).toEqual(original);
    expect(errors).toEqual([]);
  });
}
