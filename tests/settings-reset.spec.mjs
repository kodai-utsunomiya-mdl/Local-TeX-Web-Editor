import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openProject, openEditor } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = page => page.getByTestId('editor').locator('.cm-content');
const storageURL = key => `/api/storage?${new URLSearchParams({ key })}`;
const stored = async (session, key) => (await json(session, storageURL(key))).value;
const resetChoices = ['settings', 'drafts', 'history', 'templates', 'cache'];

const test = editorTest.extend({
  pageErrors: [async ({ page, context }, use) => {
    const errors = [];
    const observe = current => current.on('pageerror', error => errors.push(error.message));
    observe(page);
    context.on('page', observe);
    await use(errors);
    context.off('page', observe);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Reset settings project', colorScheme: 'light' });

test.afterEach(async ({ session }) => {
  if (!session.isRunning()) return;
  const meta = await json(session, '/api/state');
  if (!meta.settingsGeneration) return;
  await json(session, '/api/shutdown', { method: 'POST', data: {}, headers: { 'X-Settings-Generation': meta.settingsGeneration } });
  await session.waitForExit();
});

async function preferences(session, values = {}) {
  await json(session, '/api/storage', { method: 'PUT', data: {
    key: 'preferences', value: { language: 'en', autoSave: false, ...values, updatedAt: Date.now() },
  } });
}

async function prepareEditor(page, session, values = {}) {
  const meta = await openProject(session);
  await preferences(session, values);
  await openEditor(page, session);
  return meta.project.root;
}

async function replaceSource(page, text) {
  await source(page).click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(text);
  await expect(source(page)).toHaveText(text);
}

async function openReset(page) {
  await page.getByTestId('settings-button').click();
  await page.locator('#settings-reset-data').click();
  await expect(page.locator('#settings-reset-dialog')).toBeVisible();
  await expect(page.locator('#reset-settings')).toBeEnabled();
}

async function selectReset(page, choices = { settings: true }) {
  for (const choice of resetChoices) await page.locator(`#reset-${choice}`).setChecked(Boolean(choices[choice]));
  await page.locator('#reset-confirmation').check();
  await expect(page.locator('#settings-reset-submit')).toBeEnabled();
}

async function submitReset(page, { unsaved = false } = {}) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/settings/reset' && value.request().method() === 'POST');
  await page.locator('#settings-reset-submit').click();
  if (unsaved) {
    await expect(page.locator('#decision-dialog')).toBeVisible();
    await page.locator('#decision-secondary').click();
  }
  return response;
}

async function completeReset(page, options) {
  const reloaded = page.waitForEvent('domcontentloaded');
  const response = await submitReset(page, options);
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result.warning).toBe('');
  await reloaded;
  await expect(page.getByTestId('settings-button')).toBeEnabled();
  return result;
}

async function closeSettings(page) {
  if (await page.locator('#settings-dialog').isVisible()) {
    await page.locator('#settings-dialog [data-close-dialog="settings-dialog"]').last().click();
  }
}

test('初期化する項目と確認が必要で，キャンセル後も同じ原稿を編集できる', async ({ page, session }) => {
  const root = await prepareEditor(page, session);
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  const text = '% Unsaved text before reviewing reset';
  await replaceSource(page, text);
  const resets = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/settings/reset' && request.method() === 'POST') resets.push(request.postDataJSON());
  });
  await openReset(page);
  await expect(page.locator('#reset-settings')).toBeChecked();
  for (const choice of resetChoices.slice(1)) await expect(page.locator(`#reset-${choice}`)).not.toBeChecked();
  await expect(page.locator('#reset-confirmation')).not.toBeChecked();
  await expect(page.locator('#settings-reset-submit')).toBeDisabled();
  await expect(page.locator('.settings-reset-directory')).toContainText('config');
  await page.locator('#reset-confirmation').check();
  await expect(page.locator('#settings-reset-submit')).toBeEnabled();
  await page.locator('#reset-settings').uncheck();
  await expect(page.locator('#settings-reset-submit')).toBeDisabled();
  await page.locator('#reset-drafts').check();
  await expect(page.locator('#settings-reset-submit')).toBeEnabled();
  await page.locator('#settings-reset-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#settings-reset-dialog')).toBeHidden();
  await closeSettings(page);
  await expect(source(page)).toHaveText(text);
  await replaceSource(page, text + ' and after cancelling');
  await expect.poll(async () => (await stored(session, `drafts:${root}`))?.entries?.some(entry => entry.content === text + ' and after cancelling')).toBe(true);
  expect(resets).toEqual([]);
  expect(await readFile(path.join(root, 'main.tex'), 'utf8')).toBe(original);
});

