import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const repository = path.resolve(import.meta.dirname, '..');
export const fixture = path.join(import.meta.dirname, 'fixtures', 'japanese');
export const executable = path.resolve(process.env.LOCAL_TEX_EDITOR_TEST_EXE ||
  path.join(repository, 'bin', process.platform === 'win32' ? 'local-tex-web-editor.exe' : 'local-tex-web-editor'));
export const applicationVersion = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;

export async function waitUntil(read, predicate, timeout, description) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await delay(150);
  }
  throw new Error(`${description}\nLast result: ${JSON.stringify(latest)}`);
}

export async function request(session, endpoint, { method = 'GET', data, token = true, headers = {} } = {}) {
  const response = await fetch(new URL(endpoint, session.url), {
    method,
    headers: {
      ...(token ? { 'X-Local-Token': session.token } : {}),
      Origin: new URL(session.url).origin,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20_000),
  });
  return response;
}

export async function json(session, endpoint, options) {
  const response = await request(session, endpoint, options);
  const content = await response.text();
  if (!response.ok) throw new Error(`${options?.method || 'GET'} ${endpoint}: HTTP ${response.status}\n${content}`);
  return JSON.parse(content);
}

export async function openProject(session) {
  return json(session, '/api/project/open', { method: 'POST', data: { path: session.project } });
}

export async function openEditor(page, session) {
  const connected = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/session' && response.status() === 200);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await connected;
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
}

export async function setAutoSave(page, enabled) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('autosave-setting').setChecked(enabled);
  await page.locator('#save-settings').click();
  await expect(page.getByTestId('autosave-setting')).not.toBeVisible();
}

export function redactOutput(text, token) {
  return token ? text.replaceAll(token, '[local session token]') : text;
}

export async function attachBuildFiles(testInfo, directory, prefix, recursive = false) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (recursive && entry.isDirectory()) {
      await attachBuildFiles(testInfo, file, `${prefix}-${entry.name}`, true);
    } else if (entry.isFile() && (/(?:\.fls|\.synctex(?:\.gz)?)$/.test(entry.name) || /^pdf-.*\.json$/.test(entry.name))) {
      await testInfo.attach(`${prefix}-${entry.name}`, {
        path: file,
        contentType: entry.name.endsWith('.gz') ? 'application/gzip' : entry.name.endsWith('.json') ? 'application/json' : 'text/plain',
      });
    }
  }
}

export async function attachStoredUI(testInfo, directory, tokens) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const content = await readFile(path.join(directory, entry.name), 'utf8');
    await testInfo.attach(`ui-state-${entry.name}`, {
      body: Buffer.from(tokens.reduce((text, token) => redactOutput(text, token), content)),
      contentType: 'application/json',
    });
  }
}

export const test = base.extend({
  interfaceLanguage: ['ja', { option: true }],
  projectDirectory: ['日本語の原稿 with spaces', { option: true }],
  session: async ({ interfaceLanguage, projectDirectory }, use, testInfo) => {
    await stat(executable).catch(() => {
      throw new Error(`Build the application before running browser tests: ${executable}`);
    });
    const temp = await mkdtemp(path.join(os.tmpdir(), 'ltex-'));
    const project = path.join(temp, projectDirectory);
    await cp(fixture, project, { recursive: true });
    const mainLineEnding = (await readFile(path.join(project, 'main.tex'), 'utf8')).includes('\r\n') ? '\r\n' : '\n';
    const readyFile = path.join(temp, 'ready.json');
    const args = ['--no-browser', '--ready-file', readyFile, '--config-dir', path.join(temp, 'config')];
    if (process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN) {
      args.push('--tex-bin', process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN);
    }
    let stdout = '';
    let stderr = '';
    let startupError;
    let session;
    let processHandle;
    const tokens = [];
    async function start() {
      await rm(readyFile, { force: true });
      startupError = undefined;
      processHandle = spawn(executable, args, {
        cwd: repository,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      processHandle.on('error', error => { startupError = error; });
      processHandle.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      processHandle.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      const ready = await waitUntil(async () => {
        if (startupError) throw startupError;
        if (processHandle.exitCode !== null) {
          throw new Error(`Application exited with code ${processHandle.exitCode}.\n${stderr}\n${stdout}`);
        }
        try { return JSON.parse(await readFile(readyFile, 'utf8')); }
        catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
          throw error;
        }
      }, value => Boolean(value?.url && value?.token), 20_000, 'Application did not write its ready file.');
      tokens.push(ready.token);
      return ready;
    }
    async function stop() {
      if (!processHandle) return;
      if (session && processHandle.exitCode === null) {
        await request(session, '/api/shutdown', { method: 'POST', data: {} }).catch(() => {});
      }
      if (processHandle.exitCode === null && processHandle.signalCode === null) {
        await Promise.race([once(processHandle, 'exit').catch(() => {}), delay(4000)]);
      }
      if (processHandle.exitCode === null && processHandle.signalCode === null && processHandle.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore',
          });
          await Promise.race([once(killer, 'exit').catch(() => {}), delay(3000)]);
        } else {
          processHandle.kill('SIGKILL');
        }
      }
    }
    try {
      session = { ...await start(), project, temp, mainLineEnding };
      if (interfaceLanguage) await json(session, '/api/storage', { method: 'PUT', data: { key: 'preferences', value: { language: interfaceLanguage } } });
      session.restart = async () => {
        await stop();
        Object.assign(session, await start());
      };
      session.isRunning = () => processHandle.exitCode === null && processHandle.signalCode === null;
      session.waitForExit = async () => {
        await expect.poll(() => processHandle.exitCode, { timeout: 15_000 }).toBe(0);
        expect(processHandle.signalCode).toBeNull();
        await expect.poll(() => stat(readyFile).then(() => true, error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        })).toBe(false);
      };
      await use(session);
    } finally {
      await stop();
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('application-output.txt', {
          body: Buffer.from(tokens.reduce((output, token) => redactOutput(output, token), `${stdout}\n${stderr}`)),
          contentType: 'text/plain',
        });
        await attachBuildFiles(testInfo, path.join(project, '.local-tex-editor', 'build'), 'tex');
        await attachBuildFiles(testInfo, path.join(temp, 'config', 'cache'), 'cache', true);
        await attachStoredUI(testInfo, path.join(temp, 'config', 'ui-state'), tokens);
      }
      await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
    }
  },
});
