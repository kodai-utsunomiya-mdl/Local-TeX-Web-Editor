import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementChanges, replaceProjectDocuments } from '../web/src/project-search.js';

test('project replacement uses UTF-16 positions and leaves unselected matches unchanged', () => {
  const files = [{ path: '章.tex', content: '😀猫\n猫と犬\n', revision: 'old', matches: [
    { from: 2, to: 3, text: '猫', replacement: 'dog' },
    { from: 4, to: 5, text: '猫', replacement: '$1' },
  ] }];
  assert.deepEqual(replacementChanges(files, new Set(['章.tex\0' + 1])), [{ path: '章.tex', content: '😀猫\n$1と犬\n', revision: 'old', expectedContent: files[0].content, edits: [{ from: 4, to: 5, insert: '$1' }] }]);
  assert.equal(replacementChanges(files, new Set(['章.tex\0' + 0, '章.tex\0' + 1]))[0].content, '😀dog\n$1と犬\n');
});

test('a stale search result cannot replace a newly edited open document', async () => {
  let requested = false;
  await assert.rejects(replaceProjectDocuments(async () => { requested = true; }, [{ path: 'main.tex', content: 'after', revision: 'r1', expectedContent: 'before' }], [{ path: 'main.tex', content: 'another edit', revision: 'r2' }]), /edited after the search/);
  assert.equal(requested, false);
});

test('replacement uses the revision from a completed autosave of unchanged text', async () => {
  let sent, applied;
  const documents = [{ path: 'main.tex', content: 'after', revision: 'r3' }];
  await replaceProjectDocuments(async (path, options) => { assert.equal(path, '/api/project/replace'); sent = options.body; return { documents }; }, [{ path: 'main.tex', content: 'after', revision: 'r1', expectedContent: 'before' }], [{ path: 'main.tex', content: 'before', revision: 'r2' }], value => { applied = value; });
  assert.equal(sent.changes[0].revision, 'r2'); assert.deepEqual(applied, documents);
});

test('an error after some files were saved still updates those files in the editor', async () => {
  const documents = [{ path: 'a.tex', content: 'new', revision: 'new-r' }];
  const error = Object.assign(new Error('z.tex changed on disk'), { status: 409, data: { documents } });
  let applied;
  await assert.rejects(replaceProjectDocuments(async () => { throw error; }, [{ path: 'a.tex', content: 'new', revision: 'old-r', expectedContent: 'old' }], [], value => { applied = value; }), /changed on disk/);
  assert.deepEqual(applied, documents);
});
