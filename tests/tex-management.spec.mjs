import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41555';
let javascript;

test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: path.join(repository, 'web/src'), contents: `
    import { createTeXManagement } from './tex-management.js';
    import { setLanguage } from './i18n.js';
    window.setLanguage = setLanguage; setLanguage('ja');
    window.requests = []; window.removed = []; window.deleted = []; window.progress = []; window.added = [];
    window.busy = false; window.conflictRemoval = false; window.conflictDeletion = false; window.failRead = false;
    window.snapshot = { status: 'idle', managed: true, directory: '/Users/Example/Applications/TinyTeX', bin: '/Users/Example/Applications/TinyTeX/bin' };
    window.inventory = { ...snapshot, revision: 'inventory-one', packages: [
      { name: 'latexmk', description: 'Build TeX documents', protected: true, size: 1000 },
      { name: 'siunitx', description: 'Typeset quantities and units', protected: false, size: 2000 },
      { name: 'microtype', description: 'Improve text typesetting', protected: false, size: 3000 },
    ] };
    window.removalPlan = names => ({ directory: snapshot.directory, bin: snapshot.bin, revision: 'plan-one', packages: names,
      removals: names.map(name => ({ name, revision: '123', size: 2000 })), log: 'tlmgr: preview only' });
    window.inspection = { directory: snapshot.directory, bin: snapshot.bin, revision: 'environment-one', fileCount: 312, directoryCount: 24, size: 12500000, unknownFiles: [], canDelete: true };
    window.management = createTeXManagement({
      getMeta: () => ({ texBin: snapshot.bin }), getSetup: () => snapshot, isBusy: () => busy,
      api: async (endpoint, options = {}) => {
        requests.push({ endpoint, method: options.method || 'GET', body: options.body, projectRoot: options.projectRoot });
        if (window.deferRead) return new Promise((resolve, reject) => { window.resolveRead = resolve; window.rejectRead = reject; });
        if (failRead) { failRead = false; throw new Error('Could not read the package database'); }
        if (endpoint === '/api/tex/packages/remove-preview') return removalPlan(options.body.packages);
        if (endpoint === '/api/tex/setup/delete') return { ...inspection };
        return inventory;
      },
      onInstall: () => progress.push('install'), onAdd: value => added.push(value),
      onRemove: async plan => {
        removed.push(plan);
        if (conflictRemoval) { conflictRemoval = false; return { started: false, error: Object.assign(new Error('Changed'), { status: 409,
          data: { preview: { ...plan, revision: 'plan-two', removals: [...plan.removals, { name: 'siunitx.doc', revision: '124', size: 4000 }] } } }) }; }
        return { started: true, operation: 'remove-packages' };
      },
      onUninstall: async (value, confirmation) => {
        deleted.push({ ...value, confirmation });
        if (conflictDeletion) { conflictDeletion = false; return { started: false, error: Object.assign(new Error('Changed'), { status: 409,
          data: { inspection: { ...value, revision: 'environment-two', fileCount: 313 } } }) }; }
        return { started: true, operation: 'uninstall' };
      },
      onProgress: value => progress.push(value),
    });
    document.getElementById('open-management').addEventListener('click', () => management.open());
  ` }, bundle: true, format: 'esm', write: false });
  javascript = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', path.basename(pathname))) });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/tex-setup.css"><link rel="stylesheet" href="/tex-management.css"></head>
      <body><button type="button" id="open-management">Manage TeX</button><script type="module" src="/fixture.js"></script></body></html>` });
  });
  await page.goto(origin);
  await page.locator('#open-management').click();
  await expect(page.locator('#tex-package-list > li')).toHaveCount(3);
});

test('インストール済みの一覧を検索し，TeX の管理に必要なものを確認して追加する名前を選ぶ', async ({ page }) => {
  await expect(page.locator('[data-package="latexmk"] input')).toBeDisabled();
  await page.locator('#tex-package-filter').fill('quantities units');
  await expect(page.locator('#tex-package-list > li')).toHaveCount(1);
  await expect(page.locator('#tex-package-list > li')).toHaveAttribute('data-package', 'siunitx');
  await page.locator('#tex-managed-package-names').fill('siunitx; rm');
  await expect(page.locator('#tex-managed-package-add')).toBeDisabled();
  await page.locator('#tex-managed-package-names').fill('siunitx microtype siunitx');
  await page.locator('#tex-managed-package-reinstall').check();
  await page.locator('#tex-managed-package-add').click();
  expect(await page.evaluate(() => added)).toEqual([{ packages: ['siunitx', 'microtype'], reinstall: true }]);
  expect(await page.evaluate(() => removed)).toEqual([]);
  await page.evaluate(() => management.open({ packages: ['synctex', 'synctex.windows'], reinstall: true }));
  expect(await page.evaluate(() => added[1])).toEqual({ packages: ['synctex', 'synctex.windows'], reinstall: true });
  await expect(page.locator('#tex-management-dialog')).toBeHidden();
});

test('パッケージを削除する予定を確認し，内容が変わったときは新しい一覧を確認する', async ({ page }, testInfo) => {
  await page.locator('[data-package="siunitx"] input').check();
  await page.locator('#tex-package-remove').click();
  await expect(page.locator('#tex-package-remove-dialog')).toBeVisible();
  await expect(page.locator('#tex-package-remove-dialog').getByRole('button', { name: 'キャンセル', exact: true })).toBeFocused();
  await expect(page.locator('#tex-package-removal-list')).toContainText('siunitx');
  expect(await page.evaluate(() => removed)).toHaveLength(0);
  await page.evaluate(() => { conflictRemoval = true; });
  await page.locator('#tex-package-remove-confirm').click();
  await expect(page.locator('#tex-package-remove-notice')).toContainText('内容が変わりました');
  await expect(page.locator('#tex-package-removal-list')).toContainText('siunitx.doc');
  expect(await page.evaluate(() => removed)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('tex-package-removal-review.png') });
  await page.locator('#tex-package-remove-confirm').click();
  await expect(page.locator('#tex-package-remove-dialog')).toBeHidden();
  expect(await page.evaluate(() => removed[1].revision)).toBe('plan-two');
  expect(await page.evaluate(() => progress)).toEqual(['remove-packages']);
});

test('環境全体の削除はパスを示し，確認の入力とチェックを両方必要とする', async ({ page }, testInfo) => {
  await page.locator('#tex-environment-removal > summary').click();
  await page.locator('#tex-environment-delete').click();
  await expect(page.locator('#tex-environment-delete-path')).toHaveText('/Users/Example/Applications/TinyTeX');
  await expect(page.locator('#tex-environment-delete-counts')).toContainText('312');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
  await page.locator('#tex-environment-delete-name').fill('TinyTeX');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
  await page.locator('#tex-environment-delete-acknowledge').check();
  await expect(page.locator('#tex-environment-delete-confirm')).toBeEnabled();
  await page.locator('#tex-environment-delete-name').press('Enter');
  expect(await page.evaluate(() => deleted)).toHaveLength(0);
  await page.evaluate(() => { conflictDeletion = true; });
  await page.locator('#tex-environment-delete-confirm').click();
  await expect(page.locator('#tex-environment-delete-notice')).toContainText('もう一度確認');
  await expect(page.locator('#tex-environment-delete-name')).toHaveValue('');
  await expect(page.locator('#tex-environment-delete-acknowledge')).not.toBeChecked();
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
  await page.locator('#tex-environment-delete-acknowledge').check();
  await page.locator('#tex-environment-delete-name').fill('TinyTeX');
  await page.screenshot({ path: testInfo.outputPath('tex-environment-deletion-review.png') });
  await page.locator('#tex-environment-delete-confirm').click();
  expect(await page.evaluate(() => deleted[1])).toMatchObject({ revision: 'environment-two', confirmation: 'TinyTeX' });
  expect(await page.evaluate(() => progress)).toEqual(['uninstall']);
});

test('管理対象にないファイルを表示して削除を止め，取消しで元の操作へ戻る', async ({ page }) => {
  await page.evaluate(() => { inspection = { ...inspection, unknownFiles: ['notes/personal.tex'], canDelete: false }; });
  await page.locator('#tex-environment-removal > summary').click();
  await page.locator('#tex-environment-delete').click();
  await expect(page.locator('#tex-environment-unknown-files')).toHaveText('notes/personal.tex');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
  await expect(page.locator('#tex-environment-delete-name')).toBeDisabled();
  await page.locator('#tex-environment-delete-dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.locator('#tex-environment-delete')).toBeFocused();
  expect(await page.evaluate(() => deleted)).toHaveLength(0);
});

test('一覧の通信をやり直せ，閉じた後の古いエラーは次の画面へ出さない', async ({ page }) => {
  await page.evaluate(() => { failRead = true; });
  await page.locator('#tex-package-refresh').click();
  await expect(page.locator('#tex-management-dialog > .form-error')).toHaveText('Could not read the package database');
  await page.locator('#tex-package-refresh').click();
  await expect(page.locator('#tex-management-dialog > .form-error')).toBeHidden();
  await page.evaluate(() => { deferRead = true; });
  await page.locator('#tex-package-refresh').click();
  await page.locator('#tex-management-dialog > .dialog-actions').getByRole('button', { name: '閉じる', exact: true }).click();
  await page.evaluate(() => { deferRead = false; });
  await page.locator('#open-management').click();
  await expect(page.locator('#tex-package-list > li')).toHaveCount(3);
  await page.evaluate(() => rejectRead(new Error('Late failure')));
  await expect(page.locator('#tex-management-dialog > .form-error')).toBeHidden();
});

test('狭い英語画面でもパッケージと削除の保存先を読める', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.evaluate(() => setLanguage('en'));
  await expect(page.locator('#tex-management-dialog h2')).toHaveText('Manage TeX');
  await page.screenshot({ path: testInfo.outputPath('tex-management-english-mobile.png') });
  const bounds = await page.locator('#tex-management-dialog').evaluate(dialog => ({ scroll: dialog.scrollWidth, client: dialog.clientWidth, right: dialog.getBoundingClientRect().right }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
  expect(bounds.right).toBeLessThanOrEqual(390);
  await page.locator('#tex-environment-removal > summary').click();
  await page.locator('#tex-environment-delete').click();
  await expect(page.locator('#tex-environment-delete-dialog h2')).toHaveText('Review removal of the entire TeX environment');
  await expect(page.locator('#tex-environment-delete-path')).toBeVisible();
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
});

test('既存の MacTeX では保存先と共用の影響を示し，ごみ箱へ移す方法で確認する', async ({ page }) => {
  await page.evaluate(async () => {
    const environment = { directory: '/usr/local/texlive/2026', bin: '/usr/local/texlive/2026/bin/universal-darwin', manager: '/usr/local/texlive/2026/bin/universal-darwin/tlmgr',
      format: 'mactex', managed: false, writable: false, canInstallPackages: true, canRemovePackages: true, canUninstall: true,
      requiresElevation: true, shared: true, systemDirectories: ['/usr/local/texlive/2026/texmf-var'] };
    snapshot = { ...snapshot, managed: false, directory: environment.directory, bin: environment.bin, environment };
    inventory = { ...inventory, directory: environment.directory, bin: environment.bin, environment };
    inspection = { ...inspection, directory: environment.directory, bin: environment.bin, confirmation: '2026', environment };
    await management.refresh();
  });
  await expect(page.locator('#tex-management-format')).toHaveText('MacTeX');
  await expect(page.locator('#tex-management-directory')).toHaveText('/usr/local/texlive/2026');
  await expect(page.locator('#tex-management-dialog')).toContainText('他のアプリやユーザーにも変更が反映');
  await expect(page.locator('#tex-management-dialog')).toContainText('管理者の承認');
  await page.locator('#tex-environment-removal > summary').click();
  await page.locator('#tex-environment-delete').click();
  await expect(page.locator('#tex-environment-delete-description')).toContainText('ごみ箱へ移します');
  await expect(page.locator('#tex-environment-delete-description')).not.toContainText('元に戻せません');
  await expect(page.locator('label[for="tex-environment-delete-name"]')).toHaveText('確認のため 2026 と入力');
  await expect(page.locator('#tex-environment-system-directories')).toContainText('/usr/local/texlive/2026/texmf-var');
  await page.locator('#tex-environment-delete-acknowledge').check();
  await page.locator('#tex-environment-delete-name').fill('TinyTeX');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeDisabled();
  await page.locator('#tex-environment-delete-name').fill('2026');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeEnabled();
  await expect(page.locator('#tex-environment-delete-confirm')).toHaveText('TeX の環境をごみ箱へ移す');
  await page.evaluate(() => setLanguage('en'));
  await expect(page.locator('label[for="tex-environment-delete-name"]')).toHaveText('Type 2026 to confirm');
  await expect(page.locator('#tex-environment-delete-confirm')).toHaveText('Move the TeX environment to Trash');
});

test('Store で直接変更できない既存環境は公式ツールと Windows の設定へ進み，削除完了にはしない', async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const environment = { directory: 'C:/texlive/2026', bin: 'C:/texlive/2026/bin/windows', manager: 'C:/texlive/2026/bin/windows/tlmgr.bat',
      managerApplication: 'C:/texlive/2026/bin/windows/tlshell.exe', format: 'texlive', managed: false, writable: false,
      canInstallPackages: false, canRemovePackages: false, canUninstall: false, requiresElevation: true, storeEdition: true, uninstallInSettings: true, shared: true };
    snapshot = { ...snapshot, managed: false, environment };
    inventory = { ...inventory, environment };
    inspection = { ...inspection, directory: environment.directory, confirmation: '2026', canDelete: false, environment };
    await management.refresh();
  });
  for (const language of ['en', 'ja']) {
    await page.evaluate(value => setLanguage(value), language);
    for (const width of [1600, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 740 : 1000 });
      await page.locator('#tex-management-dialog .import-body').evaluate(body => { body.scrollTop = 0; });
      const bounds = await page.locator('#tex-management-dialog').evaluate(dialog => {
        const first = dialog.querySelector('#tex-management-open-manager').getBoundingClientRect();
        const second = dialog.querySelector('#tex-management-install').getBoundingClientRect();
        const description = dialog.querySelector('#tex-management-external-note').getBoundingClientRect();
        return { textGap: first.top - description.bottom, buttonGap: Math.max(second.left - first.right, second.top - first.bottom),
          scroll: dialog.scrollWidth, client: dialog.clientWidth, right: dialog.getBoundingClientRect().right };
      });
      expect(bounds.textGap).toBeGreaterThanOrEqual(10);
      expect(bounds.buttonGap).toBeGreaterThanOrEqual(8);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
      expect(bounds.right).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`tex-management-actions-${language}-${width}.png`) });
      const details = page.locator('#tex-environment-removal');
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
      const deleteGap = await details.evaluate(element => element.querySelector('#tex-environment-delete').getBoundingClientRect().top
        - element.querySelector('p').getBoundingClientRect().bottom);
      expect(deleteGap).toBeGreaterThanOrEqual(10);
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('#tex-managed-package-names').fill('siunitx');
  await expect(page.locator('#tex-managed-package-add')).toBeDisabled();
  await page.evaluate(() => management.open({ openManager: true }));
  await expect(page.locator('#tex-management-manager-note')).toContainText('管理ツールを開きました');
  expect(await page.evaluate(() => requests.filter(value => value.endpoint === '/api/tex/packages/manager'))).toHaveLength(1);
  await page.locator('#tex-environment-delete').click();
  await expect(page.locator('#tex-environment-delete-path')).toHaveText('C:/texlive/2026');
  await expect(page.locator('#tex-environment-delete-confirm')).toBeHidden();
  await expect(page.locator('#tex-environment-delete-name')).toBeHidden();
  await page.locator('#tex-environment-open-uninstaller').click();
  await expect(page.locator('#tex-environment-delete-notice')).toContainText('Windows のアプリ設定を開きました');
  expect(await page.evaluate(() => requests.find(value => value.endpoint === '/api/tex/setup/uninstaller'))).toMatchObject({
    method: 'POST', projectRoot: null, body: { directory: 'C:/texlive/2026', revision: 'environment-one' },
  });
  expect(await page.evaluate(() => deleted)).toEqual([]);
  expect(await page.evaluate(() => progress)).toEqual([]);
});

test('大きい環境の再確認を取り消すと，遅い応答が確認画面を開き直さない', async ({ page }) => {
  await page.locator('#tex-environment-removal > summary').click();
  await page.locator('#tex-environment-delete').click();
  await page.evaluate(() => { deferRead = true; });
  await page.locator('#tex-environment-delete-recheck').click();
  await page.locator('#tex-environment-delete-dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.evaluate(() => { deferRead = false; resolveRead({ ...inspection, fileCount: 999 }); });
  await expect(page.locator('#tex-environment-delete-dialog')).toBeHidden();
  await expect(page.locator('#tex-environment-delete')).toBeFocused();
  expect(await page.evaluate(() => deleted)).toEqual([]);
});
