import { test as base, expect } from '@playwright/test';
import { build as bundle } from 'esbuild';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { checkEditorSelectionVisibility, checkPDFSelectionVisibility } from './selection-checks.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const fixture = path.join(import.meta.dirname, 'fixtures', 'japanese');
const executable = path.resolve(process.env.LOCAL_TEX_EDITOR_TEST_EXE ||
  path.join(repository, 'bin', process.platform === 'win32' ? 'local-tex-web-editor.exe' : 'local-tex-web-editor'));
const execFileAsync = promisify(execFile);
const applicationVersion = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version;

function exampleFigurePDF() {
  const content = 'BT /F1 18 Tf 30 100 Td (Figure PDF) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  return pdfFromObjects(objects);
}

function pdfFromObjects(objects) {
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function pdfWithRotatedPages() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>',
  ];
  for (const rotation of [0, 90, 180, 270]) {
    // The filled rectangle starts 40 points from the page's left edge
    // and 70 points from its top edge, with a width of 80 and a height of 18.
    const content = '0 g 40 312 80 18 re f\n';
    const contentObject = objects.length + 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate ${rotation} /Resources << >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  return pdfFromObjects(objects);
}

async function openPDFViewer(page, pdf) {
  const source = await readFile(path.join(repository, 'web/src/index.html'), 'utf8');
  const pane = source.match(/<section class="pdf-pane"[\s\S]*?<\/section>/)?.[0];
  expect(pane).toBeTruthy();
  const script = await bundle({
    stdin: {
      contents: `import { PDFViewer } from './pdf-viewer.js';
        import { setLanguage } from './i18n.js';
        setLanguage('ja');
        window.viewerErrors = [];
        window.inverseLocations = [];
        window.testViewer = new PDFViewer({ token: 'test-token',
          onError: error => window.viewerErrors.push(error.message),
          onInverse: location => window.inverseLocations.push(location) });
        await window.testViewer.load('test-build', 'test-project');`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  const assets = new Map([
    ['/viewer.js', { contentType: 'text/javascript', body: script.outputFiles[0].text }],
    ['/pdf.worker.min.mjs', { contentType: 'text/javascript', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')) }],
    ['/pdf_viewer.css', { contentType: 'text/css', body: await readFile(path.join(repository, 'node_modules/pdfjs-dist/web/pdf_viewer.css')) }],
    ['/style.css', { contentType: 'text/css', body: await readFile(path.join(repository, 'web/src/style.css')) }],
    ['/pdf-search.css', { contentType: 'text/css', body: await readFile(path.join(repository, 'web/src/pdf-search.css')) }],
    ['/api/pdf', { contentType: 'application/pdf', body: pdf }],
    ['/', { contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="/pdf_viewer.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/pdf-search.css">
      <style>#pdf-pane { width: 900px; height: 900px; }</style>
      </head><body>${pane}<script type="module" src="/viewer.js"></script></body></html>` }],
  ]);
  const origin = 'http://127.0.0.1:41537';
  await page.route(`${origin}/**`, async route => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    if (asset) await route.fulfill(asset);
    else await route.fulfill({ status: 404, body: '' });
  });
  await page.goto(origin);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
}

async function waitUntil(read, predicate, timeout, description) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await delay(150);
  }
  throw new Error(`${description}\nLast result: ${JSON.stringify(latest)}`);
}

async function request(session, endpoint, { method = 'GET', data, token = true, headers = {} } = {}) {
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

async function json(session, endpoint, options) {
  const response = await request(session, endpoint, options);
  const content = await response.text();
  if (!response.ok) throw new Error(`${options?.method || 'GET'} ${endpoint}: HTTP ${response.status}\n${content}`);
  return JSON.parse(content);
}

async function openProject(session) {
  return json(session, '/api/project/open', { method: 'POST', data: { path: session.project } });
}

async function openEditor(page, session) {
  const connected = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/session' && response.status() === 200);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await connected;
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
}

async function dragPanelSeparator(page, selector, { dx = 0, dy = 0, x, y } = {}) {
  const separator = page.locator(selector);
  await expect(separator).toBeVisible();
  const bounds = await separator.boundingBox();
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(x ?? start.x + dx, y ?? start.y + dy, { steps: 8 });
  } finally { await page.mouse.up(); }
}

async function readPanelLayout(page) {
  return page.evaluate(() => {
    const bounds = id => {
      const rectangle = document.getElementById(id).getBoundingClientRect();
      return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height,
        right: rectangle.right, bottom: rectangle.bottom };
    };
    return { sidebar: bounds('file-pane'), editor: bounds('editor-pane'), preview: bounds('pdf-pane'),
      log: bounds('log-panel'), workbench: bounds('workbench') };
  });
}

async function closeEditorTab(page, acceptUnsaved = false) {
  if (acceptUnsaved) page.once('dialog', dialog => dialog.accept());
  const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closed;
}

async function buildFinished(session, id) {
  return waitUntil(() => json(session, '/api/build'),
    build => build?.id === id && build.status !== 'running',
    100_000, 'The TeX process did not finish.');
}

async function compileFromUI(page, session) {
  const responsePromise = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/build' && response.request().method() === 'POST');
  await page.getByTestId('compile-button').click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  const started = await response.json();
  return { started, finished: await buildFinished(session, started.id) };
}

async function replaceEditor(page, content) {
  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(content);
}

function expectedMainContent(session, content) {
  return content.replaceAll('\r\n', '\n').replaceAll('\n', session.mainLineEnding);
}

async function setAutoSave(page, enabled) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('autosave-setting').setChecked(enabled);
  await page.locator('#save-settings').click();
  await expect(page.getByTestId('autosave-setting')).not.toBeVisible();
}

function redactOutput(text, token) {
  return token ? text.replaceAll(token, '[local session token]') : text;
}

async function attachBuildFiles(testInfo, directory, prefix, recursive = false) {
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

async function attachStoredUI(testInfo, directory, tokens) {
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

async function recordEmptySyncTeX(testInfo, session, buildId, forward) {
  const result = { includedFile: forward, mainFile: null, cli: [] };
  result.mainFile = await json(session, '/api/synctex/forward', {
    method: 'POST', data: { buildId, path: 'main.tex', line: 10, column: 1 },
  }).catch(error => ({ error: error.message }));
  const cacheRoot = path.join(session.temp, 'config', 'cache');
  const directories = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  for (const directory of directories.filter(entry => entry.isDirectory())) {
    const cwd = path.join(cacheRoot, directory.name);
    const metadata = await readFile(path.join(cwd, `pdf-${buildId}.json`), 'utf8')
      .then(JSON.parse, () => null);
    if (!metadata?.synctex?.bin) continue;
    const program = path.join(metadata.synctex.bin, process.platform === 'win32' ? 'synctex.exe' : 'synctex');
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^SYNCTEX_(?:VIEWER|EDITOR|BUILD_DIRECTORY)$/i.test(key)));
    for (const input of metadata.synctex.inputs || []) {
      if (!['main.tex', '追加の 原稿.tex'].includes(input.path)) continue;
      const line = input.path === 'main.tex' ? 10 : 2;
      const args = ['view', '-i', `${line}:1:${input.alias}`, '-o', `pdf-${buildId}.pdf`];
      const output = await execFileAsync(program, args, {
        cwd, windowsHide: true, timeout: 10_000, env: environment,
      }).then(value => ({ ...value, exitCode: 0 }), error => ({
        stdout: error.stdout, stderr: error.stderr, exitCode: error.code, message: error.message,
      }));
      result.cli.push({ source: input.path, args, ...output });
    }
  }
  const file = testInfo.outputPath('synctex-empty-result.json');
  await writeFile(file, JSON.stringify(result, null, 2));
  await testInfo.attach('synctex-empty-result.json', { path: file, contentType: 'application/json' });
}

const test = base.extend({
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

test.describe('Interface language', () => {
  test.use({ interfaceLanguage: null, projectDirectory: path.join('日本語の原稿', 'Research notes') });

  test('starts in English, saves and compiles, and reopens in the selected language', async ({ page, context, session }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    const notes = ['# Research notes', '', 'Keep derivations and reading notes beside the paper. Changes in this file appear in the preview as you type.', '',
      '## Regularized least squares', '', 'For a design matrix $`X`$ and observations $`y`$, consider', '',
      '$$', '\\mathcal{L}(w) = \\frac{1}{2n}\\|Xw-y\\|^2 + \\frac{\\lambda}{2}\\|w\\|^2.', '$$', '',
      'The regularization term controls the size of the coefficients. Differentiating gives the linear system', '',
      '$$', '(X^\\top X + n\\lambda I)\\widehat{w} = X^\\top y.', '$$', '',
      '## Writing checklist', '', '- [x] State the model and notation', '- [x] Check the normal equations', '- [ ] Add the experiment figure', '',
      '| File | Purpose |', '| --- | --- |', '| `main.tex` | Paper and derivation |', '| `references.bib` | Bibliography |', '| `notes.md` | Reading and experiment notes |', '',
      '## In the paper', '', '```tex', '\\section{Regularized least squares}', '\\label{sec:least-squares}', '```', '',
      '> Choose **PDF** in the preview selector to keep reading the compiled paper while editing these notes.',
    ].join('\n');
    await writeFile(path.join(session.project, 'notes.md'), notes);
    await openProject(session);
    await openEditor(page, session);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('main.tex — Local TeX Web Editor');
    await expect(page.locator('.brand')).toHaveAttribute('aria-label', 'Local TeX Web Editor');
    await expect(page.locator('#compile-label')).toHaveText('Compile');
    await expect(page.getByTestId('settings-button')).toHaveAccessibleName('Settings');
    await page.getByTestId('settings-button').click();
    await page.getByTestId('autosave-setting').uncheck();
    await page.getByTestId('tex-packages').locator('summary').first().click();
    await expect(page.getByTestId('tex-packages').locator('summary').first()).toHaveText('Add TeX packages');
    await page.getByTestId('tex-package-names').fill('siunitx');
    await expect(page.getByTestId('tex-package-install-command')).toHaveValue(/install(?: --reinstall)? siunitx/);
    await page.getByTestId('tex-packages').getByText('Find a package from a missing file', { exact: true }).click();
    await page.getByTestId('tex-package-filename').fill('siunitx.sty');
    await expect(page.getByTestId('tex-package-search-command')).toHaveValue(/search --global --file '\/siunitx\\\.sty\$'/);
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-dialog')).not.toBeVisible();
    const original = (await readFile(path.join(session.project, 'main.tex'), 'utf8')).replaceAll('\r\n', '\n');
    const example = String.raw`
\section{Regularized least squares}
Let $X$ be a design matrix with $n$ observations and let $y$ be the response vector.
We study the objective
\[
  L(w) = \frac{1}{2n}\|Xw-y\|^2 + \frac{\lambda}{2}\|w\|^2.
\]
The first term measures the residual on the observations. The second term penalizes
large coefficients and makes the normal equations nonsingular when $\lambda>0$.

\subsection{Normal equations}
Setting the derivative to zero gives
\[
  (X^{\mathsf T}X+n\lambda I)\widehat w=X^{\mathsf T}y.
\]
This formulation makes it straightforward to compare several values of $\lambda$
while using the same observations. In the experiment, we record both the residual
and the coefficient norm for each choice.

\subsection{Notes for the experiment}
The source, bibliography and notes live in one project folder. We keep the model
description next to the derivation so that changes to the assumptions can be
checked when preparing the figures.
\begin{center}
\begin{tabular}{ll}
\hline
Quantity & Description \\
\hline
$n$ & Number of observations \\
$\lambda$ & Regularization parameter \\
$\widehat w$ & Estimated coefficient vector \\
\hline
\end{tabular}
\end{center}
`;
    const source = original.replace('Local TeX Web Editor の動作確認', 'Research notes: a linear model').replace('\n\\newpage', `${example}\n\\newpage`);
    const content = `% 設定，コンパイル，プレビューは原稿の本文にも使う．\n${source}`;
    await replaceEditor(page, content);
    await page.keyboard.press('Control+S');
    await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content));
    await expect(page.locator('#save-status')).toHaveText('Saved');
    const compiled = await compileFromUI(page, session);
    expect(compiled.finished.status, compiled.finished.log + '\n' + compiled.finished.error).toBe('success');
    await expect(page.getByTestId('build-status')).toHaveText('Compilation complete');
    await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
    if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByTestId('theme-toggle').click();
    await page.getByTestId('editor').locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await expect(page.locator('#toast')).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('editor-english-dark-tex.png') });
    await page.getByTestId('pdf-zoom').selectOption('1');
    await page.getByTestId('pdf-next').click();
    await expect(page.getByTestId('pdf-page')).toHaveValue('2');
    const texProcessOutput = log => log.match(/\n\n([\s\S]*?)\n\[PDF\] /)?.[1];
    const output = texProcessOutput(await page.getByTestId('build-log').textContent());
    expect(output).toContain('This is ');
    expect(output).toContain('Output written on ');
    await page.locator('#find-button').click();
    await page.getByTestId('source-search-input').fill('設定');
    await expect(page.getByTestId('source-search-input')).toHaveAttribute('placeholder', 'Find');
    await page.getByTestId('pdf-search-toggle').click();
    await expect(page.getByTestId('pdf-search-input')).toHaveAttribute('placeholder', 'Find in PDF');

    async function chooseLanguage(value) {
      await page.getByTestId('settings-button').click();
      await page.getByTestId('language-setting').selectOption(value);
      await page.locator('#save-settings').click();
      await expect(page.locator('#settings-dialog')).not.toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', value);
    }
    await chooseLanguage('ja');
    await expect(page.locator('#compile-label')).toHaveText('コンパイル');
    await expect(page.getByTestId('source-search-input')).toHaveAttribute('placeholder', '検索する文字列');
    await expect(page.getByTestId('source-search-input')).toHaveValue('設定');
    await expect(page.getByTestId('pdf-search-input')).toHaveAttribute('placeholder', 'PDF 内で検索');
    await expect(page.getByTestId('pdf-page')).toHaveValue('2');
    await expect(page.getByTestId('pdf-zoom')).toHaveValue('1');
    await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', compiled.finished.pdfBuildId);
    expect((await json(session, '/api/build')).id).toBe(compiled.finished.id);
    expect(texProcessOutput(await page.getByTestId('build-log').textContent())).toBe(output);
    expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content));
    await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('設定，コンパイル，プレビューは原稿の本文にも使う．');
    await page.screenshot({ path: testInfo.outputPath('search-controls-japanese-dark.png') });
    await chooseLanguage('en');
    await expect(page.getByTestId('source-search-input')).toHaveAttribute('placeholder', 'Find');
    await page.getByTestId('source-search-input').press('Escape');
    await expect(page.getByTestId('source-search-input')).not.toBeVisible();
    await page.getByTestId('pdf-search-input').press('Escape');
    await expect(page.getByTestId('pdf-search-input')).not.toBeVisible();
    await page.getByTestId('file-notes.md').click();
    await expect(page.getByTestId('markdown-preview')).toBeVisible();
    await expect(page.getByTestId('markdown-document').getByRole('heading', { name: 'Research notes', exact: true })).toBeVisible();
    await expect(page.getByTestId('markdown-document').locator('.katex')).toHaveCount(4);
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.getByTestId('editor').locator('.cm-scroller').evaluate(element => element.scrollTop)).toBe(0);
    await expect(page.locator('#toast')).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('editor-english-light-markdown.png') });
    await page.locator('#editor-tabs [data-path="main.tex"]').click();
    const preferences = await json(session, '/api/storage?key=preferences');
    expect(preferences.value.language).toBe('en');
    expect(preferences.value.autoSave).toBe(false);
    await closeEditorTab(page);
    await session.waitForExit();
    await session.restart();
    const reopened = await context.newPage();
    reopened.on('pageerror', error => errors.push(error.message));
    await openEditor(reopened, session);
    await expect(reopened.locator('html')).toHaveAttribute('lang', 'en');
    await expect(reopened.getByTestId('settings-button')).toHaveAccessibleName('Settings');
    await expect(reopened.getByTestId('editor').locator('.cm-content')).toContainText('設定，コンパイル，プレビューは原稿の本文にも使う．');
    expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content));
    await reopened.getByTestId('settings-button').click();
    await expect(reopened.getByTestId('language-setting')).toHaveValue('en');
    await reopened.getByTestId('language-setting').selectOption('ja');
    await reopened.locator('#save-settings').click();
    await expect(reopened.getByTestId('settings-button')).toHaveAccessibleName('設定');
    expect((await json(session, '/api/storage?key=preferences')).value.language).toBe('ja');
    expect(errors).toEqual([]);
  });
});

test('起動時のエラーを無人実行でも受け取れる', async () => {
  const result = await execFileAsync(executable, ['--no-browser', '--listen', '0.0.0.0:0'], {
    windowsHide: true,
    timeout: 10_000,
  }).then(output => ({ ...output, code: 0, killed: false }), error => error);
  expect(result.code).toBe(1);
  expect(Boolean(result.killed)).toBe(false);
  expect(result.stderr).toContain('loopback');
});

test('起動中の版と実行ファイルを表示し，最後のタブを閉じるとアプリが終了する', async ({ page, session }) => {
  await openProject(session);
  await openEditor(page, session);
  const meta = await json(session, '/api/state');
  expect(meta.version).toBe(applicationVersion);
  await expect(page.locator('#app-version')).toHaveText(`v${applicationVersion}`);
  await page.getByTestId('settings-button').click();
  await expect(page.locator('#application-version')).toHaveText(`v${applicationVersion}`);
  await expect(page.locator('#application-executable')).toHaveText(meta.executablePath);
  expect(path.resolve(meta.executablePath)).toBe(executable);
  await page.keyboard.press('Escape');
  await closeEditorTab(page);
  await session.waitForExit();
});

test('重い読み込みを待つ再読み込みでも接続し直し，編集を続けられる', async ({ page, session }) => {
  await openProject(session);
  await openEditor(page, session);
  await page.route(url => url.pathname === '/api/state', async route => {
    await delay(6500);
    await route.continue();
  }, { times: 1 });
  const connected = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/session' && response.status() === 200);
  await page.reload();
  await connected;
  // This exceeds the interval used to close an application with no tabs.
  await delay(5600);
  expect(session.isRunning()).toBe(true);
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  const content = '% 再読み込み後も編集して保存できる\n';
  await replaceEditor(page, content);
  await page.keyboard.press('Control+S');
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content));
});

test('二つのタブのうち一方を閉じても動き続け，最後のタブを閉じると終了する', async ({ page, context, session }) => {
  await openProject(session);
  await openEditor(page, session);
  const second = await context.newPage();
  await openEditor(second, session);
  await closeEditorTab(page);
  await delay(5600);
  expect(session.isRunning()).toBe(true);
  expect((await json(session, '/api/state')).version).toBe(applicationVersion);
  await expect(second.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await closeEditorTab(second);
  await session.waitForExit();
});

test('タブを閉じる確認を取り消すと，接続したまま原稿を編集できる', async ({ page, session }) => {
  await openProject(session);
  await openEditor(page, session);
  await setAutoSave(page, false);
  const content = '% タブを閉じる操作を取り消す\n';
  await replaceEditor(page, content);
  const prompted = page.waitForEvent('dialog');
  const closing = page.close({ runBeforeUnload: true });
  const dialog = await prompted;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await closing;
  await delay(5600);
  expect(page.isClosed()).toBe(false);
  expect(session.isRunning()).toBe(true);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('% 取消後の入力\n');
  await page.keyboard.press('Control+S');
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content + '% 取消後の入力\n'));
  await closeEditorTab(page);
  await session.waitForExit();
});

test('配布済みの古い版から保存を確認して更新し，新しい版の編集画面を開く', async ({ page, context }, testInfo) => {
  const previousExecutable = process.env.LOCAL_TEX_EDITOR_TEST_PREVIOUS_EXE;
  test.skip(!previousExecutable, 'Set LOCAL_TEX_EDITOR_TEST_PREVIOUS_EXE to exercise the published application.');
  const previousVersion = process.env.LOCAL_TEX_EDITOR_TEST_PREVIOUS_VERSION || '0.1.3';
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ltex-update-'));
  const project = path.join(temp, '保存する日本語の原稿');
  await cp(fixture, project, { recursive: true });
  const config = path.join(temp, 'config');
  const currentReady = path.join(temp, 'current-ready.json');
  const nextReady = path.join(temp, 'next-ready.json');
  const children = [];
  const connections = [];
  const output = [];
  async function launch(program, readyFile) {
    const args = ['--no-browser', '--ready-file', readyFile, '--config-dir', config];
    if (process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN) args.push('--tex-bin', process.env.LOCAL_TEX_EDITOR_TEST_TEX_BIN);
    const child = spawn(program, args, { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let failure;
    child.on('error', error => { failure = error; });
    child.stdout.on('data', chunk => output.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => output.push(chunk.toString('utf8')));
    const ready = await waitUntil(async () => {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`Application exited with code ${child.exitCode}.`);
      return readFile(readyFile, 'utf8').then(JSON.parse, error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }).catch(error => { if (error instanceof SyntaxError) return null; throw error; });
    }, value => Boolean(value?.url && value?.token), 20_000, 'The application did not open its update page.');
    connections.push(ready);
    return { child, ready };
  }
  try {
    const previous = await launch(previousExecutable, currentReady);
    await openProject({ ...previous.ready, project });
    await page.goto(`${previous.ready.url}#token=${encodeURIComponent(previous.ready.token)}`);
    await expect(page.locator('#app-version')).toHaveText(`v${previousVersion}`);
    await setAutoSave(page, false);
    const saved = '% 新しい版へ移る前に保存する\n';
    await replaceEditor(page, saved);

    const next = await launch(executable, nextReady);
    expect(next.ready.phase).toBe('update');
    const updating = await context.newPage();
    await updating.goto(`${next.ready.url}#token=${encodeURIComponent(next.ready.token)}`);
    await expect(updating.getByTestId('update-current-version')).toHaveText(`v${previousVersion}`);
    await expect(updating.getByTestId('update-requested-version')).toHaveText(`v${applicationVersion}`);
    await expect(updating.getByTestId('update-executable')).toHaveText(executable);
    await expect(updating.getByTestId('update-stop-current')).toBeDisabled();
    await updating.getByTestId('update-language').selectOption('ja');
    await expect(updating.locator('html')).toHaveAttribute('lang', 'ja');
    await expect(updating.getByTestId('update-status')).toHaveText(`v${previousVersion} の終了を待っています．`);
    await updating.getByTestId('update-language').selectOption('en');
    await expect(updating.locator('html')).toHaveAttribute('lang', 'en');
    await expect(updating.getByTestId('update-status')).toHaveText(`Waiting for v${previousVersion} to close.`);
    expect(previous.child.exitCode).toBeNull();
    await expect(page.getByTestId('editor').locator('.cm-content')).toContainText(saved.trim());

    await page.getByTestId('save-button').click();
    await expect.poll(() => readFile(path.join(project, 'main.tex'), 'utf8').then(text => text.replaceAll('\r\n', '\n'))).toBe(saved);
    await updating.getByTestId('update-saved').check();
    await updating.getByTestId('update-stop-current').click();
    await expect.poll(() => previous.child.exitCode).toBe(0);
    const started = await waitUntil(() => readFile(nextReady, 'utf8').then(JSON.parse),
      value => value?.url && value.phase !== 'update', 20_000, 'The new application did not replace the update page.');
    connections.push(started);
    await expect(updating.locator('#app-version')).toHaveText(`v${applicationVersion}`);
    await expect(updating.getByTestId('editor').locator('.cm-content')).toContainText(saved.trim());
    expect((await json(started, '/api/state')).version).toBe(applicationVersion);
    await page.close();
    await closeEditorTab(updating);
    await expect.poll(() => next.child.exitCode, { timeout: 15_000 }).toBe(0);
  } finally {
    for (const connection of connections.toReversed()) {
      await request(connection, connection.phase === 'update' ? '/api/update/cancel' : '/api/shutdown', { method: 'POST', data: {} }).catch(() => {});
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, 'exit'), delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('application-update-output.txt', {
        body: Buffer.from(connections.reduce((text, entry) => redactOutput(text, entry.token), output.join('\n'))), contentType: 'text/plain',
      });
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
});

test('長い原稿の中央への最後の入力をタブが閉じた後に草稿から戻す', async ({ page, context, session }) => {
  await openProject(session);
  await openEditor(page, session);
  await setAutoSave(page, false);
  const original = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  const marker = '% 中央の目印';
  const finalInput = '最後の追記';
  const content = '% 長い日本語の原稿 <>& 😀\n'.repeat(6000) + marker + '\n' + '% 後半の本文\n'.repeat(6000);
  const expected = content.replace(marker, marker + finalInput);
  expect(Buffer.byteLength(content)).toBeGreaterThan(300_000);
  // Use the browser's paste event so CodeMirror can insert the full document
  // in one transaction. Input.insertText uses the browser's editing path.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(text => navigator.clipboard.writeText(text), content);
  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+V');
  const current = await json(session, '/api/state');
  const storageURL = `/api/storage?${new URLSearchParams({ key: `drafts:${current.project.root}` })}`;
  await expect.poll(async () => {
    const stored = await json(session, storageURL);
    return stored.value?.entries?.some(entry => entry.content === content) || false;
  }).toBe(true);
  await expect(page.getByTestId('draft-status')).toHaveAttribute('data-status', 'saved');
  await page.locator('#find-button').click();
  await page.getByTestId('source-search-input').fill(marker);
  await page.getByTestId('source-search-input').press('Enter');
  await page.getByTestId('source-search-input').press('Escape');
  await page.keyboard.press('ArrowRight');
  // Leave the ordinary full-draft write pending. The close-time request must
  // still reach the application after the document's JavaScript is gone.
  await page.evaluate(finalInput => {
    const request = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (String(url) === '/api/storage' && options?.method === 'PUT' && options.body?.includes(finalInput)) return new Promise(() => {});
      return request(url, options);
    };
  }, finalInput);
  await page.keyboard.insertText(finalInput);
  await closeEditorTab(page, true);
  await session.waitForExit();
  // Inspect the PC copy before another browser tab or process can restore it.
  // Events from a page's keepalive requests may arrive after Playwright has
  // detached that page, so the saved content is the observable result here.
  const storageDirectory = path.join(session.temp, 'config', 'ui-state');
  const stored = await Promise.all((await readdir(storageDirectory)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(path.join(storageDirectory, name), 'utf8'))));
  const storedDrafts = stored.find(record => record.key === `drafts:${current.project.root}`);
  const writtenDraft = storedDrafts?.value?.entries?.find(entry => entry.path === 'main.tex');
  expect(Boolean(writtenDraft), 'A draft must remain on the PC after the application exits.').toBe(true);
  expect(writtenDraft.content === expected, 'The PC copy must contain the complete draft including the final input.').toBe(true);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(original);

  await session.restart();
  const reopened = await context.newPage();
  await openEditor(reopened, session);
  await reopened.getByTestId('review-drafts').click();
  await expect(reopened.locator('#recovery-draft')).toHaveValue(expected);
  await reopened.getByTestId('restore-draft').click();
  await expect(reopened.getByTestId('editor').locator('.cm-content')).toContainText(marker + finalInput);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(original);
});

test('終了を取り消して編集を続け，保存してからタブを閉じる', async ({ page, session }) => {
  await openProject(session);
  const opened = page.waitForEvent('popup');
  await page.evaluate(url => { window.open(url, 'local-tex-editor'); }, `${session.url}#token=${encodeURIComponent(session.token)}`);
  const editorPage = await opened;
  await expect(editorPage.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await setAutoSave(editorPage, false);
  const content = '% 終了する前に保存する原稿\n\\newcommand{\\example}{saved}\n';
  await replaceEditor(editorPage, content);
  await editorPage.locator('#shutdown-button').click();
  await expect(editorPage.locator('#decision-dialog')).toBeVisible();
  await editorPage.locator('#decision-cancel').click();
  await expect(editorPage.locator('#decision-dialog')).not.toBeVisible();
  await expect(editorPage.getByTestId('editor').locator('.cm-content')).toContainText('終了する前に保存する原稿');
  expect((await json(session, '/api/state')).project).not.toBeNull();

  await editorPage.locator('#shutdown-button').click();
  const closed = editorPage.waitForEvent('close');
  await editorPage.locator('#decision-primary').click();
  await closed;
  expect(editorPage.isClosed()).toBe(true);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content));
});

test('終了確認中に別のファイルが読み込まれても，取消後に元の原稿を編集できる', async ({ page, session }) => {
  await writeFile(path.join(session.project, 'notes.txt'), '読み込みを待つファイル\n', 'utf8');
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
  await setAutoSave(page, false);
  const content = '% 終了を取り消した後も編集する原稿\n';
  await replaceEditor(page, content);

  let release;
  const responseGate = new Promise(resolve => { release = resolve; });
  let requested;
  const requestStarted = new Promise(resolve => { requested = resolve; });
  const fileURL = url => url.pathname === '/api/file' && url.searchParams.get('path') === 'notes.txt';
  await page.route(fileURL, async route => {
    const response = await route.fetch();
    requested();
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.getByTestId('file-notes.txt').click();
    await requestStarted;
    await page.locator('#shutdown-button').click();
    await expect(page.locator('#decision-dialog')).toBeVisible();
    release();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'notes.txt');
    await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await page.locator('#decision-cancel').click();
    await expect(page.locator('#decision-dialog')).not.toBeVisible();
    await expect(page.getByTestId('editor').locator('.cm-content')).toHaveAttribute('contenteditable', 'true');

    await page.locator('#editor-tabs .tab-select[data-path="main.tex"]').click();
    const editor = page.getByTestId('editor').locator('.cm-content');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toContainText('終了を取り消した後も編集する原稿');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('% 続けて入力できた\n');
    await expect(editor).toContainText('続けて入力できた');
    await page.keyboard.press('Control+S');
    await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, content + '% 続けて入力できた\n'));
  } finally {
    release();
    await page.unroute(fileURL);
  }
});

test('自動で閉じられないタブに終了を表示し，草稿を次回に戻す', async ({ page, session }, testInfo) => {
  await openProject(session);
  const original = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  await page.addInitScript(() => {
    window.__closeRequests = 0;
    window.close = () => { window.__closeRequests++; };
  });
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await setAutoSave(page, false);
  const draft = '% 終了後に草稿から戻す内容\n' + original;
  await replaceEditor(page, draft);
  await page.locator('#shutdown-button').click();
  await page.locator('#decision-secondary').click();
  await expect(page.getByTestId('closed-screen')).toBeVisible();
  await expect(page.locator('#closed-message')).toContainText('Ctrl+W');
  await expect(page.getByTestId('app-toolbar')).not.toBeVisible();
  await expect(page.locator('#workbench')).not.toBeVisible();
  expect(await page.evaluate(() => window.__closeRequests)).toBe(1);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(original);
  await page.screenshot({ path: testInfo.outputPath('closed-tab.png') });

  await session.restart();
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await page.getByTestId('review-drafts').click();
  await page.getByTestId('restore-draft').click();
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('終了後に草稿から戻す内容');
});

test('改行を貼り付けて検索し，TeX のコマンドをそのまま置換する', async ({ page, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await setAutoSave(page, false);
  const block = String.raw`\ifneuripslayout
  \input{common-neurips-uplatex}
\else
  \input{common-uplatex}
\fi`;
  const replacement = String.raw`\newcommand{\test}{first}
\textbf{second} \\ third`;
  await replaceEditor(page, `% before\n${block}\n% middle\n${block}\n% after\n`);
  await page.locator('#find-button').click();
  const search = page.getByTestId('source-search-input');
  await expect(search).toBeFocused();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(text => navigator.clipboard.writeText(text), block.replaceAll('\n', '\r\n'));
  await search.press('Control+V');
  await expect(search).toHaveValue(block);
  await expect(page.getByTestId('source-search-count')).toHaveText('2 件');
  await page.getByTestId('source-search-next').click();
  await expect(page.getByTestId('source-search-count')).toHaveText('1 / 2');
  await search.press('Enter');
  await expect(page.getByTestId('source-search-count')).toHaveText('2 / 2');
  await search.press('Shift+Enter');
  await expect(page.getByTestId('source-search-count')).toHaveText('1 / 2');
  await page.getByTestId('source-replace-input').fill(replacement);
  await page.getByTestId('source-search-replace-all').click();
  await expect(page.getByTestId('source-search-count')).toHaveText('0 件');
  await page.getByTestId('save-button').click();
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, `% before\n${replacement}\n% middle\n${replacement}\n% after\n`));

  let builds = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/build' && request.method() === 'POST') builds++; });
  await search.fill('first');
  await search.press('End');
  await search.press('Control+Enter');
  await search.pressSequentially('second');
  await expect(search).toHaveValue('first\nsecond');
  expect(builds).toBe(0);
  await search.fill('[');
  await page.getByRole('checkbox', { name: '正規表現', exact: true }).check();
  await expect(page.getByTestId('source-search-count')).toHaveText('正規表現を確認');
  await expect(page.getByTestId('source-search-next')).toBeDisabled();
  await page.getByRole('checkbox', { name: '正規表現', exact: true }).uncheck();
  await search.fill(replacement);
  await expect(page.getByTestId('source-search-count')).toHaveText('1 / 2');
  await page.screenshot({ path: testInfo.outputPath('multiline-search.png') });
  await search.press('Escape');
  await expect(search).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('フォルダーから画像と PDF を開き，編集中の原稿へ戻る', async ({ page, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const figures = path.join(session.project, 'figures');
  await mkdir(path.join(figures, 'empty'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(figures, '図.png'), png);
  await writeFile(path.join(figures, 'plot.pdf'), exampleFigurePDF());
  await writeFile(path.join(figures, 'shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#137b72"/><text x="30" y="85" fill="white" font-size="28">Figure</text></svg>');
  const metadata = await openProject(session);
  expect(metadata.project.directories).toEqual(expect.arrayContaining(['figures', 'figures/empty']));
  expect(metadata.project.files.find(file => file.path === 'figures/図.png')?.kind).toBe('image');
  expect(metadata.project.files.find(file => file.path === 'figures/plot.pdf')?.kind).toBe('pdf');
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toBeVisible();
  await setAutoSave(page, false);
  const source = '% 図を確認する前の草稿\n\\newcommand{\\example}{draft}\n';
  await replaceEditor(page, source);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  const line = await page.getByTestId('editor').getAttribute('data-line');
  const folder = page.locator('[data-testid="tree-folder"][data-path="figures"]');
  await folder.locator(':scope > summary').click();
  await expect(page.locator('[data-testid="tree-folder"][data-path="figures/empty"]')).toBeVisible();
  await page.getByTestId('file-figures/図.png').click();
  const assetImage = page.locator('#asset-preview img');
  await expect(assetImage).toBeVisible();
  await expect.poll(() => assetImage.evaluate(image => image.complete && image.naturalWidth)).toBe(1);
  await expect(page.getByTestId('save-button')).toBeDisabled();
  await page.getByTestId('file-figures/shape.svg').click();
  await expect.poll(() => assetImage.evaluate(image => image.complete && image.naturalWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath('image-preview.png') });
  await page.getByTestId('file-figures/plot.pdf').click();
  await expect(page.locator('#asset-preview canvas').first()).toBeVisible();
  await expect.poll(() => page.locator('#asset-preview canvas').first().evaluate(canvas => canvas.width)).toBeGreaterThan(100);
  await page.locator('#editor-tabs [data-path="main.tex"]').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', line);
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('図を確認する前の草稿');
  await expect(page.getByTestId('save-button')).toBeEnabled();
  await page.getByTestId('save-button').click();
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(expectedMainContent(session, source));

  await page.setViewportSize({ width: 1440, height: 900 });
  const dimensions = await page.evaluate(() => ({
    toolbar: document.querySelector('.app-header').getBoundingClientRect().height,
    editorTop: document.querySelector('#editor').getBoundingClientRect().top,
    pdfTop: document.querySelector('#pdf-scroll').getBoundingClientRect().top,
  }));
  expect(dimensions.toolbar).toBeLessThanOrEqual(48);
  expect(dimensions.editorTop).toBeLessThanOrEqual(100);
  expect(dimensions.pdfTop).toBeLessThanOrEqual(100);
  await page.screenshot({ path: testInfo.outputPath('compact-editor.png') });
  expect(errors).toEqual([]);
});

test('エディタと PDF の選択範囲が両テーマで見える', async ({ page, session }, testInfo) => {
  await openProject(session);
  await openEditor(page, session);
  await checkEditorSelectionVisibility(page, testInfo);
  const { finished } = await compileFromUI(page, session);
  expect(finished.status, finished.log + '\n' + finished.error).toBe('success');
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await checkPDFSelectionVisibility(page, testInfo);
});

test('編集中の文書をコンパイルし，タブを選ぶだけでは表示中の PDF を変えない', async ({ page, session }, testInfo) => {
  const other = '別の 原稿.tex';
  const source = ['\\documentclass[uplatex,dvipdfmx]{jsarticle}', '\\begin{document}',
    '別の文書の最初のページを表示する．', '\\newpage', '別の文書の二ページ目である．', '\\end{document}', ''].join('\n');
  await writeFile(path.join(session.project, other), source);
  await openProject(session);
  await openEditor(page, session);
  const first = await compileFromUI(page, session);
  expect(first.finished.status, first.finished.log + '\n' + first.finished.error).toBe('success');
  const canvas = page.getByTestId('pdf-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('pdf-next').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');

  await page.getByTestId(`file-${other}`).click();
  await expect(page.locator('#main-document-label')).toContainText(other);
  await expect(page.getByTestId('pdf-document')).toHaveText('main.tex');
  await expect(canvas).toHaveAttribute('data-build-id', first.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  const second = await compileFromUI(page, session);
  expect(second.started.main).toBe(other);
  expect(second.finished.status, second.finished.log + '\n' + second.finished.error).toBe('success');
  expect(second.finished.pdfMain).toBe(other);
  expect((await json(session, '/api/state')).project.main).toBe('main.tex');
  await expect(canvas).toHaveAttribute('data-build-id', second.finished.pdfBuildId);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('pdf-document')).toHaveText(other);
  await expect(page.getByTestId('pdf-page')).toHaveValue('1');
  const forward = await json(session, '/api/synctex/forward', { method: 'POST', data: { buildId: second.finished.pdfBuildId, path: other, line: 3, column: 0 } });
  expect(forward.locations.length).toBeGreaterThan(0);
  const download = page.waitForEvent('download');
  await page.locator('#download-pdf').click();
  expect((await download).suggestedFilename()).toBe('別の 原稿.pdf');

  await page.locator('#editor-tabs [data-path="main.tex"]').click();
  await expect(canvas).toHaveAttribute('data-build-id', second.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-document')).toHaveText(other);
  const back = await compileFromUI(page, session);
  expect(back.finished.status, back.finished.log + '\n' + back.finished.error).toBe('success');
  await expect(canvas).toHaveAttribute('data-build-id', back.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');

  await page.locator(`#editor-tabs [data-path="${other}"]`).click();
  await replaceEditor(page, source.replace('\\end{document}', '\\ThisCommandMustFail\n\\end{document}'));
  const failed = await compileFromUI(page, session);
  expect(failed.finished.status).toBe('failed');
  expect(failed.finished.main).toBe(other);
  expect(failed.finished.pdfMain).toBe('main.tex');
  expect(failed.finished.pdfBuildId).toBe(back.finished.pdfBuildId);
  await expect(canvas).toHaveAttribute('data-build-id', back.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-document')).toHaveText('main.tex');
  await page.screenshot({ path: testInfo.outputPath('compile-another-document.png') });
});

test('Markdown を編集し，表示するプレビューを選んで文書を切り替えられる', async ({ page, session }, testInfo) => {
  const notes = ['# 研究ノート', '', '本文の **強調** と数式 $`x^2`$ を表示する．', '',
    '| 文書 | 状態 |', '| --- | --- |', '| 原稿 | 編集中 |', '',
    '```tex', '\\section{実験}', '```', '', '![図](figures/図.png)', '', '[続き](detail.markdown#続き)', '',
    ...Array.from({ length: 35 }, (_, index) => `段落 ${index + 1} の内容をここに書く．\n`)].join('\n');
  await mkdir(path.join(session.project, 'figures'), { recursive: true });
  await writeFile(path.join(session.project, 'notes.md'), notes);
  await writeFile(path.join(session.project, 'detail.markdown'), '# 続き\n\n別の Markdown 文書を開く．\n');
  await writeFile(path.join(session.project, 'figures', '図.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openProject(session);
  await openEditor(page, session);
  const first = await compileFromUI(page, session);
  expect(first.finished.status, first.finished.log + '\n' + first.finished.error).toBe('success');
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('pdf-zoom').selectOption('1');
  await page.getByTestId('pdf-next').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');

  // Hold the next PDF response until the Markdown preview is on screen.
  let releasePDF;
  const heldPDF = new Promise(resolve => { releasePDF = resolve; });
  let waiting = false;
  await page.route('**/api/pdf?build=*', async route => {
    waiting = true;
    await heldPDF;
    await route.continue().catch(() => {});
  });
  const updated = await compileFromUI(page, session);
  expect(updated.finished.status, updated.finished.log + '\n' + updated.finished.error).toBe('success');
  expect(updated.finished.pdfMarkdownInputs).toEqual([]);
  await expect.poll(() => waiting).toBe(true);
  await page.getByTestId('file-notes.md').click();
  const preview = page.getByTestId('markdown-preview');
  const article = page.getByTestId('markdown-document');
  await expect(preview).toBeVisible();
  releasePDF();
  await expect(page.locator('#pdf-stage')).toHaveAttribute('data-build-id', updated.finished.pdfBuildId);
  await page.unroute('**/api/pdf?build=*');
  await expect(article.getByRole('heading', { name: '研究ノート' })).toBeVisible();
  await expect(article.locator('table')).toContainText('編集中');
  await expect(article.locator('pre code')).toHaveText('\\section{実験}\n');
  await expect(article.locator('.katex')).toHaveCount(1);
  await expect.poll(() => article.locator('img').evaluate(image => image.complete && image.naturalWidth)).toBe(1);
  await expect(page.locator('#pdf-preview')).not.toBeVisible();
  await expect(page.locator('#compile-label')).toHaveText('プレビュー');
  await setAutoSave(page, false);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('End');
  await page.keyboard.insertText('を更新');
  await expect(article.getByRole('heading', { name: '研究ノートを更新', exact: true })).toBeVisible();
  await expect(editor).toBeFocused();
  await page.getByTestId('compile-button').click();
  await expect.poll(() => readFile(path.join(session.project, 'notes.md'), 'utf8')).toContain('# 研究ノートを更新');
  expect((await json(session, '/api/build')).id).toBe(updated.finished.id);
  await page.screenshot({ path: testInfo.outputPath('markdown-preview.png') });

  await article.getByRole('link', { name: '続き', exact: true }).click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'detail.markdown');
  await expect(article).toContainText('別の Markdown 文書を開く');
  await page.locator('#editor-tabs [data-path="notes.md"]').click();
  await expect(article.getByRole('heading', { name: '研究ノートを更新' })).toBeVisible();
  await preview.evaluate(element => { element.scrollTop = 600; });
  const markdownTop = await preview.evaluate(element => element.scrollTop);
  expect(markdownTop).toBeGreaterThan(300);

  await page.locator('#editor-tabs [data-path="main.tex"]').click();
  await expect(preview).not.toBeVisible();
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', updated.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(page.getByTestId('pdf-zoom')).toHaveValue('1');
  await page.locator('#editor-tabs [data-path="notes.md"]').click();
  await expect(article.locator('img')).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeCloseTo(markdownTop, 0);
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('研究ノートを更新');

  const previewChoice = page.locator('[data-preview-choice]:visible');
  await expect(previewChoice).toHaveCount(1);
  await expect(previewChoice).toHaveValue('auto');
  await previewChoice.selectOption('pdf');
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await expect(preview).not.toBeVisible();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'notes.md');
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(page.getByTestId('pdf-zoom')).toHaveValue('1');

  // Markdown saves must leave the chosen PDF visible, including its location.
  const readingNote = '\n\nPDF を読みながら追記した本文．';
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText(readingNote);
  await page.keyboard.press('Control+S');
  await expect.poll(() => readFile(path.join(session.project, 'notes.md'), 'utf8')).toContain(readingNote);
  await expect(page.locator('#pdf-note')).not.toBeVisible();
  expect((await json(session, '/api/build')).pdfSourceChanged).toBe(false);
  await expect(previewChoice).toHaveValue('pdf');
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await expect(preview).not.toBeVisible();
  const finalNote = '\nCtrl+Enter でも PDF を見ながら保存する．';
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText(finalNote);
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => readFile(path.join(session.project, 'notes.md'), 'utf8')).toContain(finalNote);
  await expect(previewChoice).toHaveValue('pdf');
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await expect(preview).not.toBeVisible();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(page.getByTestId('pdf-zoom')).toHaveValue('1');
  expect((await json(session, '/api/build')).id).toBe(updated.finished.id);
  await expect(page.locator('#pdf-note')).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('markdown-with-pdf.png') });

  await previewChoice.selectOption('markdown');
  await expect(preview).toBeVisible();
  await expect(article).toContainText(readingNote.trim());
  await expect(article).toContainText(finalNote.trim());
  await expect(preview).toHaveAttribute('data-path', 'notes.md');
  await page.locator('#editor-tabs [data-path="main.tex"]').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
  await expect(previewChoice).toHaveValue('markdown');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-path', 'notes.md');
  await expect(page.locator('#pdf-preview')).not.toBeVisible();

  // Compiling TeX updates the hidden PDF without changing the selected view.
  const backgroundPDF = await compileFromUI(page, session);
  expect(backgroundPDF.finished.status, backgroundPDF.finished.log + '\n' + backgroundPDF.finished.error).toBe('success');
  await expect(page.locator('#pdf-stage')).toHaveAttribute('data-build-id', backgroundPDF.finished.pdfBuildId);
  await expect(previewChoice).toHaveValue('markdown');
  await expect(preview).toBeVisible();
  await expect(article).toContainText(finalNote.trim());
  await expect(page.locator('#pdf-preview')).not.toBeVisible();
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByTestId('editor').locator('.cm-line').filter({ hasText: 'ブラウザでページを移動し' }).click();
  await page.locator('#synctex-forward').click();
  await expect(previewChoice).toHaveValue('pdf');
  await expect(page.locator('.synctex-highlight')).toBeVisible();
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', backgroundPDF.finished.pdfBuildId);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(page.getByTestId('pdf-zoom')).toHaveValue('1');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await previewChoice.selectOption('auto');
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await page.locator('#editor-tabs [data-path="notes.md"]').click();
  await expect(preview).toBeVisible();
  await expect(previewChoice).toHaveValue('auto');
  await page.locator('#editor-tabs [data-path="main.tex"]').click();
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await expect(preview).not.toBeVisible();
  // A save from another tab changes the existing build, so the heartbeat must
  // update its notice even though the build ID itself has not changed.
  const currentSource = await json(session, '/api/file?path=main.tex');
  await json(session, '/api/file', { method: 'PUT', data: {
    path: 'main.tex', content: currentSource.content + '\n% saved from another tab\n', revision: currentSource.revision,
  } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#pdf-note')).toBeVisible();
  await expect(page.locator('#pdf-state')).toHaveText('原稿に変更あり');
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', backgroundPDF.finished.pdfBuildId);
  expect(errors).toEqual([]);
});

test('Markdown の原稿からプレビューへ移動し，スクロールの同期を選べる', async ({ page, session }, testInfo) => {
  const content = Array.from({ length: 60 }, (_, index) => [
    `## Section ${index + 1}`,
    '',
    `本文 ${index + 1}．原稿とプレビューの対応する位置を確認する．`.repeat(4),
    '',
    `別の段落 ${index + 1}．数式 $x^2$ と **強調** を表示する．`,
    '',
  ].join('\n')).join('\n');
  await writeFile(path.join(session.project, 'navigation.md'), content);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openProject(session);
  await openEditor(page, session);
  await page.getByTestId('file-navigation.md').click();
  const preview = page.getByTestId('markdown-preview');
  const article = page.getByTestId('markdown-document');
  const sourceScroll = page.getByTestId('editor').locator('.cm-scroller');
  const follow = page.locator('#markdown-scroll-sync');
  const forward = page.locator('#synctex-forward');
  const heading = number => article.getByRole('heading', { name: `Section ${number}`, exact: true });
  const settleLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  async function findSection(number) {
    await page.locator('#find-button').click();
    const search = page.getByTestId('source-search-input');
    await search.fill(`## Section ${number}`);
    await search.press('Enter');
    await page.getByTestId('source-search-close').click();
    await expect(search).not.toBeVisible();
    await settleLayout();
  }
  await expect(preview).toBeVisible();
  await expect(follow).toBeChecked();
  await follow.uncheck();
  await expect(forward).toBeEnabled();
  await expect(forward).toHaveAttribute('aria-label', 'Markdown のプレビューの位置へ移動');
  await findSection(18);
  await forward.click();
  await expect(heading(18)).toHaveClass(/markdown-source-highlight/);
  await expect(heading(18)).toBeInViewport();

  const nextSource = page.getByTestId('editor').locator('.cm-line').filter({ hasText: /^## Section 19$/ });
  await nextSource.click({ modifiers: ['Control'] });
  await expect(heading(19)).toHaveClass(/markdown-source-highlight/);
  await expect(heading(19)).toBeInViewport();
  const beforeInverse = await preview.evaluate(element => element.scrollTop);
  await heading(19).dblclick();
  await expect(page.getByTestId('editor').locator('.synctex-line')).toHaveText('## Section 19');
  await settleLayout();
  expect(await preview.evaluate(element => element.scrollTop)).toBeCloseTo(beforeInverse, 0);

  const editorTop = await sourceScroll.evaluate(element => element.scrollTop);
  const previewTop = await preview.evaluate(element => element.scrollTop);
  await sourceScroll.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => sourceScroll.evaluate(element => element.scrollTop)).toBeGreaterThan(editorTop + 300);
  await settleLayout();
  expect(await preview.evaluate(element => element.scrollTop)).toBeCloseTo(previewTop, 0);

  await follow.check();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(previewTop + 100);
  const followedTop = await preview.evaluate(element => element.scrollTop);
  await sourceScroll.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(followedTop + 100);
  await page.screenshot({ path: testInfo.outputPath('markdown-scroll-sync.png') });

  await dragPanelSeparator(page, '#splitter', { dx: 2000 });
  await expect.poll(async () => (await readPanelLayout(page)).preview.width).toBeLessThan(262);
  await expect(follow).toBeVisible();
  expect(await page.locator('.markdown-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const labelBounds = await page.locator('.markdown-scroll-sync').boundingBox();
  const paneBounds = await page.locator('#pdf-pane').boundingBox();
  expect(labelBounds.x).toBeGreaterThanOrEqual(paneBounds.x);
  expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(paneBounds.x + paneBounds.width);
  await page.screenshot({ path: testInfo.outputPath('markdown-preview-narrow.png') });
  await page.locator('#splitter').dblclick();
  await follow.uncheck();
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.markdownScrollSync).toBe(false);
  await page.reload();
  await expect(page.getByTestId('file-navigation.md')).toBeVisible();
  await page.getByTestId('file-navigation.md').click();
  await expect(follow).not.toBeChecked();

  await page.locator('#markdown-preview-mode').selectOption('pdf');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.locator('#show-editor').click();
  await findSection(35);
  await forward.click();
  await expect(preview).toBeVisible();
  await expect(page.locator('#markdown-preview-mode')).toHaveValue('markdown');
  await expect(heading(35)).toHaveClass(/markdown-source-highlight/);
  await expect(heading(35)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('markdown-forward-narrow.png') });
  expect(errors).toEqual([]);
});

test('ファイル一覧とログの大きさを調整し，再起動後も同じ配置で開く', async ({ page, context, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProject(session);
  await openEditor(page, session);
  const sidebarSeparator = page.locator('#sidebar-splitter');
  const logSeparator = page.locator('#log-splitter');
  await expect(sidebarSeparator).toHaveAttribute('role', 'separator');
  await expect(sidebarSeparator).toHaveAttribute('aria-orientation', 'vertical');
  const original = await readPanelLayout(page);

  await dragPanelSeparator(page, '#sidebar-splitter', { dx: 120 });
  await expect.poll(async () => (await readPanelLayout(page)).sidebar.width).toBeGreaterThan(original.sidebar.width + 100);
  const afterSidebarDrag = await readPanelLayout(page);
  await sidebarSeparator.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await readPanelLayout(page)).sidebar.width).toBeGreaterThan(afterSidebarDrag.sidebar.width + 10);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).sidebar.width - afterSidebarDrag.sidebar.width)).toBeLessThan(2);
  await page.getByTestId('outline-tab').click();
  await expect(page.getByTestId('outline-tree')).toBeVisible();
  expect((await readPanelLayout(page)).sidebar.width).toBeCloseTo(afterSidebarDrag.sidebar.width, 0);

  await dragPanelSeparator(page, '#splitter', { dx: 80 });
  await expect.poll(async () => (await readPanelLayout(page)).editor.width).toBeGreaterThan(afterSidebarDrag.editor.width + 60);
  expect((await readPanelLayout(page)).sidebar.width).toBeCloseTo(afterSidebarDrag.sidebar.width, 0);
  await page.locator('#log-toggle').click();
  await expect(logSeparator).toBeVisible();
  await expect(logSeparator).toHaveAttribute('role', 'separator');
  await expect(logSeparator).toHaveAttribute('aria-orientation', 'horizontal');
  const originalLog = await readPanelLayout(page);
  await dragPanelSeparator(page, '#log-splitter', { dy: -100 });
  await expect.poll(async () => (await readPanelLayout(page)).log.height).toBeGreaterThan(originalLog.log.height + 80);
  const afterLogDrag = await readPanelLayout(page);
  await logSeparator.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await readPanelLayout(page)).log.height).toBeGreaterThan(afterLogDrag.log.height + 10);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).log.height - afterLogDrag.log.height)).toBeLessThan(2);
  const chosen = await readPanelLayout(page);
  expect(chosen.log.x).toBeCloseTo(chosen.editor.x, 0);
  expect(chosen.log.right).toBeCloseTo(chosen.preview.right, 0);

  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#file-pane')).not.toBeVisible();
  await expect(sidebarSeparator).not.toBeVisible();
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).editor.x - chosen.workbench.x)).toBeLessThan(2);
  await page.locator('#sidebar-toggle').click();
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).sidebar.width - chosen.sidebar.width)).toBeLessThan(2);
  await page.locator('#close-log').click();
  await expect(logSeparator).not.toBeVisible();
  await page.locator('#log-toggle').click();
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).log.height - chosen.log.height)).toBeLessThan(2);

  await expect.poll(async () => {
    const saved = (await json(session, '/api/storage?key=preferences')).value?.panelLayout;
    return Boolean(saved && Math.abs(saved.sidebarWidth - chosen.sidebar.width) < 2 &&
      Math.abs(saved.logHeight - chosen.log.height) < 2 && saved.editorRatio > 0.5);
  }).toBe(true);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByTestId('theme-toggle').click();
  await page.screenshot({ path: testInfo.outputPath('panels-resized.png') });
  await closeEditorTab(page);
  await session.waitForExit();
  await session.restart();
  const reopened = await context.newPage();
  reopened.on('pageerror', error => errors.push(error.message));
  await reopened.setViewportSize({ width: 1440, height: 900 });
  await openEditor(reopened, session);
  await reopened.locator('#log-toggle').click();
  await expect.poll(async () => Math.abs((await readPanelLayout(reopened)).sidebar.width - chosen.sidebar.width)).toBeLessThan(2);
  await expect.poll(async () => Math.abs((await readPanelLayout(reopened)).editor.width - chosen.editor.width)).toBeLessThan(2);
  await expect.poll(async () => Math.abs((await readPanelLayout(reopened)).log.height - chosen.log.height)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('ウィンドウを小さくしても，原稿とログを操作できる大きさに収める', async ({ page, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProject(session);
  await openEditor(page, session);
  await page.locator('#log-toggle').click();
  const workbench = (await readPanelLayout(page)).workbench;

  await dragPanelSeparator(page, '#sidebar-splitter', { x: workbench.x + 1 });
  await expect.poll(async () => (await readPanelLayout(page)).sidebar.width).toBeCloseTo(180, 0);
  await dragPanelSeparator(page, '#sidebar-splitter', { x: workbench.right - 1 });
  const wide = await readPanelLayout(page);
  expect(wide.sidebar.width).toBeGreaterThan(600);
  expect(wide.editor.width).toBeGreaterThanOrEqual(259);
  expect(wide.preview.width).toBeGreaterThanOrEqual(259);
  expect(wide.preview.right).toBeLessThanOrEqual(workbench.right + 1);

  await dragPanelSeparator(page, '#log-splitter', { y: workbench.bottom - 1 });
  await expect.poll(async () => (await readPanelLayout(page)).log.height).toBeCloseTo(100, 0);
  await dragPanelSeparator(page, '#log-splitter', { y: workbench.y + 1 });
  const tall = await readPanelLayout(page);
  expect(tall.log.height).toBeGreaterThan(500);
  expect(tall.editor.height).toBeGreaterThanOrEqual(159);
  expect(tall.log.bottom).toBeLessThanOrEqual(workbench.bottom + 1);

  await page.setViewportSize({ width: 1000, height: 480 });
  await expect.poll(async () => (await readPanelLayout(page)).sidebar.width).toBeLessThan(wide.sidebar.width);
  await expect.poll(async () => (await readPanelLayout(page)).log.height).toBeLessThan(tall.log.height);
  const smaller = await readPanelLayout(page);
  expect(smaller.editor.width).toBeGreaterThanOrEqual(259);
  expect(smaller.preview.width).toBeGreaterThanOrEqual(259);
  expect(smaller.editor.height).toBeGreaterThanOrEqual(159);
  expect(smaller.preview.right).toBeLessThanOrEqual(smaller.workbench.right + 1);
  expect(smaller.log.bottom).toBeLessThanOrEqual(smaller.workbench.bottom + 1);

  await page.setViewportSize({ width: 800, height: 480 });
  await expect(page.locator('#splitter')).not.toBeVisible();
  await expect(page.locator('#sidebar-splitter')).toBeVisible();
  await expect.poll(async () => (await readPanelLayout(page)).editor.width).toBeGreaterThanOrEqual(259);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#file-pane')).not.toBeVisible();
  await expect(page.locator('#sidebar-splitter')).not.toBeVisible();
  await expect.poll(async () => {
    const layout = await readPanelLayout(page);
    return Math.abs(layout.editor.width - layout.workbench.width);
  }).toBeLessThan(2);

  await page.setViewportSize({ width: 390, height: 600 });
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#file-pane')).toBeVisible();
  await expect(page.locator('#sidebar-splitter')).not.toBeVisible();
  await expect.poll(async () => (await readPanelLayout(page)).sidebar.right).toBeLessThanOrEqual(351);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#log-splitter')).toBeVisible();
  const beforeMobileDrag = await readPanelLayout(page);
  await dragPanelSeparator(page, '#log-splitter', { dy: 40 });
  await expect.poll(async () => (await readPanelLayout(page)).log.height).toBeLessThan(beforeMobileDrag.log.height - 25);
  await page.screenshot({ path: testInfo.outputPath('panels-narrow.png') });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#sidebar-toggle').click();
  await expect.poll(async () => Math.abs((await readPanelLayout(page)).sidebar.width - wide.sidebar.width)).toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('日本語の原稿を編集し，参考文献と PDF を更新する', async ({ page, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  if (!await page.getByTestId('project-path').isVisible()) {
    await page.locator('#welcome-open').click();
  }
  await page.getByTestId('project-path').fill(session.project);
  await page.getByTestId('open-project').click();
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toContainText('Local TeX Web Editor');
  await editor.click();
  await page.keyboard.press('Control+Home');
  const comment = '% ブラウザから保存した日本語のコメント\n';
  await page.keyboard.insertText(comment);

  const saveResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/file' && response.request().method() === 'PUT');
  await page.getByTestId('save-button').click();
  expect((await saveResponse).ok()).toBe(true);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain(comment.trim());

  const { started, finished } = await compileFromUI(page, session);
  expect(finished.status, finished.log + '\n' + finished.error).toBe('success');
  expect(finished.exitCode).toBe(0);
  expect(finished.log).toContain('LOCAL_TEX_EDITOR_RC_LOADED');
  expect(finished.log).toMatch(/uplatex/i);
  expect(finished.log).toMatch(/upbibtex/i);
  expect(finished.pdfReady).toBe(true);
  expect(finished.pdfBuildId).toBe(started.id);

  const bibliography = await readFile(path.join(session.project, '.local-tex-editor', 'build', 'main.bbl'), 'utf8');
  expect(bibliography).toContain('sample2026');
  const finalLog = await readFile(path.join(session.project, '.local-tex-editor', 'build', 'main.log'), 'utf8');
  expect(finalLog).not.toMatch(/There were undefined citations|Citation .* undefined/);

  const range = await request(session, '/api/pdf', { headers: { Range: 'bytes=0-4' } });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-range')).toMatch(/^bytes 0-4\/\d+$/);
  expect(Buffer.from(await range.arrayBuffer()).toString('ascii')).toBe('%PDF-');
  await expect(page.getByTestId('build-status')).toHaveAttribute('data-status', 'success');
  const canvas = page.getByTestId('pdf-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-build-id', finished.pdfBuildId);
  await expect.poll(() => canvas.evaluate(element => {
    const context = element.getContext('2d');
    if (!context || element.width < 300 || element.height < 300) return false;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4 * 7) {
      if (pixels[i + 3] > 0 && pixels[i] < 220 && pixels[i + 1] < 220 && pixels[i + 2] < 220) dark++;
    }
    return dark > 20;
  })).toBe(true);

  const firstPage = page.locator('.pdfViewer .page[data-page-number="1"]');
  const secondPage = page.locator('.pdfViewer .page[data-page-number="2"]');
  await expect(firstPage).toBeAttached();
  await expect(secondPage).toBeAttached();

  await page.getByTestId('pdf-search-toggle').click();
  await page.getByTestId('pdf-search-input').fill('二ページ目');
  await page.getByTestId('pdf-search-input').press('Enter');
  await expect(page.getByTestId('pdf-search-count')).toContainText('1');
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await page.getByTestId('pdf-search-input').press('Escape');
  await page.getByTestId('pdf-prev').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('1');

  const pdfScroll = page.getByTestId('pdf-scroll');
  await pdfScroll.hover();
  await page.mouse.wheel(0, 1600);
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(canvas).toHaveAttribute('data-page', '2');
  await page.getByTestId('pdf-prev').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('1');

  const initialWidth = await firstPage.evaluate(element => element.getBoundingClientRect().width);
  await page.getByTestId('pdf-zoom-in').click();
  await expect.poll(() => firstPage.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(initialWidth);
  const expandedWidth = await firstPage.evaluate(element => element.getBoundingClientRect().width);
  await page.getByTestId('pdf-zoom-out').click();
  await expect.poll(() => firstPage.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(expandedWidth);
  await page.getByTestId('pdf-zoom').selectOption('page-width');
  await expect(canvas).toHaveAttribute('data-ready', 'true');

  const themeButton = page.getByTestId('theme-toggle');
  const wasDark = (await themeButton.getAttribute('aria-pressed')) === 'true';
  const initialBackground = await page.locator('.app-header').evaluate(element => getComputedStyle(element).backgroundColor);
  await themeButton.click();
  await expect(themeButton).toHaveAttribute('aria-pressed', String(!wasDark));
  await expect.poll(() => page.locator('.app-header').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(initialBackground);
  await page.screenshot({ path: testInfo.outputPath('editor-alternate-theme.png') });
  await themeButton.click();
  await expect(themeButton).toHaveAttribute('aria-pressed', String(wasDark));

  await page.getByTestId('pdf-next').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(canvas).toHaveAttribute('data-page', '2');

  const sourceBeforeAppearance = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  const pdfWidthBeforeAppearance = await secondPage.evaluate(element => element.getBoundingClientRect().width);
  const browserScale = await page.evaluate(() => window.visualViewport.scale);
  await page.getByTestId('settings-button').click();
  await page.getByTestId('editor-font-size').fill('16');
  await page.locator('#save-settings').click();
  await expect(page.getByTestId('editor-font-size')).not.toBeVisible();
  const editorSize = () => page.getByTestId('editor').locator('.cm-scroller').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await expect.poll(editorSize).toBe(16);
  await expect(page.locator('#pdf-note')).not.toBeVisible();
  expect((await json(session, '/api/build')).sourceChanged).toBe(false);
  await editor.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -180);
  await page.keyboard.up('Control');
  await expect.poll(editorSize).toBeGreaterThan(16);
  const enlargedEditorSize = await editorSize();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 90);
  await page.keyboard.up('Control');
  await expect.poll(editorSize).toBeLessThan(enlargedEditorSize);

  const beforePinch = await editorSize();
  const editorBounds = await page.getByTestId('editor').boundingBox();
  const centerX = Math.round(editorBounds.x + editorBounds.width / 2);
  const centerY = Math.round(editorBounds.y + editorBounds.height / 2);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const points = distance => [{ x: centerX - distance, y: centerY, id: 1 }, { x: centerX + distance, y: centerY, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(30) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(45) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(editorSize).toBeGreaterThan(beforePinch);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await cdp.detach();
  await expect(page.locator('#pdf-note')).not.toBeVisible();
  expect((await json(session, '/api/build')).sourceChanged).toBe(false);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).toBe(sourceBeforeAppearance);
  expect(await secondPage.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(pdfWidthBeforeAppearance, 0);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(browserScale);
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  // A visibility change during a settings save must refresh tools once the
  // save ends. Hold that response so this ordering is checked on every run.
  const settingsTools = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await page.getByTestId('settings-button').click();
  await (await settingsTools).finished();
  await page.getByTestId('editor-font-size').fill('14');
  let toolMissing = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const metadata = await response.json();
    if (toolMissing) {
      metadata.synctex = '';
      metadata.synctexError = 'synctex が見つかりません．';
      metadata.synctexInstallCommands = ['tlmgr install --reinstall synctex synctex.windows'];
    }
    await route.fulfill({ response, json: metadata });
  });
  let releasePreferences;
  let preferencesReceived;
  const preferencesHeld = new Promise(resolve => { releasePreferences = resolve; });
  const preferencesRequested = new Promise(resolve => { preferencesReceived = resolve; });
  await page.route('**/api/storage', async route => {
    const request = route.request();
    const data = request.method() === 'PUT' ? request.postDataJSON() : null;
    if (data?.key !== 'preferences' || data.value?.editorFontSize !== 14) { await route.continue(); return; }
    const response = await route.fetch();
    preferencesReceived();
    await preferencesHeld;
    await route.fulfill({ response });
  });
  try {
    await page.locator('#save-settings').click();
    await preferencesRequested;
    await expect(page.locator('#settings-dialog')).toHaveAttribute('data-busy', 'true');
    await expect.poll(editorSize).toBe(14);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  } finally { releasePreferences(); }
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.getByTestId('synctex-forward')).toBeDisabled();
  await expect(page.getByTestId('synctex-forward')).toHaveAttribute('title', 'SyncTeX が見つかりません．設定に導入の手順があります．');
  await page.unroute('**/api/storage');
  toolMissing = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('synctex-forward')).toBeEnabled();
  await page.unroute('**/api/state');

  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('% 再コンパイル後のページを確認する\n');
  await page.keyboard.press('Control+S');
  await expect(page.locator('#save-status')).toHaveText('保存済み');
  await expect(page.locator('#pdf-note')).toBeVisible();
  await expect(page.locator('#pdf-state')).toHaveText('原稿に変更あり');
  expect((await json(session, '/api/build')).pdfSourceChanged).toBe(true);
  const updated = await compileFromUI(page, session);
  expect(updated.finished.status, updated.finished.log).toBe('success');
  await expect(page.getByTestId('build-status')).toHaveAttribute('data-status', 'success');
  await expect(canvas).toHaveAttribute('data-build-id', updated.finished.pdfBuildId);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-page', '2');
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await page.screenshot({ path: testInfo.outputPath('editor-with-pdf.png') });
  expect(errors).toEqual([]);
});

test('PDF の倍率とページの回転に合わせて SyncTeX の位置を強調する', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPDFViewer(page, pdfWithRotatedPages());

  for (const number of [1, 2, 3, 4]) {
    const location = { page: number, x: 40, y: 70, width: 80, height: 18 };
    await page.getByTestId('pdf-zoom').selectOption('0.75');
    expect(await page.evaluate(target => window.testViewer.showLocation(target), location)).toBe(true);
    await expect(page.getByTestId('pdf-page')).toHaveValue(String(number));

    for (const zoom of ['0.75', '1.5']) {
      if (zoom === '1.5') await page.getByTestId('pdf-zoom').selectOption(zoom);
      const highlight = page.locator(`.pdfViewer .page[data-page-number="${number}"]`).getByTestId('synctex-highlight');
      await expect(highlight).toBeVisible();
      // Several small pages fit in this preview. Zoom can change which page
      // PDF.js calls current, so inspect the requested page's own canvas and
      // bring its target into view before testing the double-click.
      await highlight.scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(pageNumber => {
        const canvas = window.testViewer.pageViewer.getPageView(pageNumber - 1).canvas;
        return { page: canvas?.dataset.page, ready: canvas?.dataset.ready };
      }, number)).toEqual({ page: String(number), ready: 'true' });
      const measured = await page.evaluate(pageNumber => {
        const view = window.testViewer.pageViewer.getPageView(pageNumber - 1);
        const canvas = view.canvas;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const offset = (y * canvas.width + x) * 4;
            if (pixels[offset + 3] > 200 && pixels[offset] < 32 && pixels[offset + 1] < 32 && pixels[offset + 2] < 32) {
              left = Math.min(left, x); top = Math.min(top, y);
              right = Math.max(right, x); bottom = Math.max(bottom, y);
            }
          }
        }
        const rect = canvas.getBoundingClientRect();
        const ink = {
          left: rect.left + left * rect.width / canvas.width,
          top: rect.top + top * rect.height / canvas.height,
          right: rect.left + (right + 1) * rect.width / canvas.width,
          bottom: rect.top + (bottom + 1) * rect.height / canvas.height,
        };
        const mark = view.div.querySelector('.synctex-highlight').getBoundingClientRect();
        return { ink, mark: { left: mark.left, top: mark.top, right: mark.right, bottom: mark.bottom },
          scale: view.viewport.scale, rotation: view.viewport.rotation, errors: window.viewerErrors };
      }, number);
      expect(measured.scale).toBeCloseTo(Number(zoom) * 4 / 3, 6);
      expect(measured.rotation).toBe((number - 1) * 90);
      expect(measured.ink.right).toBeGreaterThan(measured.ink.left);
      expect(measured.ink.bottom).toBeGreaterThan(measured.ink.top);
      // Compare the highlight with pixels rendered by PDF.js, including the
      // page rotation, zoom, and CSS rounding of the canvas.
      for (const [edge, padding] of [['left', 4], ['top', 3], ['right', -4], ['bottom', -3]]) {
        expect(Math.abs(measured.ink[edge] - measured.mark[edge] - padding), `${number}: ${zoom}, ${edge}`).toBeLessThan(2);
      }
      expect(measured.errors).toEqual([]);
      expect(errors).toEqual([]);

      const previousCount = await page.evaluate(() => window.inverseLocations.length);
      await page.mouse.dblclick((measured.ink.left + measured.ink.right) / 2, (measured.ink.top + measured.ink.bottom) / 2);
      await expect.poll(() => page.evaluate(() => window.inverseLocations.length)).toBe(previousCount + 1);
      const inverse = await page.evaluate(() => window.inverseLocations.at(-1));
      expect(inverse.buildId).toBe('test-build');
      expect(inverse.page).toBe(number);
      expect(Math.abs(inverse.x - (location.x + location.width / 2))).toBeLessThan(1);
      expect(Math.abs(inverse.y - (location.y + location.height / 2))).toBeLessThan(1);
    }
  }
  expect(await page.evaluate(() => window.viewerErrors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('日本語のファイル名で原稿と PDF の位置を行き来する', async ({ page, session }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sourcePath = '追加の 原稿.tex';
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('Local TeX Web Editor');
  const { finished } = await compileFromUI(page, session);
  expect(finished.status, finished.log + '\n' + finished.error).toBe('success');
  const canvas = page.getByTestId('pdf-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');

  const forward = await json(session, '/api/synctex/forward', {
    method: 'POST', data: { buildId: finished.pdfBuildId, path: sourcePath, line: 2, column: 1 },
  });
  expect(forward.buildId).toBe(finished.pdfBuildId);
  expect(forward.sourceChanged).toBe(false);
  if (!forward.locations.length) await recordEmptySyncTeX(testInfo, session, finished.pdfBuildId, forward);
  expect(forward.locations.length, JSON.stringify(forward)).toBeGreaterThan(0);
  const location = forward.locations.find(item => item.page === 2);
  expect(location).toBeDefined();
  expect(location.width).toBeGreaterThan(0);
  expect(location.height).toBeGreaterThan(0);
  const inverse = await json(session, '/api/synctex/inverse', {
    method: 'POST',
    data: {
      buildId: finished.pdfBuildId, page: location.page,
      x: location.x + Math.min(location.width / 2, 20), y: location.y + location.height / 2,
    },
  });
  expect(inverse.path).toBe(sourcePath);
  expect(inverse.line).toBeGreaterThanOrEqual(2);
  expect(inverse.line).toBeLessThanOrEqual(3);
  expect(inverse.sourceChanged).toBe(false);

  await page.getByTestId(`file-${sourcePath}`).click();
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toContainText('これは SyncTeX');
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  const forwardResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/synctex/forward' && response.request().method() === 'POST');
  await page.getByTestId('synctex-forward').click();
  const response = await forwardResponse;
  expect(response.ok()).toBe(true);
  const requestedLocation = (await response.json()).locations.find(item => item.page === 2);
  expect(requestedLocation).toBeDefined();
  await expect(page.getByTestId('synctex-forward')).toBeEnabled();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');
  await expect(canvas).toHaveAttribute('data-page', '2');
  await expect(page.getByTestId('app-error')).not.toBeVisible();
  const highlight = page.getByTestId('synctex-highlight');
  await expect(highlight).toBeVisible();
  const box = await highlight.evaluate(element => ({
    left: parseFloat(element.style.left), top: parseFloat(element.style.top),
    width: parseFloat(element.style.width), height: parseFloat(element.style.height),
    page: element.closest('.page').dataset.pageNumber,
  }));
  expect(box.page).toBe('2');
  for (const value of [box.left, box.top, box.width, box.height]) expect(Number.isFinite(value)).toBe(true);
  expect(box.left).toBeGreaterThanOrEqual(-4);
  expect(box.top).toBeGreaterThanOrEqual(-3);
  expect(box.width).toBeGreaterThan(8);
  expect(box.height).toBeGreaterThan(6);
  expect(errors).toEqual([]);

  const clickedForward = page.waitForResponse(result =>
    new URL(result.url()).pathname === '/api/synctex/forward' && result.request().method() === 'POST');
  await editor.locator('.cm-line').filter({ hasText: 'これは SyncTeX' }).click({ modifiers: ['Control'] });
  expect((await clickedForward).ok()).toBe(true);
  await expect(page.getByTestId('synctex-forward')).toBeEnabled();
  await expect(page.getByTestId('app-error')).not.toBeVisible();
  await expect(highlight).toBeVisible();

  // Open another source file first, so that the click proves the inverse query
  // navigates to the included file instead of leaving an existing editor open.
  await page.getByTestId('file-main.tex').click();
  await expect(editor).toContainText('Local TeX Web Editor');
  const inverseResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/synctex/inverse' && response.request().method() === 'POST');
  const referenceText = page.locator('.pdfViewer .page[data-page-number="2"] .textLayer span')
    .filter({ hasText: 'SyncTeX' }).first();
  await referenceText.dblclick();
  const clicked = await inverseResponse;
  expect(clicked.ok(), await clicked.text()).toBe(true);
  const clickedSource = await clicked.json();
  expect(clickedSource.path).toBe(sourcePath);
  await expect(editor).toContainText('これは SyncTeX');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', sourcePath);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', String(clickedSource.line));
  await expect(page.getByTestId('app-error')).not.toBeVisible();

  await session.restart();
  const restored = await json(session, '/api/build');
  expect(restored.restored).toBe(true);
  expect(restored.pdfReady).toBe(true);
  expect(restored.synctexReady).toBe(true);
  expect(restored.pdfBuildId).toBe(finished.pdfBuildId);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-build-id', finished.pdfBuildId);
  const restoredForward = await json(session, '/api/synctex/forward', {
    method: 'POST', data: { buildId: finished.pdfBuildId, path: sourcePath, line: 2, column: 1 },
  });
  expect(restoredForward.locations.some(item => item.page === 2)).toBe(true);
  expect(errors).toEqual([]);
});

test('自動保存，補完，アウトラインを使い，草稿を再起動後に戻す', async ({ page, session }) => {
  page.on('dialog', dialog => dialog.accept());
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toContainText('Local TeX Web Editor');
  const autoSavedComment = '% 自動保存でディスクへ書き込む\n';
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText(autoSavedComment);
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain(autoSavedComment.trim());

  await page.getByTestId('outline-tab').click();
  const section = page.getByTestId('outline-tree').locator('button[data-path="main.tex"]')
    .filter({ hasText: '二ページ目' }).first();
  await expect(section).toBeVisible();
  const currentSource = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  const sectionLine = String(currentSource.split('\n').findIndex(line => line.includes('\\section{二ページ目}')) + 1);
  await expect(section).toHaveAttribute('data-line', sectionLine);
  await section.click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', sectionLine);

  await setAutoSave(page, false);
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\\cite{sam');
  await page.keyboard.press('Control+Space');
  await page.getByRole('option', { name: /sample2026/ }).click();
  await page.keyboard.insertText('}');
  await expect(editor).toContainText('\\cite{sample2026}');

  const draftComment = '% 起動し直した後に草稿から戻す\n';
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText(draftComment);
  await expect(page.getByTestId('draft-status')).toHaveAttribute('data-status', 'saved');
  const current = await json(session, '/api/state');
  const storageURL = `/api/storage?${new URLSearchParams({ key: `drafts:${current.project.root}` })}`;
  let savedDraft;
  await expect.poll(async () => {
    const stored = await json(session, storageURL);
    savedDraft = stored.value?.entries?.find(entry => entry.path === 'main.tex' && entry.content.includes(draftComment.trim()));
    return Boolean(savedDraft);
  }).toBe(true);
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).not.toContain(draftComment.trim());

  await session.restart();
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await page.getByTestId('review-drafts').click();
  await expect(page.getByTestId('recovery-dialog')).toBeVisible();
  await page.getByTestId('recovery-file').selectOption(savedDraft.id);
  await page.getByTestId('restore-draft').click();
  await expect(editor).toContainText(draftComment.trim());
  expect(await readFile(path.join(session.project, 'main.tex'), 'utf8')).not.toContain(draftComment.trim());
  await setAutoSave(page, true);
  await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain(draftComment.trim());
});

test('選択した TeX と Markdown のタブに合わせてアウトラインを更新する', async ({ page, session }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await writeFile(path.join(session.project, 'outline.tex'), '\\section{別の原稿}\n本文．\n\n\\subsection{小見出し}\n');
  await writeFile(path.join(session.project, 'outline.md'), '# Markdown の原稿\n\n本文．\n\n詳細\n----\n\n```markdown\n# コード内の見出し\n```\n');
  await writeFile(path.join(session.project, 'empty.tex'), '');
  await writeFile(path.join(session.project, 'outline.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64'));
  await openProject(session);
  await openEditor(page, session);
  await setAutoSave(page, false);
  const outline = page.getByTestId('outline-tree');
  const links = outline.locator('.outline-link');
  const selectTab = file => page.locator(`#editor-tabs .tab-select[data-path="${file}"]`).click();
  const openOutline = async file => {
    await page.getByTestId('files-tab').click();
    await page.getByTestId(`file-${file}`).click();
    await page.getByTestId('outline-tab').click();
    await expect(outline.locator('.outline-file')).toHaveText(file);
  };
  await page.getByTestId('outline-tab').click();
  await expect(links).toHaveCount(1);
  await expect(links.first()).toContainText('二ページ目');
  await expect(links.first()).toHaveAttribute('data-path', 'main.tex');

  await openOutline('outline.tex');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toContainText('別の原稿');
  await selectTab('main.tex');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute('data-path', 'main.tex');
  await selectTab('outline.tex');
  await expect(links).toHaveCount(2);
  await page.getByTestId('editor').locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n\\subsubsection{編集中の見出し}\n');
  await expect(links).toHaveCount(3);
  await expect(links.last()).toContainText('編集中の見出し');
  expect(await readFile(path.join(session.project, 'outline.tex'), 'utf8')).not.toContain('編集中の見出し');
  await page.keyboard.press('Control+S');
  await expect.poll(() => readFile(path.join(session.project, 'outline.tex'), 'utf8')).toContain('編集中の見出し');

  await openOutline('outline.md');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toContainText('Markdown の原稿');
  await expect(links.last()).toContainText('詳細');
  await expect(links.last()).toHaveAttribute('data-line', '5');
  await links.last().click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', '5');
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n## 追記した見出し\n');
  await expect(links).toHaveCount(3);
  await expect(links.last()).toContainText('追記した見出し');
  expect(await readFile(path.join(session.project, 'outline.md'), 'utf8')).not.toContain('追記した見出し');
  await page.keyboard.press('Control+S');
  await expect.poll(() => readFile(path.join(session.project, 'outline.md'), 'utf8')).toContain('追記した見出し');
  await selectTab('main.tex');
  await expect(links).toHaveCount(1);
  await selectTab('outline.md');
  await expect(links).toHaveCount(3);
  await page.locator('#refresh-files').click();
  await expect(page.locator('#toast')).toHaveText('ファイル一覧を更新しました．');
  await expect(links).toHaveCount(3);
  await expect(links.last()).toContainText('追記した見出し');
  await page.locator('#file-filter').fill('詳細');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute('data-line', '5');
  await page.locator('#file-filter').fill('');

  await openOutline('empty.tex');
  await expect(links).toHaveCount(0);
  await expect(outline).toContainText('この文書には見出しがありません．');
  await openOutline('outline.png');
  await expect(links).toHaveCount(0);
  await expect(outline).toContainText('このファイルにはアウトラインがありません．');
  await openOutline('references.bib');
  await expect(links).toHaveCount(0);
  await expect(outline).toContainText('このファイルにはアウトラインがありません．');
  await selectTab('outline.md');
  await expect(links).toHaveCount(3);
  const closeButtons = page.locator('#editor-tabs .tab-close');
  for (let count = await closeButtons.count(); count > 0; --count) {
    await closeButtons.last().click();
    await expect(closeButtons).toHaveCount(count - 1);
  }
  await expect(links).toHaveCount(0);
  await expect(outline).toContainText('TeX または Markdown ファイルを開くと，その見出しが表示されます．');
  expect(errors).toEqual([]);
});

test('150 ページの PDF の末尾へ移動し，必要なページを描画する', async ({ page, session }, testInfo) => {
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('Local TeX Web Editor');
  const source = String.raw`\documentclass[uplatex,dvipdfmx]{jsarticle}
\begin{document}
\newcount\editorpagenumber
\editorpagenumber=1
\loop
\section*{ページ \the\editorpagenumber}
長い原稿をブラウザで読み，必要なページを表示する．
\ifnum\editorpagenumber<150\newpage\fi
\advance\editorpagenumber by 1
\ifnum\editorpagenumber<151\repeat
\end{document}
`;
  await replaceEditor(page, source);
  const { finished } = await compileFromUI(page, session);
  expect(finished.status, finished.log + '\n' + finished.error).toBe('success');
  const canvas = page.getByTestId('pdf-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#pdf-pages')).toHaveText('150');
  await page.getByTestId('pdf-page').fill('150');
  await page.getByTestId('pdf-page').press('Enter');
  await expect(canvas).toHaveAttribute('data-page', '150');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-build-id', finished.pdfBuildId);
  const rendering = await page.locator('#pdf-stage').evaluate(viewer => {
    const canvases = [...viewer.querySelectorAll('canvas')];
    return {
      pages: viewer.querySelectorAll('.page').length,
      canvases: canvases.length,
      pixels: canvases.reduce((sum, item) => sum + item.width * item.height, 0),
    };
  });
  expect(rendering.pages).toBe(150);
  expect(rendering.canvases).toBeGreaterThan(0);
  expect(rendering.canvases).toBeLessThanOrEqual(20);
  const renderingFile = testInfo.outputPath('pdf-rendering.json');
  await writeFile(renderingFile, JSON.stringify({ ...rendering, elapsedMS: finished.elapsedMs }, null, 2));
  await testInfo.attach('pdf-rendering.json', {
    path: renderingFile,
    contentType: 'application/json',
  });
});

test('保存の競合と，プロジェクト外へのアクセスを扱う', async ({ page, session }) => {
  await openProject(session);
  const unauthenticated = await request(session, '/api/state', { token: false });
  expect([401, 403]).toContain(unauthenticated.status);
  const wrongOrigin = await request(session, '/api/state', { headers: { Origin: 'https://example.invalid' } });
  expect(wrongOrigin.status).toBe(403);
  const outside = path.join(session.temp, 'outside.tex');
  await writeFile(outside, 'outside-file-must-not-be-served');
  const traversal = await request(session, `/api/file?${new URLSearchParams({ path: '../outside.tex' })}`);
  expect([400, 403, 404]).toContain(traversal.status);
  expect(await traversal.text()).not.toContain('outside-file-must-not-be-served');

  const original = await json(session, '/api/file?path=main.tex');
  const lineFile = path.join(session.project, 'line-endings.tex');
  await writeFile(lineFile, '\ufefffirst\r\nsecond\r\n', 'utf8');
  const lineDocument = await json(session, '/api/file?path=line-endings.tex');
  expect(lineDocument.lineEnding).toBe('crlf');
  await json(session, '/api/file', {
    method: 'PUT', data: { path: 'line-endings.tex', revision: lineDocument.revision, content: 'first\nchanged\n' },
  });
  expect(await readFile(lineFile, 'utf8')).toBe('\ufefffirst\r\nchanged\r\n');

  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toContainText('Local TeX Web Editor');
  await setAutoSave(page, false);
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('% 編集中の内容\n');
  await writeFile(path.join(session.project, 'main.tex'), original.content + '\n% 外部の変更\n', 'utf8');
  const saveResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/file' && response.request().method() === 'PUT');
  await page.getByTestId('save-button').click();
  expect((await saveResponse).status()).toBe(409);
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(editor).toContainText('編集中の内容');
  const onDisk = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  expect(onDisk).toContain('外部の変更');
  expect(onDisk).not.toContain('編集中の内容');
});

test('TeX の失敗を画面に出し，実行中のコンパイルを停止する', async ({ page, session }) => {
  await openProject(session);
  await page.goto(`${session.url}#token=${encodeURIComponent(session.token)}`);
  const source = await readFile(path.join(session.project, 'main.tex'), 'utf8');
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('Local TeX Web Editor');
  const success = await compileFromUI(page, session);
  expect(success.finished.status, success.finished.log).toBe('success');
  const previousPDF = Buffer.from(await (await request(session, '/api/pdf')).arrayBuffer());

  const failingSource = source.replace('\\end{document}', '\\NoSuchControlSequenceForEditorTest\n\\end{document}');
  const failingLine = failingSource.split('\n').findIndex(line => line.includes('\\NoSuchControlSequenceForEditorTest')) + 1;
  await replaceEditor(page, failingSource);
  const failure = await compileFromUI(page, session);
  expect(failure.finished.status, failure.finished.log).toBe('failed');
  expect(failure.finished.exitCode).not.toBe(0);
  expect(failure.finished.log).toMatch(/Undefined control sequence/);
  expect(failure.finished.error.length).toBeGreaterThan(0);
  expect(failure.finished.pdfReady).toBe(true);
  expect(failure.finished.pdfBuildId).toBe(success.finished.pdfBuildId);
  const afterFailure = Buffer.from(await (await request(session, '/api/pdf')).arrayBuffer());
  expect(afterFailure.equals(previousPDF)).toBe(true);
  await expect(page.getByTestId('build-status')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('build-log')).toContainText('Undefined control sequence');
  const errorLocation = page.getByTestId('log-locations').locator(`button[data-path="main.tex"][data-line="${failingLine}"]`).first();
  await errorLocation.click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', String(failingLine));

  const slowSource = String.raw`\documentclass[uplatex,dvipdfmx]{jsarticle}
\begin{document}
\typeout{LOCAL_TEX_EDITOR_LONG_COMPILE}
\newwrite\editorreadyfile
\immediate\openout\editorreadyfile=editor-long-compile.ready
\immediate\write\editorreadyfile{LOCAL_TEX_EDITOR_LONG_COMPILE}
\immediate\closeout\editorreadyfile
\newcount\delaycounter
\delaycounter=0
\loop\advance\delaycounter by 1\ifnum\delaycounter<1000000000\repeat
Finished.
\end{document}
`;
  await replaceEditor(page, slowSource);
  const runningResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/build' && response.request().method() === 'POST');
  await page.getByTestId('compile-button').click();
  const started = await (await runningResponse).json();
  // Windows TeX may buffer terminal output during a long calculation. A closed
  // file confirms that the actual TeX child reached the loop before we stop it.
  const markerPath = path.join(session.project, '.local-tex-editor', 'build', 'editor-long-compile.ready');
  await waitUntil(async () => {
    const build = await json(session, '/api/build');
    const marker = await readFile(markerPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return { build, marker };
  }, value => value.build?.id === started.id && value.build.status === 'running' &&
    value.marker.includes('LOCAL_TEX_EDITOR_LONG_COMPILE'),
  20_000, 'The long-running TeX process did not reach the loop.');
  await page.getByTestId('stop-button').click();
  const stopped = await buildFinished(session, started.id);
  expect(stopped.status, stopped.log + '\n' + stopped.error).toBe('cancelled');
  await expect(page.getByTestId('build-status')).toHaveAttribute('data-status', 'cancelled');

  await replaceEditor(page, source);
  const recovered = await compileFromUI(page, session);
  expect(recovered.finished.status, recovered.finished.log + '\n' + recovered.finished.error).toBe('success');
});
