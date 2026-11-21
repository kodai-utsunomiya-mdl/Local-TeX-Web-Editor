import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installAndCheckTeX, removeAndCheckTeX } from './tex-setup-checks.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const executable = process.env.LOCAL_TEX_EDITOR_TEST_EXE || (process.platform === 'darwin'
  ? path.join(process.env.LOCAL_TEX_EDITOR_TEST_MAC_APP || path.join(repository, 'dist/macos/Local TeX Web Editor.app'), 'Contents/MacOS/local-tex-web-editor')
  : path.join(repository, 'bin/local-tex-web-editor.exe'));
const output = path.join(repository, 'test-results/tex-setup');
const removing = process.argv.includes('--remove');
const previous = removing ? JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8')) : null;
const temporary = previous?.temporary || await mkdtemp(path.join(os.tmpdir(), 'ltex-setup-'));
const readyFile = path.join(temporary, 'ready.json');
await mkdir(output, { recursive: true });
let processHandle, ready, applicationOutput = '';
const tokens = [];

async function start() {
  await rm(readyFile, { force: true });
  let startupError;
  processHandle = spawn(executable, ['--no-browser', '--config-dir', path.join(temporary, 'config'), '--ready-file', readyFile], {
    cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.on('error', error => { startupError = error; });
  processHandle.stdout.on('data', data => { applicationOutput += data; });
  processHandle.stderr.on('data', data => { applicationOutput += data; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (processHandle.exitCode !== null) throw new Error(`Application exited during startup: ${processHandle.exitCode}.`);
    try {
      const value = JSON.parse(await readFile(readyFile, 'utf8'));
      if (value.url && value.token) { ready = value; tokens.push(value.token); return; }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(100);
  }
  throw new Error('The application did not write its ready file.');
}

async function request(endpoint, data, method = data === undefined ? 'GET' : 'POST') {
  return fetch(new URL(endpoint, ready.url), {
    method, headers: { Origin: new URL(ready.url).origin, 'X-Local-Token': ready.token, 'Accept-Language': 'en', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(endpoint.includes('/tex/setup/delete') ? 660_000 : 20_000),
  });
}
async function api(endpoint, data, method) {
  const response = await request(endpoint, data, method);
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}\n${text}`);
  return JSON.parse(text);
}
async function stop() {
  if (ready && processHandle?.exitCode === null) await api('/api/shutdown', {}).catch(() => {});
  if (processHandle?.exitCode === null && processHandle.signalCode === null) {
    await Promise.race([once(processHandle, 'exit'), delay(20_000)]);
  }
  if (processHandle?.exitCode === null && processHandle.signalCode === null) {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await once(killer, 'exit');
    } else processHandle.kill('SIGKILL');
  }
}

try {
  await start();
  if (removing) {
    await removeAndCheckTeX({ api, request, temporary, output, directory: previous.directory });
    await stop();
    await start();
    const reopened = await api('/api/state');
    assert.equal(reopened.texSetup.managed, false);
    assert.notEqual(reopened.texBin, previous.bin);
    console.log('The TeX environment was removed after reviewing its files. Project files are intact.');
  } else {
  const result = await installAndCheckTeX({ api, request, temporary, output });
  result.temporary = temporary;
  await stop();
  await start();
  const reopened = await api('/api/state');
  assert.equal(reopened.texBin, result.bin);
  assert.equal(reopened.texSetup.managed, true);
  assert.ok(reopened.latexmk && reopened.synctex);
  assert.notEqual(reopened.texSetup.status, 'running');
  result.checks.push('restart-without-downloading');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `LOCAL_TEX_EDITOR_TEST_TEX_BIN=${result.bin}\n`);
  console.log(`The remaining tests will use the TeX installed through the application: ${result.bin}`);
  }
} finally {
  await stop();
  await writeFile(path.join(output, 'application.log'), tokens.reduce((text, token) => text.replaceAll(token, '[local session token]'), applicationOutput));
  // The following workflow steps compile with this TeX installation. The
  // disposable runner removes its temporary directory after the workflow.
}
