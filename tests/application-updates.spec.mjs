import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, applicationVersion, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

function updateState(values = {}) {
  return {
    supported: true, automatic: true, channel: 'windows-zip',
    currentVersion: applicationVersion, latestVersion: '', phase: 'up-to-date',
    lastCheckedAt: new Date().toISOString(), progress: 0, message: '', error: '',
    canInstall: false, releaseNotesURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/latest',
    ...values,
  };
}

async function mockUpdates(context, initial) {
  let state = initial;
  const requests = [];
  await context.route('**/api/updates{,/**}', async route => {
    const request = route.request(), endpoint = new URL(request.url()).pathname;
    const data = request.method() === 'POST' ? request.postDataJSON() : null;
    requests.push({ endpoint, data });
    if (endpoint === '/api/updates/settings') state = { ...state, automatic: data.automatic };
    if (endpoint === '/api/updates/check') state = { ...state, phase: 'downloading', latestVersion: '9.9.9', progress: 0.4 };
    if (endpoint === '/api/updates/defer') state = { ...state, phase: 'waiting', deferredUntil: new Date(Date.now() + data.minutes * 60000).toISOString() };
    await route.fulfill({ json: state });
  });
  return { requests, get state() { return state; }, set state(value) { state = value; } };
}

for (const language of ['ja', 'en']) {
  test.describe(`アプリの自動更新 (${language})`, () => {
    test.use({ interfaceLanguage: language });

    test('自動更新は初期状態で有効で，設定から手動確認と切り替えができる', async ({ page, context, session }, testInfo) => {
      const updates = await mockUpdates(context, updateState());
      await openProject(session); await openEditor(page, session);
      await page.getByTestId('settings-button').click();
      const automatic = page.locator('#application-updates-automatic');
      await expect(automatic).toBeChecked();
      await expect(automatic).toBeEnabled();
      await automatic.uncheck();
      await expect.poll(() => updates.state.automatic).toBe(false);
      await expect(automatic).not.toBeChecked();
      await page.locator('#application-updates-check').click();
      await expect(page.locator('#application-updates-status')).toHaveAttribute('data-phase', 'downloading');
      await expect(page.locator('#application-updates-progress')).toHaveAttribute('value', '0.4');
      await expect(page.locator('#application-updates-status')).toContainText(language === 'ja' ? 'ダウンロード' : 'Downloading');
      await page.locator('#application-updates').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`application-update-settings-${language}.png`) });
    });

    test('更新を 1 時間延期すると通知が閉じ，設定への入口から状況を確認できる', async ({ page, context, session }, testInfo) => {
      const updates = await mockUpdates(context, updateState({ phase: 'ready', latestVersion: '9.9.9', canInstall: true }));
      await openProject(session); await openEditor(page, session);
      await expect(page.locator('#application-update-banner')).toBeVisible();
      await expect(page.locator('#application-update-message')).toContainText('v9.9.9');
      await page.screenshot({ path: testInfo.outputPath(`application-update-notice-${language}.png`) });
      await page.locator('#application-update-defer').click();
      await expect.poll(() => updates.requests.some(request => request.endpoint === '/api/updates/defer' && request.data.minutes === 60)).toBe(true);
      await expect(page.locator('#application-update-banner')).toBeHidden();
      await page.locator('#application-update-open').click();
      await expect(page.locator('#application-updates')).toBeVisible();
      await expect(page.locator('#application-updates-install')).toBeVisible();
    });
  });
}

async function useUpdateStream(context) {
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let controller;
    window.__sendApplicationUpdate = value => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
    window.__closeApplicationUpdateStream = () => controller.close();
    window.fetch = (url, options) => {
      if (typeof url === 'string' && url.split('?')[0] === '/api/session') {
        const body = new ReadableStream({ start(stream) {
          controller = stream;
          options.signal.addEventListener('abort', () => { try { stream.close(); } catch { /* Already closed. */ } }, { once: true });
        } });
        return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
      }
      return nativeFetch(url, options);
    };
  });
}

async function openWithUpdateStream(page, session) {
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await expect(page.getByTestId('settings-button')).toBeEnabled();
}