test('設定を初期化するとホームへ戻り，原稿と選択していない草稿が残る', async ({ page, session }) => {
  const root = await prepareEditor(page, session, {
    appearance: { mode: 'dark', palette: 'navy', accent: 'purple', editorFont: 'menlo' },
    editorFontSize: 22, fileSort: 'name-desc', pdfDarkMode: true,
  });
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  const text = '% Keep this unsaved document through the settings reset';
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'navy');
  await replaceSource(page, text);
  await openReset(page);
  await selectReset(page);
  const result = await completeReset(page, { unsaved: true });
  expect(result.settingsGeneration).not.toBe('');
  expect(result.draftsGeneration).toBe('');
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#workbench')).toBeHidden();
  await expect(page.locator('.project-home-card')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'gray');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.locator('html').evaluate(element => element.style.getPropertyValue('--editor-font-size'))).toBe('14px');
  const meta = await json(session, '/api/state');
  expect(meta.project).toBeNull();
  expect(meta.recentProjects).toEqual([]);
  expect(await stored(session, 'preferences')).toBeNull();
  expect(await stored(session, `session:${root}`)).toBeNull();
  expect((await stored(session, `drafts:${root}`)).entries.some(entry => entry.content === text)).toBe(true);
  expect(await readFile(path.join(root, 'main.tex'), 'utf8')).toBe(original);
});

test('草稿だけを削除すると設定とプロジェクトが残り，旧世代のバックアップも復元されない', async ({ page, session }) => {
  const meta = await openProject(session), root = meta.project.root;
  const file = await json(session, '/api/file?path=main.tex');
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  await preferences(session, { editorFontSize: 21, appearance: { mode: 'light', palette: 'warm', accent: 'orange', editorFont: 'consolas' } });
  const savedDraft = { version: 1, updatedAt: Date.now(), entries: [{ id: 'reset-draft', path: 'main.tex', content: '% A draft selected for removal', baseRevision: file.revision, updatedAt: Date.now(), selection: { anchor: 0, head: 0 } }] };
  await json(session, '/api/storage', { method: 'PUT', data: { key: `drafts:${root}`, value: savedDraft } });
  await openEditor(page, session);
  await expect(page.locator('#recovery-banner')).toBeVisible();
  const backupKey = `local-tex-editor-backup:drafts:${root}`;
  const backup = JSON.stringify({ value: savedDraft, updatedAt: Date.now() + 60_000, draftsGeneration: '' });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: backupKey, value: backup });
  await openReset(page);
  await selectReset(page, { drafts: true });
  const result = await completeReset(page);
  expect(result.draftsGeneration).not.toBe('');
  expect(result.draftsGeneration).toBe(result.settingsGeneration);
  await expect(source(page)).toBeVisible();
  await expect(page.locator('#recovery-banner')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'warm');
  expect((await json(session, '/api/state')).project.root).toBe(root);
  expect((await stored(session, 'preferences')).editorFontSize).toBe(21);
  expect(await stored(session, `drafts:${root}`)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), backupKey)).toBeNull();

  // A sleeping older tab may leave its backup after the reset has finished.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: backupKey, value: backup });
  await page.reload();
  await expect(source(page)).toBeVisible();
  await expect(page.locator('#recovery-banner')).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), backupKey)).toBeNull();
  expect(await stored(session, `drafts:${root}`)).toBeNull();
  expect(await readFile(path.join(root, 'main.tex'), 'utf8')).toBe(original);
});

