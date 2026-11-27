import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Run the startup checks on Windows or macOS.');
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('These startup checks require a disposable GitHub Actions runner.');
const root = path.resolve(import.meta.dirname, '..');
const application = process.env.LOCAL_TEX_EDITOR_TEST_MAC_APP || path.join(root, 'dist/macos/Local TeX Web Editor.app');
const executable = process.platform === 'win32'
  ? process.env.LOCAL_TEX_EDITOR_TEST_EXE || path.join(root, 'bin/local-tex-web-editor.exe')
  : path.join(application, 'Contents/MacOS/local-tex-web-editor');
const config = process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'LocalTeXEditor')
  : path.join(os.homedir(), 'Library/Application Support/LocalTeXEditor');
const settingsPath = path.join(config, 'settings.json');
await readFile(settingsPath).then(() => { throw new Error('The startup checks require a fresh default settings folder.'); }, error => {
  if (error.code !== 'ENOENT') throw error;
});
const temporary = await mkdtemp(path.join(os.tmpdir(), 'local-tex-startup-'));
const readyPath = path.join(temporary, 'ready.json');
const output = path.join(root, 'test-results', `startup-${process.platform}`);
await mkdir(output, { recursive: true });
let child, ready, settingsGeneration = '', outputText = '';
const states = [];
const tokens = [];
const startupWhileDisabled = [];
const execute = promisify(execFile);
let shortcuts = [], shortcutResults = [];

function applicationLog() {
  return tokens.reduce((text, token) => text.replaceAll(token, '[local token]'), outputText)
    .replace(/("token"\s*:\s*")[^"]+(")/g, '$1[local token]$2');
}

async function unloadMacStartupJob() {
  if (process.platform !== 'darwin') return;
  const service = `gui/${process.getuid()}/io.github.kodai-utsunomiya-mdl.local-tex-editor.background`;
  try {
    await execute('/bin/launchctl', ['bootout', service], { timeout: 20000 });
  } catch (error) {
    // A job that was not loaded (for example while awaiting OS approval) has
    // nothing to unload. A job that is still loaded must be cleaned up.
    try { await execute('/bin/launchctl', ['print', service], { timeout: 20000 }); }
    catch { return; }
    throw error;
  }
}

async function exists(filename) {
  return lstat(filename).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function windowsShortcutPaths() {
  const script = `@('Programs', 'DesktopDirectory') | ForEach-Object {
    $folder = [Environment]::GetFolderPath([Environment+SpecialFolder]::$_, [Environment+SpecialFolderOption]::DoNotVerify)
    @{ destination = $_; path = [IO.Path]::Combine($folder, 'Local TeX Web Editor.lnk') }
  } | ConvertTo-Json -Compress`;
  return JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout);
}

async function readWindowsShortcuts() {
  const script = `$shell = New-Object -ComObject WScript.Shell
  @('Programs', 'DesktopDirectory') | ForEach-Object {
    $folder = [Environment]::GetFolderPath([Environment+SpecialFolder]::$_, [Environment+SpecialFolderOption]::DoNotVerify)
    $file = [IO.Path]::Combine($folder, 'Local TeX Web Editor.lnk')
    $link = $shell.CreateShortcut($file)
    @{ destination = $_; path = $file; executable = $link.TargetPath; arguments = $link.Arguments }
  } | ConvertTo-Json -Compress`;
  return JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).stdout);
}

async function waitFor(read, predicate, description) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`${description}\n${applicationLog()}`);
}

async function api(endpoint, data) {
  const response = await fetch(new URL(endpoint, ready.url), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Local-Token': ready.token, Origin: new URL(ready.url).origin, 'X-Settings-Generation': settingsGeneration,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(20000),
  });
  settingsGeneration = response.headers.get('X-Settings-Generation') || settingsGeneration;
  const text = await response.text();
  assert.equal(response.ok, true, `${endpoint}: HTTP ${response.status}\n${text}`);
  return JSON.parse(text);
}

