import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const editor = page => page.getByTestId('editor').locator('.cm-content');

async function replaceText(page, text) {
  await editor(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
  await expect(page.getByTestId('draft-status')).toHaveAttribute('data-status', 'saved');
}

async function completion(page, text) {
  await editor(page).click(); await page.keyboard.press(`${modifier}+End`); await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Space');
}

test('本文を編集した後も文献を補完でき，文献とラベルの変更を候補へ反映する', async ({ page, session }) => {
  await writeFile(path.join(session.project, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{Original}\\label{section:old}\n\\end{document}\n');
  await writeFile(path.join(session.project, 'references.bib'), '@article{old2026, title={Original title}, author={Old author}, year=2026}\n');
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await replaceText(page, '\\section{Edited}\\label{section:new}\n本文を編集した．\n');
  await completion(page, '\\cite{old');
  await expect(page.getByRole('option', { name: /old2026/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await completion(page, '}\n\\ref{section:');
  await expect(page.getByRole('option', { name: /section:new/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /section:old/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('file-references.bib').click();
  await replaceText(page, '@article{new2027, title={Updated title}, author={New author}, year=2027}\n');
  await page.getByTestId('file-main.tex').click();
  await completion(page, '}\n\\cite{new');
  await expect(page.getByRole('option', { name: /new2027/ })).toContainText('New author');
  await expect(page.getByRole('option', { name: /new2027/ })).toContainText('2027');
  await expect(page.getByRole('option', { name: /old2026/ })).toHaveCount(0);
  await expect(page.locator('#app-error')).toBeHidden();
});