test('別のタブに未保存の原稿があると更新を待ち，取り消した準備から編集へ戻る', async ({ page, context, session }) => {
  const updates = await mockUpdates(context, updateState({ phase: 'ready', latestVersion: '9.9.9', canInstall: true }));
  await useUpdateStream(context);
  await openProject(session); await openWithUpdateStream(page, session);
  await setAutoSave(page, false);
  const other = await context.newPage();
  await openWithUpdateStream(other, session);
  const otherEditor = other.getByTestId('editor').locator('.cm-content');
  await otherEditor.press('Control+End');
  await otherEditor.press('Enter');
  await otherEditor.pressSequentially('% update should wait');
  const text = await otherEditor.innerText();
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'all-tabs', automatic: false }));
  await expect.poll(() => updates.requests.some(request => request.endpoint === '/api/updates/ready' && request.data.ready)).toBe(true);
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await other.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'all-tabs', automatic: false }));
  await expect.poll(() => updates.requests.some(request => request.endpoint === '/api/updates/ready' && request.data.ready === false)).toBe(true);
  await expect(otherEditor).toHaveAttribute('contenteditable', 'true');
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'update-cancelled', attemptId: 'all-tabs' }));
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(otherEditor).toHaveText(text);
  await other.close();
});

test('自動更新は画面の操作が落ち着いてから準備を開始する', async ({ page, context, session }) => {
  const updates = await mockUpdates(context, updateState({ phase: 'ready', latestVersion: '9.9.9', canInstall: true }));
  await useUpdateStream(context);
  await page.clock.install({ time: new Date() });
  await openProject(session); await openWithUpdateStream(page, session);
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'recent-input', automatic: true }));
  await expect.poll(() => updates.requests.find(request => request.endpoint === '/api/updates/ready' && request.data.attemptId === 'recent-input')?.data.ready).toBe(false);
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.clock.fastForward(61000);
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'idle-editor', automatic: true }));
  await expect.poll(() => updates.requests.find(request => request.endpoint === '/api/updates/ready' && request.data.attemptId === 'idle-editor')?.data.ready).toBe(true);
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'update-cancelled', attemptId: 'idle-editor' }));
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

test('設定から手動で更新すると原稿を保存し，自動確認が重なっても更新の準備を続けられる', async ({ page, context, session }) => {
  const updates = await mockUpdates(context, updateState({ phase: 'ready', latestVersion: '9.9.9', canInstall: true }));
  await useUpdateStream(context);
  await context.route('**/api/updates/install', async route => {
    await route.fulfill({ json: { ...updates.state, phase: 'preparing' } });
    await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'manual-install' }));
  });
  await openProject(session); await openWithUpdateStream(page, session);
  await setAutoSave(page, false);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.press('End'); await editor.press('Enter');
  await editor.pressSequentially('% saved before app update');
  await page.getByTestId('settings-button').click();
  await page.locator('#application-updates-install').click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#decision-dialog')).toBeVisible();
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'automatic-during-prompt', automatic: true }));
  await expect.poll(() => updates.requests.find(request => request.endpoint === '/api/updates/ready' && request.data.attemptId === 'automatic-during-prompt')?.data.ready).toBe(false);
  await page.locator('#decision-primary').click();
  await expect.poll(() => updates.requests.find(request => request.endpoint === '/api/updates/ready' && request.data.attemptId === 'manual-install')?.data.ready).toBe(true);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain('% saved before app update');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'update-cancelled' }));
  await expect(editor).toHaveAttribute('contenteditable', 'true');
});

test('更新の準備を済ませたタブは新しいアプリへの接続後に同じ URL で編集を再開する', async ({ page, context, session }) => {
  const updates = await mockUpdates(context, updateState({ phase: 'ready', latestVersion: '9.9.9', canInstall: true }));
  await useUpdateStream(context);
  await openProject(session); await openWithUpdateStream(page, session);
  const originalURL = page.url();
  await page.evaluate(() => window.__sendApplicationUpdate({ type: 'prepare-update', attemptId: 'restart', automatic: false }));
  await expect.poll(() => updates.requests.some(request => request.endpoint === '/api/updates/ready' && request.data.ready)).toBe(true);
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ json: { ...state, version: '9.9.9' } });
  });
  const loaded = page.waitForEvent('load');
  await page.evaluate(() => {
    window.__sendApplicationUpdate({ type: 'applying-update', attemptId: 'restart' });
    window.__closeApplicationUpdateStream();
  });
  await loaded;
  await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(page.locator('#app-version')).toHaveText('v9.9.9');
  expect(page.url()).toBe(originalURL);
});
