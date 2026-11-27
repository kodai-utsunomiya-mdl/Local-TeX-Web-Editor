import { expect } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, openProject, openEditor, setAutoSave, request, json, waitUntil } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const editor = page => page.getByTestId('editor').locator('.cm-content');
const dialog = page => page.locator('#project-zip-dialog');
const zipMenu = page => page.locator('#project-zip-menu');

async function replaceText(page, text) {
  await editor(page).click(); await page.keyboard.press(`${modifier}+a`); await page.keyboard.insertText(text);
}

async function menuAction(page, action) {
  await page.locator('#project-zip-button').click();
  await expect(zipMenu(page)).toBeVisible();
  await zipMenu(page).locator(`[data-action="${action}"]`).click();
}

async function savedProjectZIP(session) {
  const { project } = await json(session, '/api/state');
  const response = await request(session, '/api/project/download', { method: 'POST', data: {}, headers: { 'X-Project-Root': encodeURIComponent(project.root) } });
  expect(response.ok, `${response.status} ${response.statusText}`).toBe(true);
  return Buffer.from(await response.arrayBuffer());
}

async function fillImport(page, session, buffer, name = 'Imported project') {
  await page.locator('#project-zip-archive').setInputFiles({ name: 'Overleaf project.zip', mimeType: 'application/zip', buffer });
  await page.locator('#project-zip-parent').fill(session.temp);
  await page.locator('#project-zip-name').fill(name);
  await expect(page.locator('#project-zip-submit')).toBeEnabled();
}

test('未保存の原稿を含む ZIP をダウンロードし，別のプロジェクトへ読み込んでコンパイルする', async ({ page, session }) => {
  const main = (await readFile(path.join(session.project, 'main.tex'), 'utf8')).replace(/\r\n/g, '\n').replace('\\end{document}', '\\input{sections/added}\n\\end{document}');
  const section = '\\section{Imported source}\nThis source is stored in a relative folder.\n';
  const notes = '# Notes\n\n![Figure](figures/plot.svg)\n';
  const figure = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="blue"/></svg>\n';
  await mkdir(path.join(session.project, 'figures')); await mkdir(path.join(session.project, 'sections'));
  await writeFile(path.join(session.project, 'figures/plot.svg'), figure);
  await writeFile(path.join(session.project, 'sections/added.tex'), section);
  await writeFile(path.join(session.project, 'notes.md'), '# Saved notes\n');
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await replaceText(page, main);
  await page.getByTestId('file-notes.md').click(); await page.locator('#markdown-editor-mode').selectOption('source');
  await replaceText(page, notes);
  const pendingDownload = page.waitForEvent('download'); await menuAction(page, 'download');
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe(`${path.basename(session.project)}.zip`);
  const archive = await readFile(await download.path());
  expect((await readFile(path.join(session.project, 'main.tex'), 'utf8')).replace(/\r\n/g, '\n')).toBe(main);
  expect(await readFile(path.join(session.project, 'notes.md'), 'utf8')).toBe(notes);
  await page.locator('#go-home').click(); await page.locator('#welcome-import-zip').click();
  await fillImport(page, session, archive, 'ZIP から読み込んだ 原稿');
  const imported = path.join(session.temp, 'ZIP から読み込んだ 原稿');
  await expect(page.locator('#project-zip-destination')).toHaveText(imported);
  await page.locator('#project-zip-submit').click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#project-name')).toHaveText(path.basename(imported));
  for (const relative of ['main.tex', 'notes.md', 'sections/added.tex', 'figures/plot.svg', 'references.bib', 'latexmkrc', '追加の 原稿.tex']) {
    expect(await readFile(path.join(imported, relative)), relative).toEqual(await readFile(path.join(session.project, relative)));
  }
  await page.getByTestId('file-main.tex').click();
  const startedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/build' && response.request().method() === 'POST');
  await page.getByTestId('compile-button').click();
  const started = await (await startedResponse).json();
  const build = await waitUntil(() => json(session, '/api/build'), value => value.id === started.id && value.status !== 'running', 100_000, 'The imported project did not finish compiling.');
  expect(build.status, `${build.log}\n${build.error}`).toBe('success');
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#app-error')).toBeHidden();
});

test('保存の競合があると ZIP を作成せず，内容を確認する操作へ戻る', async ({ page, session }) => {
  const original = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await replaceText(page, `${original}\n% Edited in the browser\n`);
  const external = `${original}\n% Edited by another application\n`;
  await writeFile(path.join(session.project, 'main.tex'), external);
  const downloads = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/project/download') downloads.push(request); });
  await menuAction(page, 'download');
  await expect(page.locator('#app-error')).toBeVisible(); await expect(page.locator('#error-action')).toBeVisible();
  expect(downloads).toHaveLength(0);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(external);
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await page.locator('#error-action').click();
  await expect(page.locator('#conflict-dialog')).toBeVisible();
  await expect(page.locator('#editing-content')).toHaveValue(/Edited in the browser/);
  await expect(page.locator('#disk-content')).toHaveValue(/Edited by another application/);
});