async function start(mode = '--no-browser') {
  await rm(readyPath, { force: true });
  let launchError;
  child = spawn(executable, [mode, '--ready-file', readyPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.on('error', error => { launchError = error; });
  child.stdout.on('data', data => { outputText += data; });
  child.stderr.on('data', data => { outputText += data; });
  ready = await waitFor(async () => {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, `The application exited before it was ready.\n${applicationLog()}`);
    try { return JSON.parse(await readFile(readyPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }, value => Boolean(value?.url && value?.token), 'The application did not start.');
  tokens.push(ready.token);
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await api('/api/shutdown', {});
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, Boolean, 'The application did not exit.');
  ready = null;
}

async function checkDisabledStartup(command, entry) {
  const disabledReadyPath = path.join(temporary, `${entry}-disabled.json`);
  try {
    const result = await execute(command, ['--startup', '--ready-file', disabledReadyPath], { timeout: 25000, windowsHide: true });
    outputText += result.stdout + result.stderr;
  } catch (error) {
    outputText += (error.stdout || '') + (error.stderr || '');
    throw new Error(`The disabled startup did not exit successfully through ${entry}.\n${applicationLog()}`);
  }
  assert.equal(await exists(disabledReadyPath), false, `${entry} opened the application while start at login was disabled.`);
  assert.equal(await exists(path.join(config, 'active.json')), false, `${entry} left an active application while start at login was disabled.`);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, false);
  startupWhileDisabled.push({ entry, exitCode: 0, readyFileCreated: false, activeFileCreated: false });
}

function registered(state) {
  return process.platform === 'darwin' ? ['enabled', 'requires-approval', 'registered'].includes(state.status) : state.enabled;
}

try {
  if (process.platform === 'win32') {
    const paths = await windowsShortcutPaths();
    for (const shortcut of paths) {
      assert.equal(path.isAbsolute(shortcut.path), true);
      assert.equal(await exists(shortcut.path), false, 'The shortcut checks require fresh Desktop and Start menu locations.');
    }
    shortcuts = paths;
  }
  await start();
  const initial = await waitFor(() => api('/api/startup'), registered, 'Start at login was not registered by default.');
  assert.equal(initial.supported, true);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, true);
  states.push({ phase: 'first-launch', ...initial });
  if (shortcuts.length) {
    await waitFor(() => Promise.all(shortcuts.map(shortcut => exists(shortcut.path))), values => values.every(Boolean), 'The initial Desktop and Start menu shortcuts were not created.');
    shortcutResults = await readWindowsShortcuts();
    for (const shortcut of shortcutResults) {
      assert.equal(path.normalize(shortcut.executable).toLowerCase(), path.normalize(initial.executable).toLowerCase());
      assert.equal(shortcut.arguments, '');
    }
    assert.equal(Boolean(JSON.parse(await readFile(settingsPath, 'utf8')).shortcutSetupPending), false);
    await rm(shortcuts.find(shortcut => shortcut.destination === 'DesktopDirectory').path);
  }
  const disabled = await api('/api/startup', { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, false);
  states.push({ phase: 'disabled-in-settings', ...disabled });
  await stop();
  await checkDisabledStartup(process.platform === 'win32' ? initial.executable : executable, 'backend');
  if (process.platform === 'darwin') await checkDisabledStartup(path.join(application, 'Contents/MacOS/LocalTeXWebEditor'), 'native-launcher');
  await start('--background');
  const restarted = await api('/api/startup');
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.status, 'disabled');
  states.push({ phase: 'restart', arguments: ['--background'], ...restarted });
  if (shortcuts.length) assert.equal(await exists(shortcuts.find(shortcut => shortcut.destination === 'DesktopDirectory').path), false, 'Restarting recreated a desktop shortcut that the user removed.');
  await api('/api/settings/reset', { settings: true, confirmation: true });
  const reset = await api('/api/startup');
  assert.equal(registered(reset), true, 'Resetting settings did not restore the startup default.');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, true);
  states.push({ phase: 'settings-reset', ...reset });
  if (shortcuts.length) {
    assert.equal(Boolean(JSON.parse(await readFile(settingsPath, 'utf8')).shortcutSetupPending), false);
    assert.equal(await exists(shortcuts.find(shortcut => shortcut.destination === 'DesktopDirectory').path), false, 'Resetting settings recreated a desktop shortcut that the user removed.');
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ platform: process.platform, states, startupWhileDisabled, backgroundResume: true, shortcuts: shortcutResults }, null, 2));
  console.log('Start at login: initial registration, disabling, disabled startup, background resume, and settings reset passed.');
} finally {
  if (ready && child?.exitCode === null) await api('/api/startup', { enabled: false }).catch(() => {});
  await unloadMacStartupJob().catch(() => {});
  await stop().catch(() => {});
  if (child?.exitCode === null && child?.signalCode === null) child.kill();
  for (const shortcut of shortcuts) await rm(shortcut.path, { force: true });
  await writeFile(path.join(output, 'application.log'), applicationLog());
  await rm(temporary, { recursive: true, force: true });
}
