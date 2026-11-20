import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41544';
const currentPath = '/projects/current project';
let javascript;

test.beforeAll(async () => {
  const bundled = await build({ stdin: {
    resolveDir: path.join(repository, 'web/src'),
    contents: `import { createProjectHome } from './project-home.js';
      import { setLanguage } from './i18n.js';
      setLanguage('ja');
      window.meta = { project: { root: '/projects/current project' }, build: { status: 'success' },
        recentProjects: ['/projects/other', '/projects/current project', '/projects/other', ...Array.from({ length: 15 }, (_, index) => '/projects/project-' + index)] };
      window.requests = []; window.opened = []; window.resumes = 0; window.events = []; window.errors = []; window.notices = [];
      window.blocked = false; window.failInspection = false; window.conflictOnce = false; window.deferBegin = false; window.deferDeleted = false;
      window.inspectionFor = path => ({ path, name: path.split('/').pop(), fileCount: 2, directoryCount: 1, revision: 'first',
        entries: [{ path: 'main.tex', directory: false, size: 128 }, { path: 'figures', directory: true, size: 0 }, { path: 'figures/plot.png', directory: false, size: 16 }],
        draftPaths: ['notes/draft.md'] });
      window.home = createProjectHome({ list: document.getElementById('welcome-recent-list'),
        getMeta: () => meta, getUnsavedPaths: root => root === meta.project?.root ? ['main.tex', 'notes/unsaved.md'] : [],
        isBlocked: () => blocked,
        beginAction: async () => { events.push('begin'); if (deferBegin) await new Promise(resolve => window.releaseBegin = resolve); blocked = true; },
        endAction: async () => { events.push('end'); blocked = false; },
        onOpen: async path => { opened.push(path); }, onResume: () => { resumes++; },
        onDeleted: async result => {
          events.push('deleted-start'); if (deferDeleted) await new Promise(resolve => window.releaseDeleted = resolve);
          meta.project = null; meta.recentProjects = meta.recentProjects.filter(path => !result.removedProjects.includes(path)); events.push('deleted-end');
        },
        onError: error => errors.push(String(error.message || error)), onNotice: notice => notices.push(notice),
        api: async (endpoint, options = {}) => {
          requests.push({ endpoint, ...options }); const root = new URL(endpoint, location.origin).searchParams.get('path');
          if (options.method !== 'DELETE') { if (failInspection) throw new Error('Inspection failed'); return inspectionFor(root); }
          if (conflictOnce) {
            conflictOnce = false;
            const project = inspectionFor(root); project.revision = 'second'; project.entries.push({ path: 'added.tex', directory: false, size: 9 }); project.fileCount++;
            throw Object.assign(new Error('Contents changed'), { status: 409, data: { project } });
          }
          events.push('delete'); return { deleted: true, path: root, removedProjects: [root], state: { recentProjects: [] } };
        },
      });`,
  }, bundle: true, format: 'esm', write: false });
  javascript = bundled.outputFiles[0].text;
});

