import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestEntryCopyPath } from '../web/src/file-actions.js';

test('copy names use the same folder and file extension', () => {
  assert.equal(suggestEntryCopyPath({ path: 'chapters/原稿.tex', directory: false }, []), 'chapters/原稿-copy.tex');
  assert.equal(suggestEntryCopyPath({ path: 'images/figure.v2.png', directory: false }, []), 'images/figure.v2-copy.png');
  assert.equal(suggestEntryCopyPath({ path: '.latexmkrc', directory: false }, []), '.latexmkrc-copy');
  assert.equal(suggestEntryCopyPath({ path: 'chapters.v2', directory: true }, []), 'chapters.v2-copy');
});

test('copy names skip existing entries and folders with unsaved documents', () => {
  assert.equal(suggestEntryCopyPath({ path: 'notes.md', directory: false }, ['notes-copy.md', 'notes-copy-2.md']), 'notes-copy-3.md');
  assert.equal(suggestEntryCopyPath({ path: 'chapters', directory: true }, ['chapters-copy/a.tex', 'chapters-copy-2/unsaved.md']), 'chapters-copy-3');
  assert.equal(suggestEntryCopyPath({ path: 'photos/figure.PNG', directory: false }, ['photos/FIGURE-copy.png'], { platform: 'windows' }), 'photos/figure-copy-2.PNG');
});

test('copy names compare Unicode names and case according to the platform', () => {
  assert.equal(suggestEntryCopyPath({ path: 'café.md', directory: false }, ['cafe\u0301-copy.md']), 'café-copy-2.md');
  assert.equal(suggestEntryCopyPath({ path: 'Notes.md', directory: false }, ['notes-copy.md'], { platform: 'darwin' }), 'Notes-copy-2.md');
  assert.equal(suggestEntryCopyPath({ path: 'Notes.md', directory: false }, ['notes-copy.md'], { platform: 'linux' }), 'Notes-copy.md');
});
