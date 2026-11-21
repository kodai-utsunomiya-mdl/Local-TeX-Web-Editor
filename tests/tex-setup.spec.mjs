import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41554';
let javascript;

test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: path.join(repository, 'web/src'), contents: `
    import { createTeXSetup, teXEnvironment } from './tex-setup.js';
    import { renderTeXPackagesHelp } from './tex-packages.js';
    import { setLanguage } from './i18n.js';
    window.setLanguage = setLanguage; setLanguage('ja');
    const idle = { supported: true, status: 'idle', operation: '', id: '', stage: '', release: 'v2026.11',
      parent: '/Users/Example/Applications', directory: '', source: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1.zip',
      archiveBytes: 108000000, downloadedBytes: 0, downloadTotal: 0, packages: ['latexmk', 'synctex', 'collection-langjapanese', 'biber'], log: '', error: '', bin: '', managed: false };
    window.server = JSON.parse(localStorage.getItem('setup') || 'null') || idle;
    window.requests = []; window.compiled = []; window.samples = 0; window.toolChecks = 0; window.managementOpened = 0; window.managerOpened = 0;
    window.target = { root: '/projects/paper', main: 'main.tex' }; window.blocked = false;
    window.meta = { platform: 'windows', project: { root: '/projects/paper', main: 'main.tex', mode: 'pdflatex' }, texBin: '', latexmk: '',
      texPackages: { repository: 'https://mirror.ctan.org/systems/texlive/tlnet/', shell: 'posix', commandPrefix: '', programs: [
        { name: 'latexmk', available: false, packages: ['latexmk'] }, { name: 'pdflatex', available: false }, { name: 'synctex', available: false, packages: ['synctex'] } ] } };
    window.setSnapshot = value => { server = { ...server, ...value }; localStorage.setItem('setup', JSON.stringify(server)); };
    window.renderHelper = () => renderTeXPackagesHelp(document.getElementById('package-helper'), meta.texPackages, {
      canInstall: teXEnvironment(server).canInstallPackages, canSetup: server.supported, managerApplication: teXEnvironment(server).managerApplication,
      busy: setup?.busy, onInstall: values => setup.open({ reason: 'packages', operation: 'packages', ...values }),
      onSetup: () => setup.open({ reason: 'settings' }), onOpenManager: () => managerOpened++ });
    const api = async (endpoint, options = {}) => {
      requests.push({ endpoint, method: options.method || 'GET', body: options.body, projectRoot: options.projectRoot });
      if (endpoint.endsWith('/pick')) return new Promise(resolve => window.resolvePicker = resolve);
      if (endpoint.endsWith('/stop')) { setSnapshot({ status: 'cancelling' }); return { ...server }; }
      if (options.method === 'POST') {
        const id = 'job-' + requests.filter(value => value.method === 'POST' && value.endpoint === '/api/tex/setup').length;
        setSnapshot({ status: 'running', id, operation: options.body.operation, stage: 'downloading', error: '',
          packages: options.body.packages || idle.packages, directory: (options.body.parent || idle.parent) + '/TinyTeX-' + id,
          downloadTotal: 108000000, downloadedBytes: 12000000, log: 'Downloading TinyTeX…' });
        if (window.failStartOnce) { window.failStartOnce = false; throw new Error('Connection interrupted'); }
        return { ...server };
      }
      if (window.failReadOnce) { window.failReadOnce = false; throw new Error('Could not read setup status'); }
      return { ...server };
    };
    window.setup = createTeXSetup({ api, getMeta: () => meta, home: document.getElementById('tex-setup-home'), indicator: document.getElementById('tex-setup-status'),
      isBlocked: () => blocked, getCompileTarget: () => target,
      onToolsChanged: async snapshot => {
        toolChecks++;
        if (snapshot?.status === 'succeeded') {
          meta.texBin = snapshot.bin; meta.latexmk = snapshot.bin + '/latexmk';
          meta.texPackages = { ...meta.texPackages, commandPrefix: "'/managed/bin/tlmgr'", manager: '/managed/bin/tlmgr', year: '2026',
            programs: meta.texPackages.programs.map(value => ({ ...value, available: true })) };
        }
      },
      onStateChange: snapshot => { meta.texSetup = snapshot; if (window.setup) renderHelper(); },
      onCompile: value => compiled.push(value), onCreateSample: () => samples++, onManage: () => managementOpened++,
    });
    setup.sync(server); renderHelper();
    document.getElementById('open-setup').addEventListener('click', () => setup.open({ reason: 'home' }));
    document.getElementById('open-settings-setup').addEventListener('click', () => setup.open({ reason: 'settings' }));
  ` }, bundle: true, format: 'esm', write: false });
  javascript = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', path.basename(pathname))) });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/project-home.css"><link rel="stylesheet" href="/tex-packages.css"><link rel="stylesheet" href="/tex-setup.css"></head>
      <body><main id="welcome" class="welcome"><div class="welcome-card"><h1>Projects</h1><button type="button" id="open-setup" class="button">Set up TeX</button>
      <button type="button" id="open-settings-setup" class="button">Settings setup</button><section id="tex-setup-home" hidden></section>
      <label>Markdown<textarea id="markdown-source"># Notes\nUnchanged source</textarea></label><div id="package-helper"></div></div></main>
      <footer class="status-bar"><button type="button" id="tex-setup-status" hidden></button></footer><script type="module" src="/fixture.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect(page.locator('#home-tex-setup')).toBeVisible();
});

