import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTree, fileModificationTime, normalizeFileSort, projectListingSignature } from '../web/src/file-sorting.js';

const paths = entries => entries.map(entry => entry.path);
const date = day => `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`;
const project = {
  root: '/project',
  files: [
    { path: 'note10.md', modifiedAt: date(3) },
    { path: 'note2.md', modifiedAt: date(5) },
    { path: 'note1.md', modifiedAt: date(5) },
    { path: 'chapter10/item10.md', modifiedAt: date(2) },
    { path: 'chapter10/item2.md', modifiedAt: date(9) },
    { path: 'chapter2/item3.md', modifiedAt: date(4) },
  ],
  directories: ['chapter10', 'chapter2', 'empty'],
  directoryModifiedAt: { chapter10: date(1), chapter2: date(6), empty: date(4) },
};

test('名前の昇順と降順は各フォルダーの中で数字を含む名前を並べる', () => {
  const before = structuredClone(project);
  const ascending = buildFileTree(project);
  assert.deepEqual(paths(ascending.directories), ['chapter2', 'chapter10', 'empty']);
  assert.deepEqual(paths(ascending.files), ['note1.md', 'note2.md', 'note10.md']);
  assert.deepEqual(paths(ascending.directories[1].files), ['chapter10/item2.md', 'chapter10/item10.md']);
  const descending = buildFileTree(project, { sort: 'name-desc' });
  assert.deepEqual(paths(descending.directories), ['empty', 'chapter10', 'chapter2']);
  assert.deepEqual(paths(descending.files), ['note10.md', 'note2.md', 'note1.md']);
  assert.deepEqual(paths(descending.directories[1].files), ['chapter10/item10.md', 'chapter10/item2.md']);
  assert.deepEqual(project, before);
});

test('更新日時の並び順はフォルダー自身の日時を使い，同じ日時は名前の順にする', () => {
  const newest = buildFileTree(project, { sort: 'modified-desc' });
  assert.deepEqual(paths(newest.directories), ['chapter2', 'empty', 'chapter10']);
  assert.deepEqual(paths(newest.files), ['note1.md', 'note2.md', 'note10.md']);
  assert.deepEqual(paths(newest.directories[2].files), ['chapter10/item2.md', 'chapter10/item10.md']);
  const oldest = buildFileTree(project, { sort: 'modified-asc' });
  assert.deepEqual(paths(oldest.directories), ['chapter10', 'empty', 'chapter2']);
  assert.deepEqual(paths(oldest.files), ['note10.md', 'note1.md', 'note2.md']);
  assert.deepEqual(paths(oldest.directories[0].files), ['chapter10/item10.md', 'chapter10/item2.md']);
});

test('検索結果にも同じ並び順を使い，見つかったファイルの親の日時を参照する', () => {
  const filtered = buildFileTree(project, { sort: 'modified-desc', filter: ' ITEM ' });
  assert.deepEqual(paths(filtered.directories), ['chapter2', 'chapter10']);
  assert.equal(filtered.directories[0].modifiedAt, date(6));
  assert.deepEqual(paths(filtered.directories[1].files), ['chapter10/item2.md', 'chapter10/item10.md']);
  assert.deepEqual(filtered.files, []);
  const folder = buildFileTree(project, { filter: 'empty' });
  assert.deepEqual(paths(folder.directories), ['empty']);
  assert.deepEqual(folder.directories[0].files, []);
});

test('日時がない項目は日時の昇順でも降順でも最後に表示する', () => {
  const entries = { files: [
    { path: 'missing.md' }, { path: 'invalid.md', modifiedAt: 'unknown' },
    { path: 'valid.md', modifiedAt: date(1) },
  ] };
  for (const sort of ['modified-asc', 'modified-desc']) {
    assert.deepEqual(paths(buildFileTree(entries, { sort }).files), ['valid.md', 'invalid.md', 'missing.md']);
  }
  assert.equal(fileModificationTime('unknown'), null);
  assert.equal(fileModificationTime(undefined), null);
  assert.equal(fileModificationTime(date(1)), Date.parse(date(1)));
  assert.equal(normalizeFileSort('modified-desc'), 'modified-desc');
  assert.equal(normalizeFileSort('unknown'), 'name-asc');
});

test('同じミリ秒に更新されたファイルも OS が返す小数秒の順で並べる', () => {
  const entries = { files: [
    { path: 'a.txt', modifiedAt: '2026-01-01T12:00:00.123456789Z' },
    { path: 'b.txt', modifiedAt: '2026-01-01T12:00:00.123456788Z' },
    { path: 'c.txt', modifiedAt: '2026-01-01T12:00:00.123Z' },
  ] };
  assert.deepEqual(paths(buildFileTree(entries, { sort: 'modified-asc' }).files), ['c.txt', 'b.txt', 'a.txt']);
  assert.deepEqual(paths(buildFileTree(entries, { sort: 'modified-desc' }).files), ['a.txt', 'b.txt', 'c.txt']);
});

test('一覧の比較は本文を読むことなくファイルとフォルダーの更新を検出する', () => {
  assert.equal(projectListingSignature(project), projectListingSignature(structuredClone(project)));
  const changed = structuredClone(project);
  changed.files[0].modifiedAt = date(8);
  assert.notEqual(projectListingSignature(project), projectListingSignature(changed));
  const folderChanged = structuredClone(project);
  folderChanged.directoryModifiedAt.chapter10 = date(8);
  assert.notEqual(projectListingSignature(project), projectListingSignature(folderChanged));
});
