import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { signedAppcast } from './app-update-release.mjs';

if (process.platform !== 'darwin') throw new Error('Run the Sparkle application-update check on macOS.');
const root = path.resolve(import.meta.dirname, '..');
const packagedApp = path.resolve(process.env.LOCAL_TEX_EDITOR_TEST_MAC_APP || path.join(root, 'dist/macos/Local TeX Web Editor.app'));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const previousVersion = '0.0.1';
assert.notEqual(version, previousVersion);
const execute = promisify(execFile);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'local-tex-sparkle-update-'));
const output = path.join(root, 'test-results/macos-update');
const installedApp = path.join(temporary, 'installed', 'Local TeX Web Editor.app');
const nextApp = path.join(temporary, 'next', 'Local TeX Web Editor.app');
const configuration = path.join(temporary, 'original configuration');
const project = path.join(temporary, 'saved manuscript');
const readyFile = path.join(temporary, 'application-ready.json');
const archiveFile = path.join(temporary, 'application-update.zip');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicText = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const defaultsDomain = `io.github.kodai-utsunomiya-mdl.local-tex-editor.update-test.${randomUUID()}`;
let published = false, archive, ready, browser, context, page, opening, passed = false;
const transitions = [];
const server = createServer((request, response) => {
  if (request.url === '/appcast.xml') {
    const feed = signedAppcast({ version: published ? version : previousVersion, date: new Date().toISOString(), asset: { url: `${feedOrigin}/update.zip` }, archive }, privateKey);
    response.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Length': feed.length });
    response.end(feed);
  } else if (request.url === '/update.zip') {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.length });
    response.end(archive);
  } else { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const feedOrigin = `http://127.0.0.1:${server.address().port}`;

async function waitFor(read, predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(200);
  }
  throw new Error(`${description}\nLast result: ${JSON.stringify(last)}`);
}

