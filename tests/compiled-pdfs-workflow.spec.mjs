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

test('文書ごとの PDF をダウンロード，保存，コピー，削除し，再起動と再コンパイルに反映する', async ({ page, context, session }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const rc = await readFile(path.join(session.project, 'latexmkrc'), 'utf8');
  await writeFile(path.join(session.project, 'latexmkrc'), `${rc}\n$jobname = 'submission';\n`);
  for (const [main, text] of [['second.tex', 'Second document'], ['third.tex', 'Third document']]) {
    await writeFile(path.join(session.project, main), `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}\n`);
  }
  const meta = await openProject(session); await openEditor(page, session);
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

  const savedBuilds = [];
  await page.route('**/api/file/save-as', async route => {
    savedBuilds.push(route.request().postDataJSON().buildId);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
  });
  await menu(page, 'second.tex', 'saveAs');
  await expect.poll(() => savedBuilds).toEqual([second.pdfBuildId]);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);
  await showPDFControls(page);
  await page.getByRole('button', { name: '名前を付けて保存…', exact: true }).click();
  await expect.poll(() => savedBuilds).toEqual([second.pdfBuildId, first.pdfBuildId]);
  await expect(page.locator('#pdf-menu')).toBeHidden();
  await page.unroute('**/api/file/save-as');

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

  const key = `/api/storage?key=${encodeURIComponent(`session:${meta.project.root}`)}`;
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

  const deletion = reopened.locator('#compiled-pdf-delete-dialog');
  await menu(reopened, 'third.tex', 'delete');
  await expect(deletion).toBeVisible();
  await expect(deletion.locator('.compiled-pdf-delete-name')).toHaveText('submission.pdf');
  await expect(deletion.locator('.compiled-pdf-delete-source')).toHaveText('コンパイル元: third.tex');
  await expect(deletion.getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused();
  await deletion.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(deletion).toBeHidden();
  expect((await request(session, `/api/pdf?build=${third.pdfBuildId}`)).ok).toBe(true);

  await menu(reopened, 'third.tex', 'delete');
  await deletion.locator('summary').click();
  await expect(deletion.locator('li').first()).toBeVisible();
  await reopened.screenshot({ path: testInfo.outputPath('delete-compiled-pdf.png') });
  await deletion.getByRole('button', { name: '削除', exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(row(reopened, 'third.tex')).toHaveCount(0);
  await expect(reopened.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', first.pdfBuildId);
  expect((await request(session, `/api/pdf?build=${third.pdfBuildId}`)).status).toBe(410);
  expect(await readFile(path.join(session.project, 'submission.pdf'))).toEqual(thirdBytes);
  await expect(reopened.getByTestId('file-third.tex')).toBeVisible();

  await menu(reopened, 'main.tex', 'delete');
  await deletion.getByRole('button', { name: '削除', exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(row(reopened, 'main.tex')).toHaveCount(0);
  await expect(reopened.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', second.pdfBuildId);
  await expect(reopened.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');

  const observer = await context.newPage(); await openEditor(observer, session);
  await expect(observer.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', second.pdfBuildId);
  await menu(reopened, 'second.tex', 'delete');
  await deletion.getByRole('button', { name: '削除', exact: true }).click();
  await expect(deletion).toBeHidden();
  await expect(reopened.locator('.compiled-pdf-button')).toHaveCount(0);
  await expect(reopened.locator('#pdf-empty')).toBeVisible();
  await observer.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(observer.locator('.compiled-pdf-button')).toHaveCount(0);
  await expect(observer.locator('#pdf-empty')).toBeVisible();
  await expect.poll(async () => (await json(session, key)).value?.pdf).toBe(null);
  await expect.poll(async () => (await json(session, key)).value?.pdfPositions).toEqual({});
  await observer.close(); await reopened.close(); await session.restart();
  const empty = await context.newPage(); await openEditor(empty, session);
  await expect(empty.locator('.compiled-pdf-button')).toHaveCount(0);
  await expect(empty.locator('#pdf-empty')).toBeVisible();
  await expect(empty.getByTestId('file-submission.pdf')).toBeVisible();
  const rebuilt = await compile(empty, session, 'main.tex');
  expect(rebuilt.pdfBuildId).not.toBe(first.pdfBuildId);
  await expect(empty.locator('.compiled-pdf-button')).toHaveCount(1);
  expect(await readFile(path.join(session.project, 'submission.pdf'))).toEqual(thirdBytes);
});
