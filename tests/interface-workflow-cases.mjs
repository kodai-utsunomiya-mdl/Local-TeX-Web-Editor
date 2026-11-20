import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = (page, secondary = false) => page.getByTestId(secondary ? 'editor-secondary' : 'editor').locator('.cm-content');
const tabPaths = page => page.locator('#editor-tabs .tab-select').evaluateAll(nodes => nodes.map(node => node.dataset.path));
const firstPath = 'draft-first.tex';
const secondPath = 'draft-second.tex';
const firstOriginal = '% First saved document.\n';
const secondOriginal = '% Second saved document.\n';
const firstDraft = '% 一つ目の未保存の原稿\n';
const secondDraft = '% 二つ目の未保存の原稿\n';

async function replaceSource(page, content, secondary = false) {
  await source(page, secondary).click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(content);
}

async function expectEmptyWorkspace(page) {
  await expect(page.locator('#editor-tabs .tab-select')).toHaveCount(0);
  await expect(page.locator('#editor-empty')).toBeVisible();
  await expect(page.locator('#source-workspace .cm-editor')).toHaveCount(0);
  await expect(page.getByTestId('close-all-tabs')).toBeDisabled();
  await expect(page.locator('#split-editors')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#save-button')).toBeDisabled();
}

async function reloadEmptyWorkspace(page) {
  await page.reload();
  await expect(page.getByTestId('file-main.tex')).toBeVisible();
  await expect(page.getByTestId('settings-button')).toBeEnabled();
  // Observe the interval after startup in which the default document would
  // normally open. An immediate check can see the initial empty placeholder.
  const opened = await source(page).waitFor({ state: 'attached', timeout: 1000 }).then(() => true, error => {
    if (error.name === 'TimeoutError') return false;
    throw error;
  });
  expect(opened).toBe(false);
  await expectEmptyWorkspace(page);
}

export function registerInterfaceWorkflowTests({ test, openProject, openEditor, setAutoSave, json }) {
  async function prepareUnsavedDocuments(page, session) {
    await Promise.all([
      writeFile(path.join(session.project, firstPath), firstOriginal),
      writeFile(path.join(session.project, secondPath), secondOriginal),
    ]);
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    const main = await readFile(path.join(session.project, 'main.tex'), 'utf8');
    await page.getByTestId(`file-${firstPath}`).click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', firstPath);
    await replaceSource(page, firstDraft);
    await page.getByTestId(`file-${secondPath}`).click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', secondPath);
    await replaceSource(page, secondDraft);
    const meta = await json(session, '/api/state');
    return { main, root: meta.project.root, tabs: await tabPaths(page) };
  }

  async function expectSavedEmptyWorkspace(page, session, root) {
    await expectEmptyWorkspace(page);
    const url = `/api/storage?${new URLSearchParams({ key: `session:${root}` })}`;
    await expect.poll(async () => {
      const value = (await json(session, url)).value;
      return { tabs: value?.tabs, activePath: value?.activePath, primary: value?.workspace?.primary,
        secondary: value?.workspace?.secondary, split: value?.workspace?.split };
    }).toEqual({ tabs: [], activePath: '', primary: null, secondary: null, split: false });
  }

  test('言語を選ぶと設定画面がすぐに切り替わり，取り消しと保存を使い分けられる', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await openProject(session); await openEditor(page, session);
    const language = page.getByTestId('language-setting');
    const dialog = page.locator('#settings-dialog');
    const label = page.locator('label[for="language-setting"]');
    const savedLanguage = async () => (await json(session, '/api/storage?key=preferences')).value?.language;
    const expectLanguage = async (value, title, save) => {
      await expect(page.locator('html')).toHaveAttribute('lang', value);
      await expect(language).toHaveValue(value);
      await expect(label).toHaveText('Language / 言語設定');
      await expect(language).toHaveAccessibleName('Language / 言語設定');
      await expect(page.locator('#settings-title')).toHaveText(title);
      await expect(page.locator('#save-settings')).toHaveText(save);
    };

    await page.getByTestId('settings-button').click();
    await expectLanguage('ja', '編集とコンパイルの設定', '設定を保存して反映');
    await language.selectOption('en');
    await expectLanguage('en', 'Editing and compilation settings', 'Save and apply settings');
    expect(await savedLanguage()).toBe('ja');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(page.getByTestId('settings-button')).toHaveAccessibleName('設定');
    expect(await savedLanguage()).toBe('ja');

    await page.getByTestId('settings-button').click();
    await expectLanguage('ja', '編集とコンパイルの設定', '設定を保存して反映');
    await language.selectOption('en');
    await expectLanguage('en', 'Editing and compilation settings', 'Save and apply settings');
    // Move focus away from the native select before using Escape to close
    // the dialog, so the key cannot merely dismiss the select's popup.
    await page.locator('#editor-font-size').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    expect(await savedLanguage()).toBe('ja');

    await page.getByTestId('settings-button').click();
    await language.selectOption('en');
    await expectLanguage('en', 'Editing and compilation settings', 'Save and apply settings');
    await page.screenshot({ path: testInfo.outputPath('settings-language-before-saving.png') });
    await page.locator('#save-settings').click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(savedLanguage).toBe('en');
    await page.reload();
    await expect(source(page)).toBeVisible();
    await expect(page.getByTestId('settings-button')).toHaveAccessibleName('Settings');
    await page.getByTestId('settings-button').click();
    await expectLanguage('en', 'Editing and compilation settings', 'Save and apply settings');
    await language.selectOption('ja');
    await expectLanguage('ja', '編集とコンパイルの設定', '設定を保存して反映');
    expect(await savedLanguage()).toBe('en');
    await page.locator('#editor-font-size').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.getByTestId('settings-button').click();
    await language.selectOption('ja');
    await page.locator('#save-settings').click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(savedLanguage).toBe('ja');
    await page.reload();
    await expect(source(page)).toBeVisible();
    await expect(page.getByTestId('settings-button')).toHaveAccessibleName('設定');
    expect(errors).toEqual([]);
  });

  test('すべてのタブを閉じる操作を取り消して編集し，両方の原稿を保存して閉じる', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const opened = await prepareUnsavedDocuments(page, session);
    await page.locator('#split-editors').click();
    await page.locator('#primary-document').selectOption(firstPath);
    await page.locator('#secondary-document').selectOption(secondPath);
    await page.getByTestId('close-all-tabs').click();
    await expect(page.locator('#decision-dialog')).toBeVisible();
    await expect(page.locator('#decision-description')).toContainText(firstPath);
    await expect(page.locator('#decision-description')).toContainText(secondPath);
    await page.locator('#decision-cancel').click();
    await expect(page.locator('#decision-dialog')).not.toBeVisible();
    expect(await tabPaths(page)).toEqual(opened.tabs);
    await expect(source(page)).toContainText(firstDraft.trim());
    await expect(source(page, true)).toContainText(secondDraft.trim());
    await source(page, true).click();
    await page.keyboard.press(`${modifier}+End`);
    const continuation = '% 取り消した後の追記\n';
    await page.keyboard.insertText(continuation);
    await expect(source(page, true)).toContainText(continuation.trim());
    expect(await readFile(path.join(session.project, firstPath), 'utf8')).toBe(firstOriginal);
    expect(await readFile(path.join(session.project, secondPath), 'utf8')).toBe(secondOriginal);

    await page.getByTestId('close-all-tabs').click();
    await page.locator('#decision-primary').click();
    await expectSavedEmptyWorkspace(page, session, opened.root);
    expect(await readFile(path.join(session.project, firstPath), 'utf8')).toBe(firstDraft);
    expect(await readFile(path.join(session.project, secondPath), 'utf8')).toBe(secondDraft + continuation);
    expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(opened.main);
    await page.screenshot({ path: testInfo.outputPath('all-tabs-closed.png') });
    await reloadEmptyWorkspace(page);
    await page.getByTestId(`file-${firstPath}`).click();
    await expect(source(page)).toContainText(firstDraft.trim());
    await page.getByTestId(`file-${secondPath}`).click();
    await expect(source(page)).toContainText(continuation.trim());
    await page.getByTestId('close-all-tabs').click();
    await expect(page.locator('#decision-dialog')).not.toBeVisible();
    await expectSavedEmptyWorkspace(page, session, opened.root);
    expect(errors).toEqual([]);
  });

  test('保存せずにすべてのタブを閉じると，ディスクの原稿を残して未保存の編集を破棄する', async ({ page, session }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const opened = await prepareUnsavedDocuments(page, session);
    const draftsURL = `/api/storage?${new URLSearchParams({ key: `drafts:${opened.root}` })}`;
    await expect.poll(async () => (await json(session, draftsURL)).value?.entries?.filter(entry => [firstPath, secondPath].includes(entry.path)).length || 0).toBe(2);
    await page.getByTestId('close-all-tabs').click();
    await page.locator('#decision-secondary').click();
    await expectSavedEmptyWorkspace(page, session, opened.root);
    await expect.poll(async () => (await json(session, draftsURL)).value?.entries?.filter(entry => [firstPath, secondPath].includes(entry.path)).length || 0).toBe(0);
    expect(await readFile(path.join(session.project, firstPath), 'utf8')).toBe(firstOriginal);
    expect(await readFile(path.join(session.project, secondPath), 'utf8')).toBe(secondOriginal);
    expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(opened.main);
    await reloadEmptyWorkspace(page);
    await expect(page.locator('#recovery-banner')).not.toBeVisible();
    await page.getByTestId(`file-${firstPath}`).click();
    await expect(source(page)).toContainText(firstOriginal.trim());
    await expect(source(page)).not.toContainText(firstDraft.trim());
    await page.getByTestId(`file-${secondPath}`).click();
    await expect(source(page)).toContainText(secondOriginal.trim());
    await expect(source(page)).not.toContainText(secondDraft.trim());
    await expect(page.locator('#editor-tabs .tab-dirty:visible')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('まとめて閉じる前の保存で競合した場合は，すべてのタブと未保存の本文を開いたままにする', async ({ page, session }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const opened = await prepareUnsavedDocuments(page, session);
    const external = '% 別のアプリで更新した本文\n';
    await writeFile(path.join(session.project, firstPath), external);
    await page.getByTestId('close-all-tabs').click();
    await page.locator('#decision-primary').click();
    await expect(page.locator('#app-error')).toBeVisible();
    await expect(page.locator('#error-text')).toContainText(firstPath);
    await expect(page.getByTestId('close-all-tabs')).toBeEnabled();
    expect(await tabPaths(page)).toEqual(opened.tabs);
    await expect(source(page)).toContainText(secondDraft.trim());
    await page.locator(`#editor-tabs .tab-select[data-path="${firstPath}"]`).click();
    await expect(source(page)).toContainText(firstDraft.trim());
    await expect(page.locator('#conflict-banner')).toBeVisible();
    expect(await readFile(path.join(session.project, firstPath), 'utf8')).toBe(external);
    expect(await readFile(path.join(session.project, secondPath), 'utf8')).toBe(secondOriginal);
    expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(opened.main);
    expect(errors).toEqual([]);
  });

  test('多数のタブを一行に収め，縦と横のホイールで左右へ動かしてファイルを選ぶ', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const filenames = Array.from({ length: 14 }, (_, index) => `tab-${String(index + 1).padStart(2, '0')}-long-project-notes.tex`);
    await Promise.all(filenames.map(filename => writeFile(path.join(session.project, filename), `% ${filename}\n`)));
    await page.setViewportSize({ width: 1100, height: 850 });
    await openProject(session); await openEditor(page, session);
    for (const filename of filenames) {
      await page.getByTestId(`file-${filename}`).click();
      await expect(page.getByTestId('editor')).toHaveAttribute('data-path', filename);
    }
    const tabs = page.locator('#editor-tabs');
    await expect(tabs.locator('.tab-select')).toHaveCount(filenames.length + 1);
    const metrics = () => tabs.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth,
        contentWidth: element.scrollWidth, height: element.clientHeight, contentHeight: element.scrollHeight,
        toolbarHeight: element.parentElement.getBoundingClientRect().height,
        buttons: [...element.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect();
          return { top: box.top - bounds.top, bottom: box.bottom - bounds.top };
        }) };
    });
    const initial = await metrics();
    expect(initial.contentWidth).toBeGreaterThan(initial.width * 2);
    expect(initial.contentHeight).toBeLessThanOrEqual(initial.height + 1);
    expect(initial.toolbarHeight).toBeLessThanOrEqual(38);
    for (const button of initial.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(-0.5);
      expect(button.bottom).toBeLessThanOrEqual(initial.height + 0.5);
    }
    await tabs.locator('.tab-select').first().click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
    const bounds = await tabs.boundingBox();
    await page.mouse.move(bounds.x + Math.min(35, bounds.width / 2), bounds.y + bounds.height / 2);
    const beforeVertical = (await metrics()).left;
    await page.mouse.wheel(0, 320);
    await expect.poll(async () => (await metrics()).left).toBeGreaterThan(beforeVertical + 30);
    const beforeHorizontal = (await metrics()).left;
    await page.mouse.wheel(320, 0);
    await expect.poll(async () => (await metrics()).left).toBeGreaterThan(beforeHorizontal + 30);
    await page.mouse.wheel(100_000, 0);
    await expect.poll(async () => {
      const size = await metrics();
      return Math.abs(size.contentWidth - size.width - size.left);
    }).toBeLessThanOrEqual(1);
    expect((await metrics()).top).toBe(0);
    const last = tabs.locator('.tab-select').last();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', filenames.at(-1));
    await page.screenshot({ path: testInfo.outputPath('tabs-scrolled-horizontally.png') });
    await page.mouse.move(bounds.x + Math.min(35, bounds.width / 2), bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -100_000);
    await expect.poll(async () => (await metrics()).left).toBe(0);
    expect((await metrics()).top).toBe(0);
    await tabs.locator('.tab-select').first().click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
    expect(errors).toEqual([]);
  });
}