async function readReady() {
  try { return JSON.parse(await readFile(readyFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function api(endpoint, body, connection = ready) {
  const response = await fetch(new URL(endpoint, connection.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: new URL(connection.url).origin, 'X-Local-Token': connection.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}\n${text}`);
  return JSON.parse(text);
}

async function configureTestBundle(application, bundleVersion) {
  const plist = path.join(application, 'Contents/Info.plist');
  const metadata = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
  Object.assign(metadata, {
    CFBundleVersion: bundleVersion,
    CFBundleShortVersionString: bundleVersion,
    SUPublicEDKey: publicText,
    SUFeedURL: `${feedOrigin}/appcast.xml`,
    SUDefaultsDomain: defaultsDomain,
    SUEnableAutomaticChecks: true,
    SUAutomaticallyUpdate: true,
    SUVerifyUpdateBeforeExtraction: true,
    SURequireSignedFeed: true,
    // Only the temporary test copies allow the local HTTP fixture.
    NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
  });
  await writeFile(plist, JSON.stringify(metadata));
  await execute('/usr/bin/plutil', ['-convert', 'xml1', plist]);
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', application]);
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
}

try {
  await mkdir(output, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nBefore the update.\n\\end{document}\n');
  await execute('/usr/bin/ditto', [packagedApp, installedApp]);
  await execute('/usr/bin/ditto', [packagedApp, nextApp]);
  const previousServer = path.join(installedApp, 'Contents/MacOS/local-tex-web-editor');
  await execute('go', ['build', '-trimpath', `-ldflags=-s -w -X main.version=${previousVersion}`, '-o', previousServer, './cmd/local-tex-editor'], {
    cwd: root, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64' },
  });
  await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', previousServer]);
  await configureTestBundle(installedApp, previousVersion);
  await configureTestBundle(nextApp, version);
  await execute('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', nextApp, archiveFile]);
  archive = await readFile(archiveFile);

  opening = spawn('/usr/bin/open', ['-W', '-n', installedApp, '--args', '--startup', '--config-dir', configuration, '--ready-file', readyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError = '';
  opening.stderr.on('data', data => { launchError += data; });
  ready = await waitFor(readReady, value => value?.version === previousVersion, 'The previous application did not start.');
  const previous = { ...ready };
  await api('/api/project/open', { path: project });
  // A temporary configuration saves the preference, then reports that it cannot
  // change the runner's actual login registration. The update must still resume.
  const disableResponse = await fetch(new URL('/api/startup', ready.url), {
    method: 'POST', headers: { Origin: new URL(ready.url).origin, 'X-Local-Token': ready.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(disableResponse.status, 501, await disableResponse.text());
  assert.equal(JSON.parse(await readFile(path.join(configuration, 'settings.json'), 'utf8')).startupEnabled, false);
  assert.equal((await api('/api/updates')).automatic, true);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1500, height: 960 }, locale: 'ja-JP' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  await page.clock.install();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${ready.url}#token=${encodeURIComponent(ready.token)}`);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#app-version')).toHaveText(`v${previousVersion}`);
  const savedText = '\\documentclass{article}\n\\begin{document}\nSaved before the automatic update.\n\\end{document}\n';
  await editor.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.insertText(savedText);
  await page.keyboard.press('Meta+s');
  await waitFor(() => readFile(path.join(project, 'main.tex'), 'utf8'), value => value === savedText, 'The manuscript was not saved before the update.');
  await page.screenshot({ path: path.join(output, 'before-update.png') });

  // Advance the browser's idle clock, then let the real backend and Sparkle
  // perform the normal automatic installation and relaunch.
  await page.clock.fastForward(61000);
  published = true;
  await api('/api/updates/check', {});
  ready = await waitFor(async () => {
    const current = await readReady();
    if (current?.version === version && current.pid !== previous.pid) return current;
    try {
      const update = await api('/api/updates', undefined, previous);
      if (transitions.at(-1)?.phase !== update.phase) transitions.push({ phase: update.phase, error: update.error, message: update.message });
      if (update.phase === 'error') throw new Error(`Sparkle update failed: ${update.error}`);
    } catch (error) {
      if (error.message.startsWith('Sparkle update failed:')) throw error;
    }
    if (opening.exitCode !== null && opening.exitCode !== 0) throw new Error(`Launch Services failed: ${launchError}`);
    return null;
  }, value => Boolean(value), 'Sparkle did not replace and relaunch the application.', 180000);

  assert.equal(ready.url, previous.url, 'The update must return to the original browser address.');
  assert.equal(ready.token, previous.token, 'The restored tab must reconnect to the same local session.');
  const resumedArguments = (await execute('/bin/ps', ['-ww', '-p', String(ready.pid), '-o', 'args='])).stdout.trim();
  assert.match(resumedArguments, /(?:^|\s)--background(?:\s|$)/);
  assert.doesNotMatch(resumedArguments, /(?:^|\s)--startup(?:\s|$)/);
  assert.equal(JSON.parse(await readFile(path.join(configuration, 'settings.json'), 'utf8')).startupEnabled, false);
  await expect(page.locator('#app-version')).toHaveText(`v${version}`, { timeout: 30000 });
  await expect(editor).toContainText('Saved before the automatic update.');
  await expect(page.locator('#connection-status')).toHaveClass(/connected/);
  const current = await api('/api/state');
  assert.equal(current.project.root, await realpath(project));
  assert.equal(await readFile(path.join(project, 'main.tex'), 'utf8'), savedText);
  const installedMetadata = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(installedApp, 'Contents/Info.plist')])).stdout);
  assert.equal(installedMetadata.CFBundleVersion, version);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: path.join(output, 'after-update.png') });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ from: previousVersion, to: version, architecture: process.arch, checks: ['signed-feed', 'signed-archive', 'automatic-download', 'automatic-install', 'original-configuration', 'restored-browser-tab', 'saved-manuscript', 'startup-disabled-during-update'], startupEnabled: false, resumedWith: '--background', transitions }, null, 2));
  passed = true;
  console.log(`Sparkle updated ${previousVersion} to ${version} and restored the original editor.`);
} finally {
  if (!passed) {
    await writeFile(path.join(output, 'transitions.json'), JSON.stringify(transitions, null, 2)).catch(() => {});
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  }
  await context?.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
  const latest = await readReady().catch(() => null);
  if (latest) await api('/api/shutdown', {}, latest).catch(() => {});
  if (ready) await api('/api/shutdown', {}, ready).catch(() => {});
  await browser?.close();
  if (opening?.exitCode === null) opening.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await execute('/usr/bin/defaults', ['delete', defaultsDomain]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
