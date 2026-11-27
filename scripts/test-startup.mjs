import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

async function waitFor(read, predicate, description) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`${description}\n${outputText}`);
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

async function start() {
  await rm(readyPath, { force: true });
  let launchError;
  child = spawn(executable, ['--no-browser', '--ready-file', readyPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.on('error', error => { launchError = error; });
  child.stdout.on('data', data => { outputText += data; });
  child.stderr.on('data', data => { outputText += data; });
  ready = await waitFor(async () => {
    if (launchError) throw launchError;
    assert.equal(child.exitCode, null, `The application exited before it was ready.\n${outputText}`);
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

function registered(state) {
  return process.platform === 'darwin' ? ['enabled', 'requires-approval', 'registered'].includes(state.status) : state.enabled;
}

try {
  await start();
  const initial = await waitFor(() => api('/api/startup'), registered, 'Start at login was not registered by default.');
  assert.equal(initial.supported, true);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, true);
  states.push({ phase: 'first-launch', ...initial });
  const disabled = await api('/api/startup', { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, 'disabled');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, false);
  states.push({ phase: 'disabled-in-settings', ...disabled });
  await stop();
  await start();
  const restarted = await api('/api/startup');
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.status, 'disabled');
  states.push({ phase: 'restart', ...restarted });
  await api('/api/settings/reset', { settings: true, confirmation: true });
  const reset = await api('/api/startup');
  assert.equal(registered(reset), true, 'Resetting settings did not restore the startup default.');
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).startupEnabled, true);
  states.push({ phase: 'settings-reset', ...reset });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ platform: process.platform, states }, null, 2));
  console.log('Start at login: initial registration, disabling, restart, and settings reset passed.');
} finally {
  if (ready && child?.exitCode === null) await api('/api/startup', { enabled: false }).catch(() => {});
  await stop().catch(() => {});
  if (child?.exitCode === null && child?.signalCode === null) child.kill();
  await writeFile(path.join(output, 'application.log'), tokens.reduce((text, token) => text.replaceAll(token, '[local token]'), outputText));
  await rm(temporary, { recursive: true, force: true });
}
