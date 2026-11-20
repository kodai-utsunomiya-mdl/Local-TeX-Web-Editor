import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Compartment } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { history, undo } from '@codemirror/commands';
import { programLanguage, programLanguageName } from '../web/src/program-language.js';
import { absoluteProjectPath, entryContains, mapEntryPath, fileDestinationConflict } from '../web/src/file-actions.js';

test('program files select a cached language and parse source tokens', () => {
  for (const [path, expected] of [['code.PY', 'python'], ['app.tsx', 'typescript'], ['lib.rs', 'rust'], ['Dockerfile', 'dockerFile'], ['src/CMakeLists.txt', 'cmake'], ['data.ipynb', 'json']]) {
    assert.equal(programLanguageName(path), expected);
    assert.equal(programLanguage(path), programLanguage(path));
  }
  assert.deepEqual(programLanguage('notes.txt'), []);
  const state = EditorState.create({ doc: 'def square(value):\n    return value ** 2 # 日本語\n', extensions: [programLanguage('analysis.py')] });
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  assert.ok(tree); assert.ok(tree.length > 0);
  const types = [];
  tree.iterate({ enter: node => types.push(node.name) });
  assert.ok(types.some(name => /keyword|definition|comment/.test(name)), types.join(', '));
});

test('an open document or draft at the destination blocks a rename even after the disk file was removed', () => {
  const paths = ['source.py', 'missing.py', 'notes/missing.md'];
  assert.equal(fileDestinationConflict('missing.py', paths, { source: { path: 'source.py', directory: false } }), 'missing.py');
  assert.equal(fileDestinationConflict('notes', paths, { source: { path: 'old-notes', directory: true } }), 'notes/missing.md');
  assert.equal(fileDestinationConflict('notes', paths), 'notes/missing.md');
  assert.equal(fileDestinationConflict('new.py', paths), '');
  assert.equal(fileDestinationConflict('SOURCE.py', paths, { source: { path: 'source.py', directory: false }, platform: 'windows' }), '');
  assert.equal(fileDestinationConflict('MISSING.py', paths, { platform: 'windows' }), 'missing.py');
  assert.equal(fileDestinationConflict('notes/missing.md', paths, { source: { path: 'notes', directory: true } }), '');
});

test('changing a file extension can change syntax without losing Undo history', () => {
  const syntax = new Compartment();
  let state = EditorState.create({ doc: 'old', extensions: [history(), syntax.of(programLanguage('notes.txt'))] });
  state = state.update({ changes: { from: 0, to: 3, insert: 'print("new")' }, userEvent: 'input' }).state;
  state = state.update({ effects: syntax.reconfigure(programLanguage('script.py')) }).state;
  assert.equal(undo({ state, dispatch: transaction => { state = transaction.state; } }), true);
  assert.equal(state.doc.toString(), 'old');
});

test('folder path changes apply only inside that folder and copied paths use the host spelling', () => {
  const entry = { path: 'chapters', directory: true };
  assert.equal(entryContains(entry, 'chapters/a.tex'), true);
  assert.equal(entryContains(entry, 'chapters-other/a.tex'), false);
  assert.equal(mapEntryPath('chapters/a.tex', 'chapters', 'sections', true), 'sections/a.tex');
  assert.equal(mapEntryPath('chapters-old/a.tex', 'chapters', 'sections', true), 'chapters-old/a.tex');
  assert.equal(absoluteProjectPath('C:\\Users\\writer\\paper', 'figures/image.png'), 'C:\\Users\\writer\\paper\\figures\\image.png');
  assert.equal(absoluteProjectPath('/Users/writer/paper/', 'figures/image.png'), '/Users/writer/paper/figures/image.png');
  assert.equal(absoluteProjectPath('\\\\server\\share\\paper', 'main.tex'), '\\\\server\\share\\paper\\main.tex');
  assert.equal(absoluteProjectPath('/', ''), '/');
  assert.equal(absoluteProjectPath('C:\\', ''), 'C:\\');
});
