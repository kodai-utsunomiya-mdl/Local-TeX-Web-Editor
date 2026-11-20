import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

if (process.platform !== 'darwin') throw new Error('Run the macOS checks on macOS.');
const root = path.resolve(import.meta.dirname, '..');
const application = path.resolve(process.env.LOCAL_TEX_EDITOR_TEST_MAC_APP || path.join(root, 'dist/macos/Local TeX Web Editor.app'));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'test-results/macos');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'local-tex-web-editor-mac-'));
const project = path.join(temporary, '日本語の原稿 with spaces');
const readyPath = path.join(temporary, 'ready.json');
const execute = promisify(execFile);
await mkdir(output, { recursive: true });
await cp(path.join(root, 'tests/fixtures/japanese'), project, { recursive: true });
await writeFile(path.join(project, 'notes.md'), '# Mac での原稿\n\n数式 $`x^2`$ と **強調** を表示する．\n');
const other = '別の 原稿.tex';
await writeFile(path.join(project, other), '\\documentclass[uplatex,dvipdfmx]{jsarticle}\n\\begin{document}\nMac の別の文書をコンパイルする．\n\\end{document}\n');

async function waitFor(read, predicate, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let latest;
  while (Date.now() < end) {
    latest = await read();
    if (predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error(description);
}

let ready, browser, context, page, opening, passed = false;
async function api(endpoint, data) {
  const response = await fetch(new URL(endpoint, ready.url), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: new URL(ready.url).origin, 'X-Local-Token': ready.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}\n${text}`);
  return JSON.parse(text);
}
async function compile() {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/build' && response.request().method() === 'POST'),
    page.getByTestId('compile-button').click(),
  ]);
  assert.equal(response.ok(), true, await response.text());
  const started = await response.json();
  const finished = await waitFor(() => api('/api/build'), build => build.id === started.id && build.status !== 'running', 'TeX compilation did not finish.', 120000);
  await writeFile(path.join(output, `compile-${started.id}.log`), `${finished.log || ''}\n${finished.error || ''}`);
  assert.equal(finished.status, 'success', finished.log + '\n' + finished.error);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', finished.pdfBuildId, { timeout: 20000 });
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  return finished;
}

try {
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  for (const executable of ['LocalTeXWebEditor', 'local-tex-web-editor']) {
    await execute('/usr/bin/lipo', [path.join(application, 'Contents/MacOS', executable), '-verify_arch', 'arm64', 'x86_64']);
  }
  const icon = await readFile(path.join(application, 'Contents/Resources/app-icon.icns'));
  assert.equal(icon.toString('ascii', 0, 4), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length);
  const metadata = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(application, 'Contents/Info.plist')])).stdout);
  assert.equal(metadata.CFBundleShortVersionString, version);
  assert.equal(metadata.LSMinimumSystemVersion, '12.0');
  const launchArgs = ['-W', '-n', application, '--args', '--ready-file', readyPath, '--config-dir', path.join(temporary, 'config')];
  if (process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN) launchArgs.push('--tex-bin', process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN);
  opening = spawn('/usr/bin/open', launchArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError = '';
  opening.stderr.on('data', data => { launchError += data; });
  ready = await waitFor(async () => {
    if (opening.exitCode !== null) throw new Error(`Launch Services exited before the app started: ${launchError}`);
    try { return JSON.parse(await readFile(readyPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }, result => Boolean(result?.url && result?.token), 'The macOS application did not start.');
  assert.equal(ready.version, version);
  const initial = await api('/api/state');
  assert.equal(initial.platform, 'darwin');
  assert.ok(initial.latexmk, 'The selected TeX Live installation must provide latexmk.');
  assert.ok(initial.synctex, 'The selected TeX Live installation must provide SyncTeX.');
  await api('/api/project/open', { path: project });

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ja-JP' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${ready.url}#token=${encodeURIComponent(ready.token)}`);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 20000 });
  const source = await readFile(path.join(project, 'main.tex'), 'utf8');
  const changed = source.replace('\\end{document}', 'Mac のブラウザから保存した文章である．\n\\end{document}');
  await editor.click(); await page.keyboard.press('Meta+a'); await page.keyboard.insertText(changed);
  await page.keyboard.press('Meta+s');
  await waitFor(() => readFile(path.join(project, 'main.tex'), 'utf8'), value => value.includes('Mac のブラウザから保存した文章である．'), 'Command+S did not save the edited source.');
  const first = await compile();
  const forward = await api('/api/synctex/forward', { buildId: first.pdfBuildId, path: 'main.tex', line: 10, column: 0 });
  assert.ok(forward.locations?.length, 'SyncTeX must locate the Japanese source in the PDF.');
  const location = forward.locations[0];
  const inverse = await api('/api/synctex/inverse', { buildId: first.pdfBuildId, page: location.page, x: location.x, y: location.y });
  assert.equal(inverse.path, 'main.tex');
  assert.ok(inverse.line > 0);
  await page.getByTestId('pdf-next').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await page.screenshot({ path: path.join(output, 'macos-editor.png') });

  await page.getByTestId(`file-${other}`).click();
  await expect(page.getByTestId('pdf-document')).toHaveText('main.tex');
  const second = await compile();
  assert.equal(second.main, other); assert.equal(second.pdfMain, other);
  await expect(page.getByTestId('pdf-document')).toHaveText(other);
  assert.equal((await api('/api/state')).project.main, 'main.tex');

  await page.getByTestId('file-notes.md').click();
  await page.locator('#markdown-editor-mode').selectOption('source');
  const preview = page.getByTestId('markdown-document');
  await expect(preview.getByRole('heading', { name: 'Mac での原稿' })).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(1);
  await page.screenshot({ path: path.join(output, 'macos-markdown.png') });
  await page.locator('#markdown-preview-mode').selectOption('pdf');
  await expect(page.getByTestId('pdf-document')).toHaveText(other);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', second.pdfBuildId);
  await execute('/usr/bin/open', [application]);
  await delay(300);
  assert.equal(JSON.parse(await readFile(readyPath, 'utf8')).pid, ready.pid, 'Reopening the app must reuse the server.');
  assert.deepEqual(errors, []);

  // Use the editor's existing shutdown flow after saving and compiling.
  await page.locator('#shutdown-button').click();
  await waitFor(() => stat(readyPath).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; }), value => value, 'The editor did not finish shutdown.');
  await waitFor(() => opening.exitCode, value => value !== null, 'The macOS launcher did not exit with the server.');
  assert.equal(opening.exitCode, 0, launchError);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ version, architecture: process.arch, checks: ['universal-bundle', 'icon', 'signature', 'launch-services', 'api', 'command-save', 'japanese-tex', 'synctex', 'active-document', 'markdown', 'reopen', 'shutdown'] }, null, 2));
  passed = true;
  console.log(`macOS ${process.arch}: application launch, editing, TeX, previews, and shutdown passed.`);
} finally {
  if (!passed && page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  if (context) await context.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
  if (ready) await api('/api/shutdown', {}).catch(() => {});
  await browser?.close();
  if (opening?.exitCode === null) opening.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
