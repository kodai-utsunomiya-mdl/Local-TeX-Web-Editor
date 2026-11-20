import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function launchLifecycleBrowser(profile) {
  // Playwright normally emulates a focused page. Chromium rejects freezing a
  // visible page, so use its public CDP connection option to leave focus alone.
  await mkdir(profile, { recursive: true });
  const child = spawn(chromium.executablePath(), [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  let stderr = '';
  let browser;
  child.on('error', error => { startupError = error; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-20_000); });
  const running = () => child.exitCode === null && child.signalCode === null && Boolean(child.pid);

  async function close() {
    if (browser?.isConnected()) {
      const control = await browser.newBrowserCDPSession().catch(() => null);
      await control?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (running()) await Promise.race([once(child, 'exit').catch(() => {}), delay(4000)]);
    if (running()) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await Promise.race([once(killer, 'exit').catch(() => {}), delay(3000)]);
      } else {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit').catch(() => {}), delay(3000)]);
      }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }

  try {
    const deadline = Date.now() + 20_000;
    let endpoint;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (!running()) throw new Error(`Chromium exited before its CDP endpoint was ready.\n${stderr}`);
      const activePort = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const port = Number(activePort.split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        endpoint = `http://127.0.0.1:${port}`;
        break;
      }
      await delay(100);
    }
    if (!endpoint) throw new Error(`Chromium did not write its CDP endpoint.\n${stderr}`);
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true });
    const context = browser.contexts()[0];
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(20_000);
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: 1600, height: 1000 });
    return { context, page, close };
  } catch (error) {
    await close();
    throw error;
  }
}
