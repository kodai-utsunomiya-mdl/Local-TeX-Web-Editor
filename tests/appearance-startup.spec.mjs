import { expect } from '@playwright/test';
import { test, openProject, openEditor, json } from './editor-fixtures.mjs';

async function pauseEditorBundle(page) {
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  await page.route('**/app.js', async route => { await paused; await route.continue().catch(() => {}); });
  return resume;
}

test('初回は OS がライトでもダークで描画し，編集画面と外観の初期値もダークになる', async ({ page, session }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' }); await openProject(session);
  const resume = await pauseEditorBundle(page);
  try {
    await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`, { waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(24, 25, 28)');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await testInfo.attach('first-paint-dark.png', { body: await page.screenshot(), contentType: 'image/png' });
  } finally { resume(); }
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'dark' }); await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('settings-button').click(); await page.locator('#open-appearance').click();
  await expect(page.locator('#appearance-mode')).toHaveValue('dark');
  await page.locator('#appearance-mode').selectOption('light');
  await page.locator('#appearance-reset').click();
  await expect(page.locator('#appearance-mode')).toHaveValue('dark');
});

test('保存済みのライト設定を使い，再読込みの最初の描画にも反映する', async ({ page, session }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await json(session, '/api/storage', { method: 'PUT', data: { key: 'preferences', value: { language: 'ja', theme: 'light' } } });
  await openProject(session); await openEditor(page, session);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('local-tex-editor-appearance')).mode)).toBe('light');
  const resume = await pauseEditorBundle(page);
  try {
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  } finally { resume(); }
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await page.getByTestId('settings-button').click(); await page.locator('#open-appearance').click();
  await expect(page.locator('#appearance-mode')).toHaveValue('light');
  await page.locator('#appearance-cancel').click(); await page.locator('#save-settings').click();
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.appearance?.mode).toBe('dark');
});
