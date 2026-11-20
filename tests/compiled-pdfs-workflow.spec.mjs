import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, json, request, waitUntil } from './editor-fixtures.mjs';
import { showPDFControls } from './pdf-controls.mjs';

const row = (page, main) => page.locator(`.compiled-pdf-button[data-compiled-main="${main}"]`);

async function compile(page, session, main) {
  await page.getByTestId(`file-${main}`).click();
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/build' && value.request().method() === 'POST');
  await page.getByTestId('compile-button').click();
  const started = await (await response).json();
  const finished = await waitUntil(() => json(session, '/api/build'), value => value.id === started.id && value.status !== 'running', 100_000, 'The TeX process did not finish.');
  expect(finished.status, `${finished.log}\n${finished.error}`).toBe('success');
  await expect(row(page, main)).toHaveAttribute('data-build-id', finished.pdfBuildId);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', finished.pdfBuildId);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  return finished;
}

async function menu(page, main, action) {
  await row(page, main).click({ button: 'right' });
  await page.locator(`.compiled-pdf-context-menu [data-action="${action}"]`).click();
}

test('文書ごとの PDF を選び，実際の名前で保存・コピーして，再起動後も選んだ文書を開ける', async ({ page, context, session }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const rc = await readFile(path.join(session.project, 'latexmkrc'), 'utf8');
  await writeFile(path.join(session.project, 'latexmkrc'), `${rc}\n$jobname = 'submission';\n`);
  for (const [main, text] of [['second.tex', 'Second document'], ['third.tex', 'Third document']]) {
    await writeFile(path.join(session.project, main), `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}\n`);
  }
  await openProject(session); await openEditor(page, session);
  const first = await compile(page, session, 'main.tex');
  const second = await compile(page, session, 'second.tex');
  const third = await compile(page, session, 'third.tex');
  await expect(page.locator('.compiled-pdf-button')).toHaveCount(3);
  for (const main of ['main.tex', 'second.tex', 'third.tex']) await expect(row(page, main).locator('.compiled-pdf-name')).toHaveText('submission.pdf');

  await row(page, 'main.tex').click();
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'third.tex');
  const refreshed = page.waitForResponse(value => new URL(value.url()).pathname === '/api/state');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await refreshed;
  await page.locator('#refresh-files').click();
  await expect(row(page, 'main.tex')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);
  await page.locator('#file-filter').fill('submission.pdf');
  await expect(page.locator('.compiled-pdf-button')).toHaveCount(3);
  await expect(page.locator('#file-tree .tree-empty')).toHaveCount(0);
  await page.locator('#file-filter').fill('second.tex');
  await expect(page.locator('.compiled-pdf-button')).toHaveCount(1);
  await page.locator('#file-filter').fill('');

  const downloaded = page.waitForEvent('download');
  await menu(page, 'second.tex', 'download');
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('submission.pdf');
  const downloadedPath = testInfo.outputPath('selected-document.pdf');
  await download.saveAs(downloadedPath);
  const secondBytes = Buffer.from(await (await request(session, `/api/pdf?build=${second.pdfBuildId}`)).arrayBuffer());
  expect(await readFile(downloadedPath)).toEqual(secondBytes);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);

  await menu(page, 'third.tex', 'copy');
  await expect(page.locator('#file-import-dialog')).toBeVisible();
  await expect(page.locator('#file-import-title')).toHaveText('PDF をプロジェクトへコピー');
  await page.locator('#file-import-confirm').click();
  await expect(page.locator('#file-import-dialog')).not.toBeVisible();
  await expect(page.getByTestId('file-submission.pdf')).toBeVisible();
  const thirdBytes = Buffer.from(await (await request(session, `/api/pdf?build=${third.pdfBuildId}`)).arrayBuffer());
  expect(await readFile(path.join(session.project, 'submission.pdf'))).toEqual(thirdBytes);
  await expect(page.locator('.compiled-pdf-button')).toHaveCount(3);
  await showPDFControls(page);
  await expect(page.getByTestId('pdf-name')).toHaveText('submission.pdf');
  await expect(page.getByTestId('pdf-document')).toHaveText('main.tex');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('compiled-pdf-file-list.png') });

  const key = `/api/storage?key=${encodeURIComponent(`session:${session.project}`)}`;
  await expect.poll(async () => (await json(session, key)).value?.pdf?.main).toBe('main.tex');
  await page.close(); await session.restart();
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 1600, height: 1000 });
  await openEditor(reopened, session);
  await expect(reopened.locator('.compiled-pdf-button')).toHaveCount(3);
  await expect(reopened.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);
  await expect(reopened.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(row(reopened, 'main.tex')).toHaveAttribute('aria-current', 'true');
  await expect(reopened.getByTestId('file-submission.pdf')).toBeVisible();
});
