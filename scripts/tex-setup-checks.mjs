import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repository = path.resolve(import.meta.dirname, '..');

function setupFailure(status) {
  // The full log is saved as an artifact. Keep the final command and its error
  // visible when Node limits the length of an assertion message.
  return `${status.error || ''}\n${String(status.log || '').slice(-32_000)}`;
}

async function waitForSetup(api, id, output, timeout = 20 * 60_000) {
  const deadline = Date.now() + timeout;
  let previousStage = '';
  while (Date.now() < deadline) {
    const status = await api('/api/tex/setup');
    assert.equal(status.id, id, 'Another setup job replaced the job under test.');
    if (status.stage !== previousStage) {
      console.log(`TeX setup: ${status.stage} (${status.status})`);
      previousStage = status.stage;
    }
    await writeFile(path.join(output, `setup-${id}-status.json`), JSON.stringify(status, null, 2));
    await writeFile(path.join(output, `setup-${id}.log`), status.log || '');
    if (!['running', 'cancelling'].includes(status.status)) return status;
    await delay(500);
  }
  await api('/api/tex/setup/stop', { id }).catch(() => {});
  throw new Error('TeX setup exceeded the integration test time limit.');
}

export function illustrationPDF() {
  const stream = '0.9 0.95 1 rg 0 0 120 70 re f 0 0.3 0.6 RG 3 w 12 15 m 50 54 l 106 24 l S';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 70] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  content += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

async function compile(api, main, output, name = path.parse(main).name) {
  const started = await api('/api/build', { main });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const build = await api('/api/build');
    if (build.id === started.id && build.status !== 'running') {
      await writeFile(path.join(output, `${name}.log`), `${build.log || ''}\n${build.error || ''}`);
      assert.equal(build.status, 'success', `Could not compile ${main}:\n${build.log}\n${build.error}`);
      assert.equal(build.pdfMain, main);
      assert.ok(build.pdfBuildId);
      assert.equal(build.synctexReady, true);
      return build;
    }
    await delay(200);
  }
  throw new Error(`Compilation of ${main} timed out.`);
}

export async function inspectPDF(data, name, output, { research = false } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const resources = path.join(repository, 'node_modules/pdfjs-dist');
  // PDF.js requires a trailing slash; Node accepts it in Windows file paths too.
  const loading = getDocument({
    data: new Uint8Array(data), useSystemFonts: false, fontExtraProperties: true,
    cMapUrl: path.join(resources, 'cmaps') + '/', cMapPacked: true,
    standardFontDataUrl: path.join(resources, 'standard_fonts') + '/',
    wasmUrl: path.join(resources, 'wasm') + '/',
  });
  const document = await loading.promise;
  try {
    assert.ok(document.numPages > 0);
    const metadata = await document.getMetadata();
    const fonts = new Map();
    let text = '';
    let illustrationPage = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str || '').join(' ');
      text += pageText + '\n';
      if (!illustrationPage && /TikZ/.test(pageText) && pageText.replace(/\s/g, '').includes('日本語の入力')) illustrationPage = number;
      await page.getOperatorList();
      for (const fontName of Object.keys(content.styles)) {
        if (!page.commonObjs.has(fontName)) continue;
        const font = page.commonObjs.get(fontName);
        fonts.set(font.name, { name: font.name, embedded: Boolean(font.data?.length), missingFile: Boolean(font.missingFile) });
      }
    }
    if (research) {
      assert.equal(metadata.info.Title, '日本語の組版とパッケージの確認');
      const compact = text.replace(/\s/g, '');
      for (const expected of ['日本語の本文', '日本語のボックス', '日本語の表', '日本語の手順', 'LaTeXDocumentation']) {
        assert.ok(compact.includes(expected), `${name}: PDF text did not contain ${expected}.`);
      }
      for (const expected of ['Theorem', 'Proposition', 'Lemma', 'Corollary', 'Definition', 'Assumption', 'Remark', 'Example']) {
        assert.ok(text.includes(expected), `${name}: ${expected} was not rendered.`);
      }
      assert.ok(!text.includes('??'), `${name}: PDF contains unresolved references.`);
      const fontNames = [...fonts.keys()].join(' ');
      assert.match(fontNames, /HaranoAjiMincho/i, `${name}: Japanese Mincho font is missing.`);
      assert.match(fontNames, /HaranoAjiGothic/i, `${name}: Japanese Gothic font is missing.`);
      assert.match(fontNames, /LMRoman/i, `${name}: Latin Modern font is missing.`);
      assert.match(fontNames, /dsrom/i, `${name}: dsfont's font is missing.`);
      assert.match(fontNames, /rsfs/i, `${name}: mathrsfs's font is missing.`);
      assert.ok([...fonts.values()].every(font => font.embedded && !font.missingFile), `${name}: Every used font must be embedded.`);
      const outline = await document.getOutline();
      assert.ok(outline?.length, `${name}: PDF bookmarks are missing.`);
      const { createCanvas } = await import('@napi-rs/canvas');
      for (const number of new Set([1, illustrationPage || document.numPages])) {
        const page = await document.getPage(number);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        await writeFile(path.join(output, `${name}-page-${number}.png`), canvas.toBuffer('image/png'));
      }
    }
    await writeFile(path.join(output, `${name}-text.txt`), text);
    return { name, pages: document.numPages, metadata: metadata.info, fonts: [...fonts.values()] };
  } finally { await loading.destroy(); }
}

