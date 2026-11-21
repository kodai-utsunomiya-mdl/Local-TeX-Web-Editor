import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openEditor, openProject, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});

async function mockSetup(page, session) {
  const actual = await json(session, '/api/state');
  const calls = [];
  const installedBin = path.join(session.temp, 'setup-example', 'TinyTeX', 'bin');
  let snapshot = { supported: true, status: 'idle', operation: '', id: '', stage: '', release: 'v2026.11',
    parent: path.join(session.temp, 'setup-example'), directory: '', source: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1.zip',
    archiveBytes: 73_710_178, downloadedBytes: 0, downloadTotal: 0, packages: ['latexmk', 'synctex', 'collection-langjapanese', 'biber'],
    error: '', log: '', bin: '', managed: false, cancelable: false };
  await page.route('**/api/state', async route => {
    const response = await route.fetch(); const meta = await response.json();
    const ready = snapshot.status === 'succeeded';
    await route.fulfill({ response, json: { ...meta, texSetup: snapshot,
      texBin: ready ? installedBin : '', latexmk: ready ? path.join(installedBin, 'latexmk') : '', synctex: ready ? path.join(installedBin, 'synctex') : '',
      toolError: ready ? '' : 'TeX environment is not installed',
      texPackages: { ...actual.texPackages, programs: (actual.texPackages?.programs || []).map(program => ({ ...program, available: ready })) },
    } });
  });
  await page.route('**/api/tex/setup', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); calls.push(input);
      snapshot = { ...snapshot, status: 'running', operation: input.operation, id: 'example-setup', stage: 'downloading',
        parent: input.parent || snapshot.parent, directory: path.dirname(installedBin), downloadTotal: snapshot.archiveBytes,
        downloadedBytes: 1_000_000, log: 'Downloading the example archive', cancelable: true };
    }
    await route.fulfill({ json: snapshot });
  });
  return {
    calls, installedBin,
    complete() { snapshot = { ...snapshot, status: 'succeeded', stage: 'complete', managed: true, bin: installedBin, log: 'Available programs were checked', cancelable: false }; },
  };
}

test('導入を背景で進めながら Markdown の編集と保存を続け，設定への反映後も Undo とコンパイルを使う', async ({ page, session }, testInfo) => {
  const source = '# Notes\n\nOriginal paragraph.\n';
  const filename = path.join(session.project, 'notes.md'); await writeFile(filename, source);
  const meta = await openProject(session);
  const setup = await mockSetup(page, session);
  await openEditor(page, session); await setAutoSave(page, false);
  await page.locator('#go-home').click();
  await expect(page.locator('#tex-setup-home')).toBeVisible();
  await page.locator('#home-tex-setup').click();
  await expect(page.locator('#tex-setup-start')).toBeEnabled();
  expect(setup.calls).toEqual([]);
  await page.locator('#tex-setup-close').click();
  await page.locator('[data-project-path]').filter({ has: page.locator('button[data-action="resume"]') }).locator('button[data-action="resume"]').click();
  await page.getByTestId('file-notes.md').click();
  const rich = page.locator('#markdown-rich-primary .markdown-rich-document');
  await expect(rich).toBeVisible();
  await page.getByTestId('settings-button').click();
  await page.locator('#editor-font-size').fill('18');
  await page.locator('#settings-tex-setup').click();
  await page.locator('#tex-setup-start').click();
  await page.locator('#tex-setup-close').click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#editor-font-size')).toHaveValue('18');
  await expect(page.locator('#tex-bin')).toBeDisabled();
  await page.locator('#settings-dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
  const paragraph = rich.locator('p');
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.type(' Added during setup.');
  await expect(paragraph).toHaveText('Original paragraph. Added during setup.');
  await expect(page.getByTestId('compile-button')).toBeEnabled();
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(filename, 'utf8')).toContain('Added during setup.');
  await expect(page.locator('#tex-setup-status')).toBeVisible();

  await page.getByTestId('settings-button').click();
  await page.locator('#editor-font-size').fill('19');
  setup.complete();
  await expect(page.locator('#tex-bin')).toHaveValue(setup.installedBin);
  await expect(page.locator('#tex-bin')).toBeEnabled();
  await expect(page.locator('#editor-font-size')).toHaveValue('19');
  await expect(page.locator('#settings-tex-setup')).toHaveText('TeX を管理…');
  await page.locator('#save-settings').click();
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await paragraph.click(); await page.keyboard.press(`${modifier}+z`);
  await expect(paragraph).toHaveText('Original paragraph.');
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(filename, 'utf8')).toBe(source);
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.editorFontSize).toBe(19);
  expect(setup.calls).toHaveLength(1);
  expect(setup.calls[0]).toMatchObject({ consent: true, operation: 'install' });

  await page.getByTestId('file-main.tex').click();
  await page.locator('#tex-setup-status').click();
  await expect(page.locator('#tex-setup-compile')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('tex-setup-in-editor.png') });
  await page.locator('#tex-setup-compile').click();
  await expect(page.getByTestId('build-status')).toHaveAttribute('data-status', 'success', { timeout: 120_000 });
  expect((await json(session, '/api/state')).project.root).toBe(meta.project.root);
});

test('TeX がない状態でのコンパイルは導入内容の確認へ進み，取り消すと原稿をそのまま編集できる', async ({ page, session }) => {
  await openProject(session);
  const setup = await mockSetup(page, session);
  await openEditor(page, session);
  const content = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  let builds = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/build' && request.method() === 'POST') builds++; });
  await page.getByTestId('compile-button').click();
  await expect(page.locator('#tex-setup-dialog')).toBeVisible();
  await expect(page.locator('#tex-setup-start')).toBeEnabled();
  expect(builds).toBe(0); expect(setup.calls).toEqual([]);
  await page.locator('#tex-setup-close').click();
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(content);
});