const starts = page => page.evaluate(() => requests.filter(value => value.endpoint === '/api/tex/setup' && value.method === 'POST'));

test('TeX がないホームから内容と保存先を確認し，開始前はダウンロードしない', async ({ page }, testInfo) => {
  await expect(page.locator('#home-tex-setup')).toHaveText('TeX をセットアップ…');
  await expect(page.locator('#home-tex-management')).toBeVisible();
  await expect(page.locator('#home-tex-management')).toBeDisabled();
  await page.locator('#home-tex-setup').click();
  await expect(page.locator('#tex-setup-dialog')).toBeVisible();
  await expect(page.locator('#tex-setup-close')).toBeFocused();
  await expect(page.locator('#tex-setup-contents')).toContainText('研究用の原稿');
  await expect(page.locator('#tex-setup-release')).toHaveText('TinyTeX v2026.11');
  await expect(page.locator('#tex-setup-source')).toHaveAttribute('href', /tinytex-releases/);
  await expect(page.locator('#tex-setup-archive-size')).toHaveText('108.0 MB');
  await expect(page.locator('#tex-setup-size-estimate')).toContainText('250 MB');
  await page.locator('#tex-setup-parent').fill('/Users/Example/TeX files');
  await page.locator('#tex-setup-parent').press('Enter');
  expect(await starts(page)).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('tex-setup-review.png') });
  await page.locator('#tex-setup-close').click();
  await expect(page.locator('#home-tex-setup')).toBeFocused();
  expect(await starts(page)).toHaveLength(0);
});

test('開始したセットアップを閉じても Markdown を編集でき，成功後は原稿をコンパイルできる', async ({ page }, testInfo) => {
  await page.locator('#open-setup').click();
  await page.locator('#tex-setup-parent').fill('/Users/Example/TeX files');
  await page.locator('#tex-setup-start').click();
  const progress = page.locator('#tex-setup-progress');
  const downloaded = page.locator('#tex-setup-downloaded');
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX をダウンロードしています…');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('value', String(12 / 108));
  await expect(downloaded).toHaveText('12.0 MB / 108.0 MB');
  expect((await starts(page))[0]).toMatchObject({ body: { consent: true, operation: 'install', parent: '/Users/Example/TeX files' }, projectRoot: null });
  await page.evaluate(async () => { setSnapshot({ downloadedBytes: 54000000 }); await setup.refresh(); });
  await expect(progress).toHaveAttribute('value', '0.5');
  await expect(downloaded).toHaveText('54.0 MB / 108.0 MB');
  await page.locator('#tex-setup-close').click();
  await page.locator('#markdown-source').fill('# Notes\nEditing during setup');
  await expect(page.locator('#markdown-source')).toHaveValue('# Notes\nEditing during setup');
  await page.locator('#tex-setup-status').click();
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX をダウンロードしています…');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('value', '0.5');
  await expect(downloaded).toHaveText('54.0 MB / 108.0 MB');
  expect(await starts(page)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('tex-setup-downloading.png') });

  await page.evaluate(async () => { setSnapshot({ stage: 'extracting', downloadedBytes: 108000000 }); await setup.refresh(); });
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX のファイルを展開しています…');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveJSProperty('position', -1);
  await expect(downloaded).toBeHidden();
  await page.evaluate(async () => { setSnapshot({ stage: 'packages', log: 'Installing Japanese typesetting, mathematics, and bibliography packages…' }); await setup.refresh(); });
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX パッケージを追加しています…');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveJSProperty('position', -1);
  await expect(downloaded).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('tex-setup-packages.png') });

  await page.evaluate(async () => { setSnapshot({ status: 'succeeded', stage: 'complete', bin: '/managed/tex/bin', managed: true, log: 'All tools available' }); await setup.refresh(); });
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX のセットアップが完了しました．');
  await expect(progress).toBeHidden();
  await expect(page.locator('#tex-setup-compile')).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('tex-setup-complete.png') });
  await page.locator('#tex-setup-compile').click();
  expect(await page.evaluate(() => compiled)).toEqual([{ root: '/projects/paper', main: 'main.tex' }]);
  expect(await page.evaluate(() => meta.texBin)).toBe('/managed/tex/bin');
  expect(await starts(page)).toHaveLength(1);
});