export async function installAndCheckTeX({ api, request, temporary, output, useDefaultParent = false }) {
  await mkdir(output, { recursive: true });
  const parent = path.join(temporary, process.platform === 'win32' ? 'TeX-installation' : 'TeX installation');
  await mkdir(parent, { recursive: true });
  const previous = await api('/api/state');
  const unavailable = path.join(temporary, 'missing-tex');
  await api('/api/settings', { texBin: unavailable }, 'PUT');
  const initial = await api('/api/tex/setup');
  assert.equal(initial.supported, true);
  assert.equal(initial.managed, false);
  assert.ok(initial.archiveBytes > 50_000_000);
  assert.match(initial.source, /^https:\/\/github\.com\/rstudio\/tinytex-releases\/releases\/download\/v2026\.11\//);
  if (previous.packageIdentity) assert.match(initial.parent, /LocalState/i);
  const refused = await request('/api/tex/setup', { operation: 'install', parent });
  assert.equal(refused.status, 400, 'Installation must require the explicit consent value.');
  assert.equal((await api('/api/tex/setup')).status, initial.status);

  const cancelled = await api('/api/tex/setup', { operation: 'install', consent: true, parent });
  await api('/api/tex/setup/stop', { id: cancelled.id });
  const cancellationResult = await waitForSetup(api, cancelled.id, output, 30_000);
  assert.equal(cancellationResult.status, 'cancelled', setupFailure(cancellationResult));
  assert.equal((await api('/api/state')).texBin, unavailable, 'Cancellation must leave the previous TeX choice in place.');

  const startedAt = Date.now();
  const started = await api('/api/tex/setup', { operation: 'install', consent: true, ...(useDefaultParent ? {} : { parent }) });
  const installed = await waitForSetup(api, started.id, output);
  assert.equal(installed.status, 'succeeded', setupFailure(installed));
  assert.equal(installed.managed, true);
  const current = await api('/api/state');
  assert.equal(current.texSetup.managed, true);
  assert.equal(await realpath(current.texBin), await realpath(installed.bin));
  for (const name of ['latexmk', 'synctex', 'pdflatex', 'lualatex', 'xelatex', 'uplatex', 'dvipdfmx', 'upbibtex', 'bibtex', 'biber']) {
    assert.equal(current.texPackages.programs.find(program => program.name === name)?.available, true, `${name} must be available after setup.`);
  }

  const project = path.join(temporary, '日本語の原稿 with spaces');
  await cp(path.join(repository, 'tests/fixtures/tex-setup'), project, { recursive: true });
  await writeFile(path.join(project, 'image.pdf'), illustrationPDF());
  await api('/api/project/open', { path: project });
  await api('/api/settings', { mode: 'project' }, 'PUT');
  const documents = [];
  for (const main of ['thesis.tex', 'article.tex', 'neurips.tex']) {
    const build = await compile(api, main, output);
    const response = await request(`/api/pdf?build=${encodeURIComponent(build.pdfBuildId)}`);
    assert.equal(response.status, 200);
    const data = Buffer.from(await response.arrayBuffer());
    await writeFile(path.join(output, `${path.parse(main).name}.pdf`), data);
    documents.push(await inspectPDF(data, path.parse(main).name, output, { research: true }));
    const stem = path.parse(main).name;
    const key = createHash('sha256').update(process.platform === 'win32' ? main.toLowerCase() : main).digest('hex').slice(0, 32);
    const buildDirectory = path.join(project, '.local-tex-editor/build', `doc-${key}`);
    const aux = await readFile(path.join(buildDirectory, `${stem}.aux`), 'utf8');
    for (const [label, kind] of [['thm', 'theorem'], ['prop', 'proposition'], ['lem', 'lemma'], ['cor', 'corollary'], ['def', 'definition'], ['ass', 'assumption'], ['rem', 'remark'], ['ex', 'example']]) {
      assert.ok(aux.includes(`\\newlabel{${label}:check@cref}{{[${kind}]`), `${main}: cleveref did not use the ${kind} name.`);
    }
    const log = await readFile(path.join(buildDirectory, `${stem}.log`), 'utf8');
    assert.doesNotMatch(log, /Missing character:|There were undefined references|There were undefined citations|Font shape .* undefined|Some font shapes were not available/);
    assert.ok((await stat(path.join(buildDirectory, `${stem}.bbl`))).size > 0, `${main}: Bibliography must be built.`);
    const forward = await api('/api/synctex/forward', { buildId: build.pdfBuildId, path: 'body.tex', line: 3, column: 1 });
    assert.ok(forward.locations?.length, `${main}: SyncTeX must navigate into an included source file.`);
  }

  const engines = path.join(temporary, 'Other engines');
  await mkdir(engines, { recursive: true });
  await writeFile(path.join(engines, 'main.tex'), '\\documentclass{article}\n\\usepackage{amsmath,amssymb}\n\\begin{document}\nTeX setup: $x^2+1$.\n\\end{document}\n');
  await api('/api/project/open', { path: engines });
  for (const mode of ['pdflatex', 'xelatex', 'lualatex']) {
    await api('/api/settings', { mode }, 'PUT');
    const build = await compile(api, 'main.tex', output, mode);
    const response = await request(`/api/pdf?build=${encodeURIComponent(build.pdfBuildId)}`);
    assert.equal(response.status, 200);
    documents.push(await inspectPDF(Buffer.from(await response.arrayBuffer()), mode, output));
  }

  const beforeAddition = await api('/api/tex/packages');
  const additional = await api('/api/tex/setup', { operation: 'packages', consent: true, packages: ['siunitx'], reinstall: false, directory: beforeAddition.directory, revision: beforeAddition.revision });
  const added = await waitForSetup(api, additional.id, output, 5 * 60_000);
  assert.equal(added.status, 'succeeded', setupFailure(added));
  await writeFile(path.join(engines, 'units.tex'), '\\documentclass{article}\n\\usepackage{siunitx}\n\\begin{document}\n\\qty{12.3}{\\metre\\per\\second}\n\\end{document}\n');
  await api('/api/settings', { mode: 'pdflatex' }, 'PUT');
  await compile(api, 'units.tex', output);
  const packages = await api('/api/tex/packages');
  assert.equal(packages.managed, true);
  assert.ok(packages.packages.some(item => item.name === 'siunitx'), 'The added package must appear in the installed list.');
  const removal = await api('/api/tex/packages/remove-preview', { packages: ['siunitx'] });
  assert.ok(removal.removals.some(item => item.name === 'siunitx'));
  const rejected = await request('/api/tex/setup', { operation: 'remove-packages', consent: true, packages: ['siunitx'], directory: removal.directory, revision: 'outdated-preview' });
  assert.equal(rejected.status, 409, 'Package removal must require the current preview.');
  const removing = await api('/api/tex/setup', { operation: 'remove-packages', consent: true, packages: ['siunitx'], directory: removal.directory, revision: removal.revision });
  const removed = await waitForSetup(api, removing.id, output, 5 * 60_000);
  assert.equal(removed.status, 'succeeded', setupFailure(removed));
  assert.ok(!(await api('/api/tex/packages')).packages.some(item => item.name === 'siunitx'));
  await api('/api/project/open', { path: project });
  await api('/api/settings', { mode: 'project' }, 'PUT');
  await compile(api, 'article.tex', output, 'article-after-package-removal');
  const existing = await checkExistingTeX({ api, request, temporary, output, installed, project });
  const result = {
    version: current.version, platform: current.platform, architecture: current.architecture,
    packageIdentity: current.packageIdentity || null, release: installed.release,
    bin: current.texBin, directory: installed.directory, elapsedMS: Date.now() - startedAt,
    checks: ['consent', 'cancel-before-installation', 'verified-download', 'managed-tools', 'thesis-preamble', 'article-preamble', 'neurips-preamble', 'embedded-fonts', 'pdf-text', 'bibliography', 'theorem-references', 'synctex', 'pdflatex', 'xelatex', 'lualatex', 'additional-package', 'installed-package-list', 'package-removal-preview', 'package-removal', 'compile-after-package-removal'],
    documents, existing,
  };
  result.checks.push(...existing.checks);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`TeX setup and document checks passed on ${current.platform}/${current.architecture}.`);
  return result;
}