async function openHome(page) {
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/home.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (['/style.css', '/imports.css', '/project-home.css'].includes(pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', pathname.slice(1))) });
    if (pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/imports.css"><link rel="stylesheet" href="/project-home.css"></head>
      <body><div id="app-shell" class="app-shell home-mode"><header class="app-header">
      <button id="go-home" class="brand"><span class="brand-mark">T<span>E</span>X</span><span class="brand-name">Local TeX Web Editor</span></button>
      <div class="header-divider"></div><div class="project-heading">Projects</div><button id="sidebar-toggle">Files</button><div id="compile-bar" class="compile-bar">Compile</div>
      <span class="toolbar-spacer"></span><div class="mobile-view-switch">Editor PDF</div><button id="log-toggle">Log</button>
      <div class="header-actions"><button class="icon-button">O</button><button class="icon-button">S</button><button class="icon-button">T</button><button class="icon-button">?</button><button class="icon-button">Q</button></div></header>
      <main id="welcome" class="welcome"><div class="welcome-card"><h1 id="home-title">プロジェクト</h1><button id="welcome-open" class="button">プロジェクトフォルダーを開く</button>
      <div id="welcome-recent" class="welcome-recent"><h2>最近開いたプロジェクト</h2><div id="welcome-recent-list"></div></div></div></main></div>
      <script type="module" src="/home.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.home))).toBe(true);
}
const currentCard = page => page.locator(`[data-project-path="${currentPath}"]`);
async function fillConfirmation(page) {
  await page.locator('#project-delete-acknowledge').check();
  await page.locator('#project-delete-name').fill('current project');
}

test('現在のプロジェクトを先頭に置き，重複なく開く操作と編集に戻る操作を使う', async ({ page }) => {
  await openHome(page);
  await expect(page.locator('.project-home-card')).toHaveCount(12);
  await expect(page.locator('.project-home-card').first()).toHaveAttribute('data-project-path', currentPath);
  await expect(currentCard(page).locator('.project-home-current')).toHaveText('編集中のプロジェクト');
  await expect(currentCard(page).locator('[data-action="delete"]')).toHaveText('削除…');
  await currentCard(page).locator('[data-action="resume"]').click();
  expect(await page.evaluate(() => resumes)).toBe(1);
  await page.locator('[data-project-path="/projects/other"] [data-action="open"]').click();
  expect(await page.evaluate(() => opened)).toEqual(['/projects/other']);
  expect(await page.evaluate(() => requests)).toEqual([]);
  await page.evaluate(() => { meta.build.status = 'running'; home.refresh(); });
  await expect(currentCard(page).locator('[data-action="resume"]')).toBeEnabled();
  await expect(page.locator('[data-project-path="/projects/other"] [data-action="open"]')).toBeDisabled();
  await expect(currentCard(page).locator('[data-action="delete"]')).toBeDisabled();
});

test('コンパイル状況の更新中も，カードのキー操作を続けられる', async ({ page }) => {
  await openHome(page);
  const resume = currentCard(page).locator('[data-action="resume"]');
  await resume.focus();
  expect(await page.evaluate(() => {
    const before = document.activeElement;
    home.refresh(); home.refresh();
    return before === document.activeElement;
  })).toBe(true);
  await page.evaluate(() => { meta.build.status = 'running'; home.refresh(); });
  await expect(resume).toBeFocused();
  await page.evaluate(() => home.refresh());
  await expect(resume).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => resumes)).toBe(1);
  await page.evaluate(() => { meta.build.status = 'success'; home.refresh(); });
  await expect(resume).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(currentCard(page).locator('[data-action="delete"]')).toBeFocused();
});

test('一覧と未保存の原稿・草稿を確認し，名前とチェックをそろえても Enter では削除しない', async ({ page }) => {
  await openHome(page);
  await page.evaluate(() => { deferBegin = true; });
  await currentCard(page).locator('[data-action="delete"]').click();
  await expect.poll(() => page.evaluate(() => events)).toEqual(['begin']);
  expect(await page.evaluate(() => requests.length)).toBe(0);
  await page.evaluate(() => releaseBegin());
  await expect(page.locator('#project-delete-dialog')).toBeVisible();
  await expect(page.locator('#project-delete-cancel')).toBeFocused();
  await expect(page.locator('#project-delete-path')).toHaveText(currentPath);
  await expect(page.locator('#project-delete-count')).toHaveText('ファイル 2 件・フォルダー 1 件');
  await expect(page.locator('#project-delete-entries li')).toHaveCount(3);
  await expect(page.locator('#project-delete-unsaved')).toContainText('notes/unsaved.md');
  await expect(page.locator('#project-delete-drafts')).toContainText('notes/draft.md');
  const confirm = page.locator('#project-delete-confirm');
  await expect(confirm).toHaveText('プロジェクトを削除');
  await expect(confirm).toBeDisabled();
  await page.locator('#project-delete-name').fill('current project'); await expect(confirm).toBeDisabled();
  await page.locator('#project-delete-acknowledge').check(); await expect(confirm).toBeEnabled();
  await page.locator('#project-delete-name').fill('Current project'); await expect(confirm).toBeDisabled();
  await page.locator('#project-delete-name').fill('current project '); await expect(confirm).toBeDisabled();
  await page.locator('#project-delete-name').fill('current project');
  await page.locator('#project-delete-name').press('Enter');
  expect(await page.evaluate(() => requests.filter(request => request.method === 'DELETE').length)).toBe(0);
  await page.locator('#project-delete-cancel').click();
  await expect(page.locator('#project-delete-dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => events)).toEqual(['begin', 'end']);
  await expect(currentCard(page).locator('[data-action="delete"]')).toBeFocused();
  expect(await page.evaluate(() => requests[0].projectRoot)).toBe(null);
  expect(await page.evaluate(() => requests[0].timeout)).toBe(120000);
});

test('削除の完了処理を待ってからダイアログを閉じ，操作中は二重に送信しない', async ({ page }) => {
  await openHome(page); await page.evaluate(() => { deferDeleted = true; });
  await currentCard(page).locator('[data-action="delete"]').click(); await fillConfirmation(page);
  await page.locator('#project-delete-confirm').click();
  await expect.poll(() => page.evaluate(() => events.includes('deleted-start'))).toBe(true);
  await expect(page.locator('#project-delete-dialog')).toBeVisible();
  await expect(page.locator('#project-delete-confirm')).toBeDisabled();
  await expect(page.locator('#project-delete-cancel')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#project-delete-dialog')).toBeVisible();
  expect(await page.evaluate(() => events.includes('end'))).toBe(false);
  await page.evaluate(() => releaseDeleted());
  await expect(page.locator('#project-delete-dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => events)).toEqual(['begin', 'delete', 'deleted-start', 'deleted-end', 'end']);
  await expect(currentCard(page)).toHaveCount(0);
  expect(await page.evaluate(() => requests.filter(request => request.method === 'DELETE'))).toEqual([{
    endpoint: `/api/project/delete?path=${encodeURIComponent(currentPath)}`, method: 'DELETE', projectRoot: null, timeout: 120000,
    body: { path: currentPath, revision: 'first', confirmation: 'current project' },
  }]);
  expect(await page.evaluate(() => notices)).toEqual(['プロジェクト「current project」を削除しました．']);
});

test('確認後に内容が変わると一覧を更新し，名前とチェックをもう一度求める', async ({ page }) => {
  await openHome(page); await page.evaluate(() => { conflictOnce = true; });
  await currentCard(page).locator('[data-action="delete"]').click(); await fillConfirmation(page);
  await page.locator('#project-delete-confirm').click();
  await expect(page.locator('#project-delete-message')).toBeVisible();
  await expect(page.locator('#project-delete-entries li')).toHaveCount(4);
  await expect(page.locator('#project-delete-entries')).toContainText('added.tex');
  await expect(page.locator('#project-delete-acknowledge')).not.toBeChecked();
  await expect(page.locator('#project-delete-name')).toHaveValue('');
  await expect(page.locator('#project-delete-confirm')).toBeDisabled();
  await expect(page.locator('#project-delete-cancel')).toBeFocused();
  expect(await page.evaluate(() => events.includes('end'))).toBe(false);
  await fillConfirmation(page); await page.locator('#project-delete-confirm').click();
  await expect(page.locator('#project-delete-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => requests.filter(request => request.method === 'DELETE').map(request => request.body.revision))).toEqual(['first', 'second']);
  expect(await page.evaluate(() => errors)).toEqual([]);
});

test('小さい画面でもロゴと長いパスを表示し，検査の失敗やキャンセル後に操作を再開できる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 }); await openHome(page);
  await page.evaluate(() => { meta.recentProjects.unshift('/projects/日本語を含むとても長いフォルダーの名前/さらに深い場所/長いプロジェクトの名前'); home.refresh(); });
  await expect(page.locator('#go-home')).toBeVisible();
  await expect(page.locator('#compile-bar')).not.toBeVisible();
  expect(await page.locator('.app-header').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.locator('#welcome').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.evaluate(() => { failInspection = true; });
  await currentCard(page).locator('[data-action="delete"]').click();
  await expect.poll(() => page.evaluate(() => events)).toEqual(['begin', 'end']);
  expect(await page.evaluate(() => errors)).toEqual(['Inspection failed']);
  await page.evaluate(() => { failInspection = false; });
  await currentCard(page).locator('[data-action="delete"]').click();
  await expect(page.locator('#project-delete-dialog')).toBeVisible();
  expect(await page.locator('#project-delete-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-delete-dialog')).not.toBeVisible();
  await expect(currentCard(page).locator('[data-action="delete"]')).toBeFocused();
  await expect.poll(() => page.evaluate(() => events.filter(event => event === 'end').length)).toBe(2);
});
