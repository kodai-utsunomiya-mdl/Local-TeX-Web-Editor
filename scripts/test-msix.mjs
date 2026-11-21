import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { installAndCheckTeX, removeAndCheckTeX } from './tex-setup-checks.mjs';

if (process.platform !== 'win32') throw new Error('Run the MSIX browser checks on Windows.');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1]);
for (const name of ['--ready-file', '--identity', '--temporary']) {
  if (!options.get(name)) throw new Error(`Missing ${name}. Start this check through scripts/test-msix.ps1.`);
}
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'test-results/msix');
const readyPath = options.get('--ready-file');
const ready = JSON.parse(await readFile(readyPath, 'utf8'));
const identity = JSON.parse(await readFile(options.get('--identity'), 'utf8'));
const temporary = options.get('--temporary');
const project = path.join(temporary, '日本語の原稿', 'Research notes');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
await mkdir(output, { recursive: true });
await cp(path.join(root, 'tests/fixtures/japanese'), project, { recursive: true });
await writeFile(path.join(project, 'notes.md'), [
  '# Research notes', '',
  'Keep derivations and reading notes beside the paper. Changes in this file appear in the preview as you type.', '',
  '## Regularized least squares', '',
  'For a design matrix $`X`$ and observations $`y`$, consider', '',
  '$$', '\\mathcal{L}(w) = \\frac{1}{2n}\\|Xw-y\\|^2 + \\frac{\\lambda}{2}\\|w\\|^2.', '$$', '',
  'Differentiating the objective gives the linear system', '',
  '$$', '(X^\\top X + n\\lambda I)\\widehat{w} = X^\\top y.', '$$', '',
  '## Writing checklist', '',
  '- [x] State the model and notation', '- [x] Check the normal equations', '- [ ] Add the experiment figure', '',
  '| File | Purpose |', '| --- | --- |',
  '| `main.tex` | Paper and derivation |', '| `references.bib` | Bibliography |', '| `notes.md` | Reading and experiment notes |', '',
  '## In the paper', '', '```tex', '\\section{Regularized least squares}', '\\label{sec:least-squares}', '```', '',
  '> Choose **PDF** in the preview selector to keep reading the compiled paper while editing these notes.',
].join('\n'));
const other = '別の 原稿.tex';
await writeFile(path.join(project, other), '\\documentclass[uplatex,dvipdfmx]{jsarticle}\n\\begin{document}\nMSIX で別の文書をコンパイルする．\n\\end{document}\n');

async function waitFor(read, predicate, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(description);
}

async function request(endpoint, data, method = data === undefined ? 'GET' : 'POST') {
  return fetch(new URL(endpoint, ready.url), {
    method,
    headers: { Origin: new URL(ready.url).origin, 'X-Local-Token': ready.token, 'Accept-Language': 'en', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(endpoint.includes('/tex/setup/delete') ? 660000 : 20000),
  });
}
async function api(endpoint, data, method) {
  const response = await request(endpoint, data, method);
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}\n${text}`);
  return JSON.parse(text);
}

let browser, context, page, passed = false;
const errors = [];
async function compile() {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/build' && response.request().method() === 'POST'),
    page.getByTestId('compile-button').click(),
  ]);
  assert.equal(response.ok(), true, await response.text());
  const started = await response.json();
  const finished = await waitFor(() => api('/api/build'), build => build.id === started.id && build.status !== 'running', 'TeX compilation did not finish.', 120000);
  await writeFile(path.join(output, `compile-${started.id}.log`), `${finished.log || ''}\n${finished.error || ''}`);
  assert.equal(finished.status, 'success', `${finished.log}\n${finished.error}`);
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-build-id', finished.pdfBuildId, { timeout: 20000 });
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  return finished;
}

try {
  assert.equal(ready.version, version);
  const setup = await installAndCheckTeX({ api, request, temporary, output: path.join(output, 'tex-setup'), useDefaultParent: true });
  const initial = await api('/api/state');
  assert.equal(initial.platform, 'windows');
  assert.deepEqual(initial.packageIdentity, { fullName: identity.fullName, familyName: identity.familyName });
  assert.equal(initial.shortcutsSupported, false);
  assert.ok(initial.latexmk, 'The selected TeX Live installation must provide latexmk.');
  assert.ok(initial.synctex, 'The selected TeX Live installation must provide SyncTeX.');
  const active = JSON.parse(await readFile(path.join(identity.configDir, 'active.json'), 'utf8'));
  assert.equal(active.pid, ready.pid);
  const shortcut = await request('/api/shortcuts', { destination: 'desktop' });
  assert.equal(shortcut.status, 501, await shortcut.text());
  await api('/api/project/open', { path: project });

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${ready.url}#token=${encodeURIComponent(ready.token)}`);
  const editor = page.getByTestId('editor').locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 20000 });
  await page.getByTestId('settings-button').click();
  await expect(page.locator('#shortcut-settings')).toBeHidden();
  await page.getByTestId('language-setting').selectOption('en');
  await page.locator('#save-settings').click();
  await expect(page.locator('#save-settings')).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
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
while using the same observations. We record the residual and the coefficient
norm for each choice.