test('再読込で実行中の処理へ戻り，停止が完了するまで待ってから内容を再確認できる', async ({ page }) => {
  await page.locator('#open-setup').click();
  await page.locator('#tex-setup-start').click();
  await page.reload();
  await page.locator('#tex-setup-status').click();
  await expect(page.locator('#tex-setup-stage')).toHaveText('TeX をダウンロードしています…');
  expect(await starts(page)).toHaveLength(0);
  await page.locator('#tex-setup-stop').click();
  await expect(page.locator('#tex-setup-stage')).toHaveText('セットアップの停止を待っています…');
  await expect(page.locator('#tex-setup-stop')).toBeDisabled();
  await expect(page.locator('#tex-setup-start')).toBeHidden();
  expect(await page.evaluate(() => requests.filter(value => value.endpoint.endsWith('/stop')))).toEqual([
    { endpoint: '/api/tex/setup/stop', method: 'POST', body: { id: 'job-1' }, projectRoot: null },
  ]);
  await page.evaluate(async () => { setSnapshot({ status: 'cancelled', stage: '', log: 'Setup stopped' }); await setup.refresh(); });
  await expect(page.locator('#tex-setup-retry')).toBeVisible();
  await page.locator('#tex-setup-retry').click();
  await expect(page.locator('#tex-setup-review')).toBeVisible();
  expect(await starts(page)).toHaveLength(0);
});

test('管理された TeX へのパッケージ追加は有効な名前を確認してから実行する', async ({ page }) => {
  await page.evaluate(async () => {
    setSnapshot({ managed: true, directory: '/managed/TeX', bin: '/managed/TeX/bin' });
    meta.texBin = '/managed/TeX/bin'; meta.latexmk = '/managed/TeX/bin/latexmk';
    meta.texPackages = { ...meta.texPackages, commandPrefix: "'/managed/TeX/bin/tlmgr'", manager: '/managed/TeX/bin/tlmgr', year: '2026' };
    await setup.refresh(); renderHelper();
  });
  await page.locator('[data-testid="tex-packages"] > summary').click();
  await expect(page.locator('[data-testid="tex-packages"] textarea')).toHaveCount(0);
  await expect(page.locator('[data-testid="tex-packages"]')).not.toContainText('PowerShell');
  await page.locator('[data-testid="tex-package-names"]').fill('--all');
  await expect(page.locator('[data-testid="tex-package-add"]')).toBeDisabled();
  await page.locator('[data-testid="tex-package-names"]').fill('siunitx siunitx cleveref');
  await page.locator('[data-testid="tex-package-add"]').click();
  await expect(page.locator('#tex-setup-package-list > li')).toHaveText(['siunitx', 'cleveref']);
  await expect(page.locator('#tex-setup-parent')).toBeHidden();
  expect(await starts(page)).toHaveLength(0);
  await page.locator('#tex-setup-start').click();
  expect((await starts(page))[0].body).toMatchObject({ consent: true, operation: 'packages', packages: ['siunitx', 'cleveref'] });
});

test('通信の再試行とフォルダー選択の取消しで，勝手に開始せず入力とフォーカスを戻す', async ({ page }) => {
  await page.evaluate(() => { failReadOnce = true; });
  await page.locator('#open-setup').click();
  await expect(page.locator('#tex-setup-dialog > .form-error')).toHaveText('Could not read setup status');
  await expect(page.locator('#tex-setup-start')).toBeDisabled();
  await page.locator('#tex-setup-recheck').click();
  await expect(page.locator('#tex-setup-start')).toBeEnabled();
  await page.locator('#tex-setup-browse').click();
  await expect(page.locator('#tex-setup-parent')).toBeDisabled();
  await page.locator('#tex-setup-close').click();
  await page.evaluate(() => resolvePicker({ path: '/late/selection', cancelled: false }));
  await expect(page.locator('#open-setup')).toBeFocused();
  await page.locator('#open-setup').click();
  await expect(page.locator('#tex-setup-parent')).toHaveValue('/Users/Example/Applications');
  expect(await starts(page)).toHaveLength(0);
});

