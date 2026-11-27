import test from 'node:test';
import assert from 'node:assert/strict';
import { exportProjectZIP, projectParentFolder, projectZIPDestination, projectZIPFilename, projectZIPLimit, suggestProjectZIPName, validateProjectZIP } from '../web/src/project-zip.js';

test('ZIP names produce usable folder names for Japanese and English projects', () => {
  assert.equal(suggestProjectZIPName('日本語の 原稿.ZIP'), '日本語の 原稿');
  assert.equal(suggestProjectZIPName('C:\\Downloads\\my:paper.zip'), 'my-paper');
  assert.equal(suggestProjectZIPName('....zip'), 'project');
  assert.equal(suggestProjectZIPName('NUL.zip'), 'project');
  assert.equal(projectZIPFilename({ name: 'Research notes', root: '/papers/research' }), 'Research notes.zip');
  assert.equal(projectZIPFilename({ root: 'C:\\研究\\日本語の 原稿\\' }), '日本語の 原稿.zip');
});

test('parent folder and destination previews handle filesystem roots and network folders', () => {
  assert.equal(projectParentFolder('/home/research/paper'), '/home/research');
  assert.equal(projectParentFolder('/paper'), '/');
  assert.equal(projectParentFolder('C:\\paper'), 'C:\\');
  assert.equal(projectParentFolder('C:\\research\\paper\\'), 'C:\\research');
  assert.equal(projectParentFolder('\\\\server\\share\\paper'), '\\\\server\\share');
  assert.equal(projectParentFolder(''), '');
  assert.equal(projectZIPDestination('/', '日本語'), '/日本語');
  assert.equal(projectZIPDestination('C:\\', 'paper'), 'C:\\paper');
  assert.equal(projectZIPDestination('\\\\server\\share\\', 'paper'), '\\\\server\\share\\paper');
  assert.equal(projectZIPDestination(' ', 'paper'), '');
});

test('ZIP import checks the selected archive, size, parent folder and project name', () => {
  const input = { archive: { name: 'paper.zip', size: 1234 }, parent: '/research', name: '日本語の 原稿' };
  assert.equal(validateProjectZIP(input), '');
  assert.match(validateProjectZIP({ ...input, archive: null }), /ZIP/);
  assert.match(validateProjectZIP({ ...input, archive: { name: 'paper.pdf', size: 2 } }), /\.zip/);
  assert.match(validateProjectZIP({ ...input, archive: { name: 'paper.zip', size: 0 } }), /空/);
  assert.equal(validateProjectZIP({ ...input, archive: { name: 'paper.zip', size: projectZIPLimit } }), '');
  assert.match(validateProjectZIP({ ...input, archive: { name: 'paper.zip', size: projectZIPLimit + 1 } }), /512 MiB/);
  assert.match(validateProjectZIP({ ...input, parent: '' }), /親フォルダー/);
  for (const name of ['', '.', '..', 'paper/next', 'paper\\next', 'paper.', 'AUX', 'NUL.tex', '.local-tex-editor', 'paper?']) assert.ok(validateProjectZIP({ ...input, name }), name);
});

test('project download saves every document and flushes storage before requesting the ZIP', async () => {
  const calls = [], project = { root: '/papers/current', name: 'Current paper' }, blob = new Blob(['archive']);
  const result = await exportProjectZIP({ project,
    saveAll: async () => { calls.push('save'); }, flush: async () => { calls.push('flush'); },
    api: async (url, options) => { calls.push({ url, options }); return blob; },
    saveBlob: async (value, name) => { assert.equal(value, blob); calls.push(name); },
  });
  assert.deepEqual(calls, ['save', 'flush', { url: '/api/project/download', options: { method: 'POST', body: {}, projectRoot: project.root, timeout: 0, responseType: 'blob' } }, 'Current paper.zip']);
  assert.deepEqual(result, { downloaded: true });
});

test('a save failure stops the archive request and leaves the error available for conflict review', async () => {
  const conflict = Object.assign(new Error('The document changed on disk'), { shown: true }), calls = [];
  await assert.rejects(exportProjectZIP({ project: { root: '/paper' },
    saveAll: async () => { throw conflict; }, flush: async () => { calls.push('flush'); },
    api: async () => { calls.push('api'); }, saveBlob: async () => { calls.push('download'); },
  }), error => error === conflict && error.shown);
  assert.deepEqual(calls, []);
});

test('a failed storage flush stops the ZIP request after documents were saved', async () => {
  const calls = [];
  await assert.rejects(exportProjectZIP({ project: { root: '/paper' },
    saveAll: async () => { calls.push('save'); }, flush: async () => { throw new Error('Storage is unavailable'); },
    api: async () => { calls.push('api'); }, saveBlob: async () => { calls.push('download'); },
  }), /Storage/);
  assert.deepEqual(calls, ['save']);
});

test('Save As uses the native destination API and returns cancellation without a download', async () => {
  const calls = [];
  const result = await exportProjectZIP({ project: { root: 'C:\\paper' }, saveAs: true,
    saveAll: async () => { calls.push('save'); }, flush: async () => { calls.push('flush'); },
    api: async (url, options) => { calls.push({ url, options }); return { cancelled: true }; },
    saveBlob: async () => { assert.fail('Save As must use the selected filesystem destination'); },
  });
  assert.deepEqual(calls, ['save', 'flush', { url: '/api/project/save-as', options: { method: 'POST', body: {}, projectRoot: 'C:\\paper', timeout: 0 } }]);
  assert.deepEqual(result, { cancelled: true });
});

test('exporting another recent project leaves the current documents unsaved and requests its own folder', async () => {
  const calls = [], project = { root: '/papers/earlier' }, blob = new Blob(['earlier archive']);
  await exportProjectZIP({ project, currentProjectRoot: '/papers/current',
    saveAll: async () => { assert.fail('The current project is still being edited'); },
    flush: async () => { calls.push('flush'); },
    api: async (url, options) => { calls.push({ url, options }); return blob; },
    saveBlob: async (value, name) => { assert.equal(value, blob); calls.push(name); },
  });
  assert.deepEqual(calls, ['flush', { url: '/api/project/download', options: {
    method: 'POST', body: { path: project.root }, projectRoot: null, timeout: 0, responseType: 'blob',
  } }, 'earlier.zip']);
});

test('a recent project can use Save As from Home when no project is open', async () => {
  const project = { root: '/papers/earlier' };
  const result = await exportProjectZIP({ project, currentProjectRoot: null, saveAs: true,
    saveAll: async () => { assert.fail('There is no open project'); }, flush: async () => {},
    api: async (url, options) => {
      assert.equal(url, '/api/project/save-as');
      assert.deepEqual(options, { method: 'POST', body: { path: project.root }, projectRoot: null, timeout: 0 });
      return { cancelled: true };
    },
    saveBlob: async () => { assert.fail('Save As uses the OS file picker'); },
  });
  assert.deepEqual(result, { cancelled: true });
});