test('プロジェクト切替の確認を取り消すと ZIP を展開せず編集を続けられる', async ({ page, session }) => {
  await openProject(session); const archive = await savedProjectZIP(session); await openEditor(page, session); await setAutoSave(page, false);
  await replaceText(page, '% Unsaved work before import\n');
  const imports = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/project/import') imports.push(request); });
  await menuAction(page, 'import'); await fillImport(page, session, archive, 'Cancelled import');
  await page.locator('#project-zip-submit').click(); await expect(page.locator('#decision-dialog')).toBeVisible();
  await page.locator('#decision-cancel').click();
  await expect(page.locator('#project-zip-submit')).toBeEnabled(); expect(imports).toHaveLength(0);
  expect(await stat(path.join(session.temp, 'Cancelled import')).then(() => true, () => false)).toBe(false);
  await dialog(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await expect(editor(page)).toContainText('Unsaved work before import');
});

test('読み込み後に開く処理が失敗しても，同じ ZIP を展開し直さず作成済みのプロジェクトを開ける', async ({ page, session }) => {
  await openProject(session); const archive = await savedProjectZIP(session); await openEditor(page, session);
  const imports = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/project/import') imports.push(request); });
  let failed = false;
  await page.route('**/api/project/open', async route => {
    if (!failed) { failed = true; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '一時的にプロジェクトを開けませんでした．' }) }); }
    return route.continue();
  });
  await menuAction(page, 'import'); await fillImport(page, session, archive, 'Open again');
  await page.locator('#project-zip-submit').click();
  await expect(dialog(page).locator('.form-error')).toContainText('一時的に');
  await expect(page.locator('#project-zip-status')).toContainText('読み込みは完了');
  await expect(page.locator('#project-zip-archive')).toBeDisabled();
  await expect(page.locator('#project-zip-submit')).toHaveText('作成したプロジェクトを開く');
  await page.locator('#project-zip-submit').click();
  await expect(dialog(page)).toBeHidden(); await expect(page.locator('#project-name')).toHaveText('Open again');
  expect(imports).toHaveLength(1);
  expect((await readdir(session.temp)).filter(name => name === 'Open again')).toHaveLength(1);
});

test('ZIP を名前を付けて保存すると原稿を保存し，保存先選択のキャンセル後も編集を続けられる', async ({ page, session }) => {
  const meta = await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  const original = (await readFile(path.join(session.project, 'main.tex'), 'utf8')).replace(/\r\n/g, '\n');
  await replaceText(page, `${original}\n% Saved before choosing a destination\n`);
  const requests = [];
  await page.route('**/api/project/save-as', async route => {
    requests.push({ body: route.request().postDataJSON(), root: decodeURIComponent(route.request().headers()['x-project-root']) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cancelled: true }) });
  });
  await page.getByTestId('file-main.tex').click({ button: 'right' });
  await page.locator('#file-context-menu [data-action="saveProjectAs"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ body: {}, root: meta.project.root });
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain('Saved before choosing a destination');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#app-error')).toBeHidden();
});

test('親フォルダーの選択を取り消すと，遅れて返ったパスで入力内容を戻さない', async ({ page, session }) => {
  await openProject(session); const archive = await savedProjectZIP(session); await openEditor(page, session);
  let finishPicker, picking = false, pickerReturned = false;
  const released = new Promise(resolve => { finishPicker = resolve; });
  await page.route('**/api/project/pick', async route => {
    picking = true; await released;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ path: path.join(session.temp, 'Late selection') }) }).catch(() => {});
    pickerReturned = true;
  });
  await menuAction(page, 'import'); await fillImport(page, session, archive);
  await page.locator('#project-zip-browse').click(); await expect.poll(() => picking).toBe(true);
  await expect(page.locator('#project-zip-submit')).toBeDisabled();
  await expect(page.locator('#project-zip-browse')).toHaveText('フォルダーの選択を取り消す');
  await page.locator('#project-zip-browse').click();
  await expect(page.locator('#project-zip-browse')).toHaveText('フォルダーを選ぶ');
  await page.locator('#project-zip-parent').fill(session.temp); finishPicker();
  await expect.poll(() => pickerReturned).toBe(true);
  await expect(page.locator('#project-zip-parent')).toHaveValue(session.temp);
  await expect(page.locator('#project-zip-submit')).toBeEnabled();
  await expect(dialog(page).locator('.form-error')).toBeHidden();
});

for (const language of ['ja', 'en']) test.describe(`${language} ZIP interface`, () => {
  test.use({ interfaceLanguage: language });
  test('ZIP メニューと読み込み画面を表示し，狭い画面でも操作できる', async ({ page, session }, testInfo) => {
    await openProject(session); const archive = await savedProjectZIP(session); await openEditor(page, session);
    await page.locator('#project-zip-button').click();
    await expect(zipMenu(page).getByRole('menuitem')).toHaveCount(3);
    await testInfo.attach(`project-zip-menu-${language}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape'); await expect(page.locator('#project-zip-button')).toBeFocused();
    await menuAction(page, 'import'); await fillImport(page, session, archive, language === 'ja' ? '研究の原稿' : 'Research paper');
    await testInfo.attach(`project-zip-import-${language}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await dialog(page).evaluate(node => ({ width: node.scrollWidth, client: node.clientWidth, screen: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.client + 1); expect(dimensions.screen).toBeLessThanOrEqual(dimensions.viewport + 1);
    await expect(page.locator('#project-zip-submit')).toBeInViewport();
    await testInfo.attach(`project-zip-import-${language}-narrow.png`, { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#project-zip-button')).toBeInViewport(); await expect(page.locator('#compile-button')).toBeInViewport();
    await page.locator('#project-zip-button').click();
    await expect(zipMenu(page).locator('[data-action="download"]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});