test('狭い英語画面で内容と操作を読め，導入中に原稿を変えた場合は古い原稿をコンパイルしない', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.evaluate(() => setLanguage('en'));
  await page.locator('#open-setup').click();
  await expect(page.locator('#tex-setup-start')).toHaveText('Download and install');
  const overflow = await page.locator('#tex-setup-dialog').evaluate(dialog => ({ scroll: dialog.scrollWidth, client: dialog.clientWidth, right: dialog.getBoundingClientRect().right }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
  expect(overflow.right).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('tex-setup-english-mobile.png') });
  await page.locator('#tex-setup-start').click();
  await page.evaluate(async () => { target = { root: '/projects/other', main: 'other.tex' }; setSnapshot({ status: 'succeeded', stage: 'complete', managed: true, bin: '/managed/tex/bin' }); await setup.refresh(); });
  await expect(page.locator('#tex-setup-compile')).toBeDisabled();
  await expect(page.locator('#tex-setup-progress-panel')).toContainText('The current document changed.');
  expect(await page.evaluate(() => compiled)).toEqual([]);
});

test('最後の処理がパッケージ追加でも，新規導入では固定された TinyTeX の取得元と内容を示す', async ({ page }) => {
  await page.evaluate(async () => {
    setSnapshot({ status: 'succeeded', id: 'previous-packages', operation: 'packages', source: 'https://mirror.ctan.org/systems/texlive/tlnet/', packages: ['siunitx'], managed: true, bin: '/managed/tex/bin',
      install: { source: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1-windows-v2026.11.exe', archiveBytes: 73710178,
        packages: ['latexmk', 'synctex', 'collection-langjapanese'], parent: '/Users/Example/New TeX', release: 'v2026.11' } });
    await setup.refresh();
  });
  await expect(page.locator('#tex-setup-home')).toBeVisible();
  await expect(page.locator('#home-tex-setup')).toHaveText('TeX をセットアップ…');
  await expect(page.locator('#home-tex-management')).toHaveText('TeX を管理…');
  await expect(page.locator('#home-tex-management')).toBeEnabled();
  await page.locator('#home-tex-management').click();
  expect(await page.evaluate(() => managementOpened)).toBe(1);
  await page.evaluate(() => setLanguage('en'));
  await expect(page.locator('#home-tex-setup')).toHaveText('Set up TeX…');
  await expect(page.locator('#home-tex-management')).toHaveText('Manage TeX…');
  await page.locator('#home-tex-setup').click();
  await expect(page.locator('#tex-setup-source')).toHaveAttribute('href', /TinyTeX-1-windows-v2026\.11\.exe$/);
  await expect(page.locator('#tex-setup-package-list > li')).toHaveText(['latexmk', 'synctex', 'collection-langjapanese']);
  await expect(page.locator('#tex-setup-parent')).toHaveValue('/Users/Example/New TeX');
  expect(await starts(page)).toEqual([]);
});

test('Store の共用 TeX への追加は公式管理ツールを開き，アプリ用の導入も選べる', async ({ page }) => {
  await page.evaluate(() => {
    server = { ...server, environment: { directory: 'C:/texlive/2026', managerApplication: 'C:/texlive/2026/bin/windows/tlshell.exe', canInstallPackages: false } };
    meta.texPackages = { ...meta.texPackages, manager: 'C:/texlive/2026/bin/windows/tlmgr.bat', shell: 'powershell' };
    renderHelper();
  });
  await page.locator('[data-testid="tex-packages"] > summary').click();
  await expect(page.locator('[data-testid="tex-packages"] textarea')).toHaveCount(0);
  await expect(page.locator('[data-testid="tex-package-names"]')).toHaveCount(0);
  await page.locator('[data-testid="tex-package-open-manager"]').click();
  expect(await page.evaluate(() => managerOpened)).toBe(1);
  await page.locator('[data-testid="tex-package-setup"]').click();
  await expect(page.locator('#tex-setup-start')).toBeEnabled();
  expect(await starts(page)).toEqual([]);
});