\subsection{Notes for the experiment}
The source, bibliography and notes live in one project folder. We keep the model
description next to the derivation when preparing the figures.
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
  const source = (await readFile(path.join(project, 'main.tex'), 'utf8')).replaceAll('\r\n', '\n')
    .replace('Local TeX Web Editor の動作確認', 'Research notes: a linear model')
    .replace('日本語と空白を含むフォルダーから，既存の設定で原稿をコンパイルする．', 'We begin with a simple model and record the assumptions used in the analysis.')
    .replace('参考文献の例として，\\citep{sample2026} を引用する．', 'The bibliography is compiled with the paper \\citep{sample2026}.')
    .replace('\n\\newpage', `${example}\n\\newpage`);
  const inserted = 'MSIX のブラウザから保存した文章である．';
  const changed = source.replace('\\end{document}', `${inserted}\n\\end{document}`);
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(changed);
  await page.keyboard.press('Control+s');
  await waitFor(() => readFile(path.join(project, 'main.tex'), 'utf8'), value => value.includes(inserted), 'The packaged application did not save the external TeX source.');
  const first = await compile();
  const build = path.join(project, '.local-tex-editor/build');
  const bibliography = await readFile(path.join(build, 'main.bbl'), 'utf8');
  assert.match(bibliography, /sample2026/);
  const finalLog = await readFile(path.join(build, 'main.log'), 'utf8');
  await writeFile(path.join(output, 'latex-final.log'), finalLog);
  assert.doesNotMatch(finalLog, /There were undefined citations|Citation .* undefined/);
  assert.match(first.log, /LOCAL_TEX_EDITOR_RC_LOADED/);
  const pdf = await request(`/api/pdf?build=${encodeURIComponent(first.pdfBuildId)}`);
  assert.equal(pdf.ok, true);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('ascii'), '%PDF-');
  const forward = await api('/api/synctex/forward', { buildId: first.pdfBuildId, path: 'main.tex', line: 10, column: 0 });
  assert.ok(forward.locations?.length, 'SyncTeX must locate the Japanese source in the PDF.');
  const location = forward.locations[0];
  const inverse = await api('/api/synctex/inverse', { buildId: first.pdfBuildId, page: location.page, x: location.x, y: location.y });
  assert.equal(inverse.path, 'main.tex');
  assert.ok(inverse.line > 0);
  if (await page.locator('html').getAttribute('data-theme') !== 'dark') await page.getByTestId('theme-toggle').click();
  await editor.click();
  await page.keyboard.press('Control+Home');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#app-error')).toBeHidden();
  await expect(page.locator('#pdf-state')).not.toHaveClass(/stale/);
  await expect(page.locator('#toast')).toBeHidden();
  await page.screenshot({ path: path.join(output, 'editor-tex-dark.png') });
  await page.getByTestId('settings-button').click();
  await page.locator('#settings-tex-setup').click();
  const management = page.locator('#tex-management-dialog');
  await expect(management).toBeVisible();
  await expect(page.locator('#tex-package-list')).toContainText('amsmath', { timeout: 120000 });
  await page.locator('#tex-package-filter').fill('math');
  await expect(page.locator('#tex-package-list')).toContainText('amsmath');
  await expect(management.locator('.form-error')).toBeHidden();
  await page.screenshot({ path: path.join(output, 'editor-tex-management.png') });
  await management.getByRole('button', { name: 'Close', exact: true }).first().click();
  if (await page.locator('#settings-dialog').isVisible()) await page.keyboard.press('Escape');
  await page.getByTestId('pdf-next').click();
  await expect(page.getByTestId('pdf-page')).toHaveValue('2');

  const included = '追加の 原稿.tex';
  await page.getByTestId(`file-${included}`).click();
  await expect(editor).toContainText('これは SyncTeX');
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  const forwardResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/synctex/forward' && response.request().method() === 'POST');
  await page.getByTestId('synctex-forward').click();
  const forwarded = await forwardResponse;
  assert.equal(forwarded.ok(), true, await forwarded.text());
  const requestedLocation = (await forwarded.json()).locations[0];
  assert.ok(requestedLocation, 'The forward button must find the included Japanese source.');
  await expect(page.getByTestId('pdf-page')).toHaveValue(String(requestedLocation.page));
  await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-page', String(requestedLocation.page));
  const highlight = page.getByTestId('synctex-highlight');
  await expect(highlight).toBeVisible();
  const box = await highlight.evaluate(element => ({
    left: parseFloat(element.style.left), top: parseFloat(element.style.top),
    width: parseFloat(element.style.width), height: parseFloat(element.style.height),
    page: element.closest('.page').dataset.pageNumber,
  }));
  assert.equal(box.page, String(requestedLocation.page));
  assert.ok([box.left, box.top, box.width, box.height].every(Number.isFinite));
  assert.ok(box.width > 8 && box.height > 6, 'The PDF must show the source location with a visible highlight.');
  await expect(page.getByTestId('app-error')).toBeHidden();
  // Start from main.tex so the PDF click has to reopen the included source.
  await page.getByTestId('file-main.tex').click();
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'main.tex');
  const inverseResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/synctex/inverse' && response.request().method() === 'POST');
  await page.locator(`.pdfViewer .page[data-page-number="${requestedLocation.page}"] .textLayer span`)
    .filter({ hasText: 'SyncTeX' }).first().dblclick();
  const clicked = await inverseResponse;
  assert.equal(clicked.ok(), true, await clicked.text());
  const clickedSource = await clicked.json();
  assert.equal(clickedSource.path, included);
  assert.ok(clickedSource.line >= 2 && clickedSource.line <= 3);
  await expect(editor).toContainText('これは SyncTeX');
  await expect(page.getByTestId('editor')).toHaveAttribute('data-path', included);
  await expect(page.getByTestId('editor')).toHaveAttribute('data-line', String(clickedSource.line));
  await expect(page.getByTestId('app-error')).toBeHidden();

  await page.getByTestId(`file-${other}`).click();
  const second = await compile();
  assert.equal(second.main, other);
  await expect(page.getByTestId('pdf-document')).toHaveText(other);
  await page.getByTestId('file-notes.md').click();
  await page.locator('#markdown-editor-mode').selectOption('source');
  const preview = page.getByTestId('markdown-document');
  await expect(preview.getByRole('heading', { name: 'Research notes', exact: true })).toBeVisible();
  await expect(preview.locator('.katex')).toHaveCount(4);
  if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.getByTestId('theme-toggle').click();
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#app-error')).toBeHidden();
  await expect(page.locator('#toast')).toBeHidden();
  await page.screenshot({ path: path.join(output, 'editor-markdown-light.png') });
  await waitFor(async () => readdir(path.join(identity.configDir, 'ui-state')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }), names => names.some(name => name.endsWith('.json')), 'The app did not save UI preferences in package LocalState.');
  assert.deepEqual(errors, []);
  const removed = await removeAndCheckTeX({ api, request, temporary, output: path.join(output, 'tex-setup'), directory: setup.directory });
  await page.locator('#shutdown-button').click();
  await waitFor(async () => {
    const removed = await Promise.all([readyPath, path.join(identity.configDir, 'active.json')]
      .map(filename => stat(filename).then(() => false, error => {
        if (error.code === 'ENOENT') return true;
        throw error;
      })));
    return removed.every(Boolean);
  }, value => value, 'The packaged application did not remove both its ready and active files during shutdown.');
  await writeFile(path.join(output, 'result.json'), JSON.stringify({
    version, packageVersion: identity.packageVersion, architecture: process.arch,
    packageIdentity: initial.packageIdentity,
    checks: ['package-identity', 'package-localstate', 'store-shortcuts', 'optional-tex-setup', 'thesis-preambles', 'external-source-save', 'japanese-tex', 'bibliography', 'synctex', 'synctex-ui', 'pdf', 'active-document', 'markdown', 'shutdown'],
    texSetup: { release: setup.release, directory: setup.directory, checks: [...setup.checks, ...removed.checks] },
  }, null, 2));
  passed = true;
  console.log('Installed MSIX: package identity, local TeX, browser editing, previews, and shutdown passed.');
} finally {
  if (!passed && page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  if (context) await context.tracing.stop({ path: path.join(output, 'trace.zip') }).catch(() => {});
  await request('/api/shutdown', {}).catch(() => {});
  await browser?.close();
}