export async function checkExistingTeX({ api, request, temporary, output, installed, project }) {
  // Copy a disposable installation into an unrecorded location. Relative
  // symlinks must keep pointing into the copy, as a separately installed TeX
  // environment would. No computer-wide TeX installation is changed here.
  const directory = path.join(temporary, 'Previously installed TeX');
  const originalRoot = await realpath(installed.directory);
  const originalBin = await realpath(installed.bin);
  const relativeBin = path.relative(originalRoot, originalBin);
  assert.ok(relativeBin && !relativeBin.startsWith('..') && !path.isAbsolute(relativeBin));
  await cp(originalRoot, directory, { recursive: true, verbatimSymlinks: true });
  for (const name of ['.local-tex-editor-managed.json', '.local-tex-editor-files.json']) {
    await rm(path.join(directory, name), { force: true });
  }
  const bin = path.join(directory, relativeBin);
  try {
    await api('/api/settings', { texBin: bin }, 'PUT');
    const packages = await api('/api/tex/packages');
    assert.equal(packages.managed, false);
    assert.equal(packages.environment.managed, false);
    assert.equal(await realpath(packages.environment.directory), await realpath(directory));
    assert.equal(packages.environment.format, 'tinytex');
    assert.equal(packages.environment.canInstallPackages, true);
    assert.equal(packages.environment.canRemovePackages, true);
    assert.equal(packages.environment.requiresElevation, false);
    const started = await api('/api/tex/setup', { operation: 'packages', consent: true, packages: ['siunitx'], directory: packages.directory, revision: packages.revision });
    const added = await waitForSetup(api, started.id, output, 5 * 60_000);
    assert.equal(added.status, 'succeeded', setupFailure(added));
    assert.equal(added.managed, false);
    assert.ok((await api('/api/tex/packages')).packages.some(item => item.name === 'siunitx'));
    // The original installation has not received the package.
    await api('/api/settings', { texBin: installed.bin }, 'PUT');
    assert.ok(!(await api('/api/tex/packages')).packages.some(item => item.name === 'siunitx'));
    await api('/api/settings', { texBin: bin }, 'PUT');
    const preview = await api('/api/tex/packages/remove-preview', { packages: ['siunitx'] });
    assert.ok(preview.removals.some(item => item.name === 'siunitx'));
    const removing = await api('/api/tex/setup', { operation: 'remove-packages', consent: true, packages: ['siunitx'], directory: preview.directory, revision: preview.revision });
    const removed = await waitForSetup(api, removing.id, output, 5 * 60_000);
    assert.equal(removed.status, 'succeeded', setupFailure(removed));
    assert.ok(!(await api('/api/tex/packages')).packages.some(item => item.name === 'siunitx'));
    await api('/api/project/open', { path: project });
    await api('/api/settings', { mode: 'project' }, 'PUT');
    await compile(api, 'article.tex', output, 'existing-tex-article');
    const review = await api('/api/tex/setup/delete');
    assert.equal(await realpath(review.directory), await realpath(directory));
    assert.ok(review.fileCount > 100 && review.size > 50_000_000);
    const denied = await request('/api/tex/setup/delete', { directory: review.directory, revision: review.revision, confirmation: '' }, 'DELETE');
    assert.equal(denied.status, 400);
    assert.ok((await stat(directory)).isDirectory());
    const checks = ['existing-environment-list', 'existing-environment-add-package', 'existing-environment-remove-package', 'selected-environment-only', 'compile-with-existing-environment', 'existing-environment-delete-review'];
    const result = { environment: packages.environment, review, checks };
    await writeFile(path.join(output, 'existing-environment.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    const pending = await api('/api/tex/setup');
    if (['running', 'cancelling'].includes(pending.status)) {
      await api('/api/tex/setup/stop', { id: pending.id });
      await waitForSetup(api, pending.id, output, 60_000);
    }
    await api('/api/settings', { texBin: installed.bin }, 'PUT');
    // Native confirmation and Trash are covered by the platform tests. Delete
    // only this test-created copy after restoring the selected installation.
    await rm(directory, { recursive: true, force: true });
  }
}

export async function removeAndCheckTeX({ api, request, temporary, output, directory }) {
  await mkdir(output, { recursive: true });
  const source = path.join(temporary, '日本語の原稿 with spaces', 'article.tex');
  const originalSource = await readFile(source, 'utf8');
  const outside = path.join(path.dirname(directory), 'keep-outside-tex.txt');
  const unexpected = path.join(directory, 'user-notes-for-removal-check.tex');
  await writeFile(outside, 'This file is outside the TeX installation.\n', { flag: 'wx' });
  await writeFile(unexpected, 'A document placed in the TeX folder must stop removal.\n', { flag: 'wx' });
  const blocked = await api('/api/tex/setup/delete');
  assert.equal(blocked.directory, directory);
  assert.equal(blocked.canDelete, false);
  assert.ok(blocked.unknownFiles.some(name => name.endsWith(path.basename(unexpected))));
  const denied = await request('/api/tex/setup/delete', { directory, revision: blocked.revision, confirmation: 'TinyTeX' }, 'DELETE');
  assert.equal(denied.status, 409, 'Unrecognized files must stop deletion.');
  assert.ok((await stat(unexpected)).isFile());
  await rm(unexpected);
  const review = await api('/api/tex/setup/delete');
  await writeFile(path.join(output, 'delete-review.json'), JSON.stringify(review, null, 2));
  assert.equal(review.canDelete, true);
  assert.ok(review.fileCount > 100);
  assert.ok(review.size > 50_000_000);
  const wrongConfirmation = await request('/api/tex/setup/delete', { directory, revision: review.revision, confirmation: '' }, 'DELETE');
  assert.equal(wrongConfirmation.status, 400);
  const staleReview = await request('/api/tex/setup/delete', { directory, revision: 'outdated-preview', confirmation: 'TinyTeX' }, 'DELETE');
  assert.equal(staleReview.status, 409);
  assert.ok((await stat(directory)).isDirectory());
  const started = await api('/api/tex/setup/delete', { directory, revision: review.revision, confirmation: 'TinyTeX' }, 'DELETE');
  assert.equal(started.operation, 'uninstall');
  const finished = await waitForSetup(api, started.id, output, 120_000);
  assert.equal(finished.status, 'succeeded', setupFailure(finished));
  await assert.rejects(stat(directory), error => error.code === 'ENOENT');
  assert.equal(await readFile(outside, 'utf8'), 'This file is outside the TeX installation.\n');
  assert.equal(await readFile(source, 'utf8'), originalSource);
  const state = await api('/api/state');
  assert.equal(state.texSetup.managed, false);
  assert.notEqual(state.texBin, review.bin);
  const result = { directory, checks: ['unknown-files-stop-deletion', 'explicit-confirmation', 'current-review-required', 'managed-environment-removed', 'outside-files-intact', 'project-source-intact', 'settings-updated'] };
  await writeFile(path.join(output, 'delete-result.json'), JSON.stringify(result, null, 2));
  await rm(outside);
  return result;
}