test('初期化の要求が失敗した後も，草稿と原稿の保存を続けられる', async ({ page, session }) => {
  const root = await prepareEditor(page, session);
  await replaceSource(page, '% Unsaved text before a failed reset');
  await page.evaluate(() => { window.resetPageMarker = 'same page'; });
  const failReset = async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await route.fulfill({ status: 409, json: { error: 'Reset is temporarily unavailable.', resetRequired: false, settingsGeneration: '', draftsGeneration: '' } });
  };
  await page.route('**/api/settings/reset', failReset);
  await openReset(page);
  await selectReset(page);
  const response = await submitReset(page, { unsaved: true });
  expect(response.status()).toBe(409);
  await expect(page.locator('#settings-reset-dialog [role="alert"]')).toHaveText('Reset is temporarily unavailable.');
  await expect(page.locator('#settings-reset-submit')).toBeEnabled();
  expect(await page.evaluate(() => window.resetPageMarker)).toBe('same page');
  await page.locator('#settings-reset-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await closeSettings(page);
  await page.unroute('**/api/settings/reset', failReset);
  const text = '% Editing and saving after a failed reset';
  await replaceSource(page, text);
  await expect.poll(async () => (await stored(session, `drafts:${root}`))?.entries?.some(entry => entry.content === text)).toBe(true);
  await page.locator('#save-button').click();
  await expect.poll(() => readFile(path.join(root, 'main.tex'), 'utf8')).toBe(text);
});

test('別タブの未保存原稿をダウンロードして開き直しても，削除した草稿は戻らない', async ({ page, context, session }) => {
  const root = await prepareEditor(page, session);
  const original = await readFile(path.join(root, 'main.tex'), 'utf8');
  const other = await context.newPage();
  await openEditor(other, session);
  const text = '% Unsaved manuscript in another tab';
  await replaceSource(other, text);
  await expect.poll(async () => (await stored(session, `drafts:${root}`))?.entries?.some(entry => entry.content === text)).toBe(true);
  await page.bringToFront();
  await openReset(page);
  await selectReset(page, { settings: true, drafts: true });
  await completeReset(page);
  await other.evaluate(() => window.dispatchEvent(new Event('focus')));
  const notice = other.locator('#settings-reset-notice');
  await expect(notice).toBeVisible();
  const link = notice.locator('a[download]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('main.tex');
  const downloaded = other.waitForEvent('download');
  await link.click();
  const download = await downloaded;
  expect(await readFile(await download.path(), 'utf8')).toBe(text);
  const reloaded = other.waitForEvent('domcontentloaded');
  await other.locator('#settings-reset-reload').click();
  await reloaded;
  await expect(other.locator('#welcome')).toBeVisible();
  await expect(other.getByTestId('settings-button')).toBeEnabled();
  expect(await stored(session, `drafts:${root}`)).toBeNull();
  expect(await stored(session, 'preferences')).toBeNull();
  expect(await readFile(path.join(root, 'main.tex'), 'utf8')).toBe(original);
});

test('別タブの外観保存の応答が遅れても，初期化後の設定と外観へ書き戻さない', async ({ page, context, session }) => {
  await prepareEditor(page, session);
  const other = await context.newPage();
  await openEditor(other, session);
  let release, received, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const captured = new Promise(resolve => { received = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const delayPreferences = async route => {
    const request = route.request(), body = request.method() === 'PUT' ? request.postDataJSON() : null;
    if (body?.key !== 'preferences' || body.value?.appearance?.palette !== 'navy') { await route.continue(); return; }
    try {
      const response = await route.fetch();
      received();
      await gate;
      try { await route.fulfill({ response }); }
      catch (error) { if (!request.failure()) throw error; }
    } finally { finished(); }
  };
  await other.route('**/api/storage', delayPreferences);
  try {
    await other.getByTestId('settings-button').click();
    await other.locator('#open-appearance').click();
    await other.locator('#appearance-mode').selectOption('dark');
    await other.locator('#appearance-palette').selectOption('navy');
    await other.locator('#save-appearance').click();
    await captured;
    await expect(other.locator('#appearance-dialog')).toHaveAttribute('data-busy', 'true');
    await page.bringToFront();
    await openReset(page);
    await selectReset(page);
    await completeReset(page);
    await other.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(other.locator('#settings-reset-notice')).toBeVisible();
    release();
    await completed;
    await expect(other.locator('#appearance-dialog')).not.toHaveAttribute('data-busy', 'true');
    await expect.poll(() => other.evaluate(() => JSON.parse(localStorage.getItem('local-tex-editor-appearance') || 'null')?.palette || '')).not.toBe('navy');
    expect(await stored(session, 'preferences')).toBeNull();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'gray');
    const reloaded = other.waitForEvent('domcontentloaded');
    await other.locator('#settings-reset-reload').click();
    await reloaded;
    await expect(other.locator('#welcome')).toBeVisible();
    await expect(other.locator('html')).toHaveAttribute('data-palette', 'gray');
    expect(await stored(session, 'preferences')).toBeNull();
  } finally {
    release();
    await other.unroute('**/api/storage', delayPreferences);
  }
});
