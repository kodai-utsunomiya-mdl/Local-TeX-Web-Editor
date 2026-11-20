import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledPDFName, visibleCompiledPDFs } from '../web/src/compiled-pdfs.js';
import { setLanguage } from '../web/src/i18n.js';

const entries = [
  { buildId: 'build-c', main: 'chapters/third.tex', name: 'article10.pdf', modifiedAt: '2026-01-03T12:00:00Z' },
  { buildId: 'build-a', main: 'main.tex', name: 'article2.pdf', modifiedAt: '2026-01-05T12:00:00Z' },
  { buildId: 'build-b', main: 'notes.md', name: 'article1.pdf', modifiedAt: '2026-01-05T12:00:00Z' },
];
const ids = values => values.map(entry => entry.buildId);

test('PDF の実際の名前を使い，名前のない旧キャッシュではコンパイル元を表示する', () => {
  setLanguage('ja');
  try {
    assert.equal(compiledPDFName({ name: '投稿用の最終稿.pdf', main: 'main.tex' }), '投稿用の最終稿.pdf');
    assert.equal(compiledPDFName({ name: '', main: '原稿/概要.md' }), '原稿/概要.md の PDF');
    assert.equal(compiledPDFName({ main: 'chapters/notes.tex' }), 'chapters/notes.tex の PDF');
    setLanguage('en');
    assert.equal(compiledPDFName({ name: '', main: '原稿/{main}.md' }), 'PDF from 原稿/{main}.md');
  } finally { setLanguage('en'); }
});

test('名前の昇順と降順は PDF の名前に含まれる数字を使い，手動の並び順では昇順にする', () => {
  const before = structuredClone(entries);
  assert.deepEqual(ids(visibleCompiledPDFs(entries)), ['build-b', 'build-a', 'build-c']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { sort: 'name-desc' })), ['build-c', 'build-a', 'build-b']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { sort: 'manual' })), ['build-b', 'build-a', 'build-c']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { sort: 'unknown' })), ['build-b', 'build-a', 'build-c']);
  assert.deepEqual(entries, before);
  assert.equal(visibleCompiledPDFs(entries)[0], entries[2]);
});

test('更新日時は昇順と降順に対応し，同じ日時の PDF は名前の順にする', () => {
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { sort: 'modified-desc' })), ['build-b', 'build-a', 'build-c']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { sort: 'modified-asc' })), ['build-c', 'build-b', 'build-a']);
  const dates = [
    { buildId: 'new', main: 'main.tex', name: 'z.pdf', modifiedAt: '2026-01-01T12:00:00.123456789Z' },
    { buildId: 'old', main: 'note.tex', name: 'a.pdf', modifiedAt: '2026-01-01T12:00:00.123456788Z' },
    { buildId: 'missing', main: 'old.tex', name: 'b.pdf' },
    { buildId: 'invalid', main: 'other.tex', name: 'c.pdf', modifiedAt: 'unknown' },
  ];
  assert.deepEqual(ids(visibleCompiledPDFs(dates, { sort: 'modified-desc' })), ['new', 'old', 'missing', 'invalid']);
  assert.deepEqual(ids(visibleCompiledPDFs(dates, { sort: 'modified-asc' })), ['old', 'new', 'missing', 'invalid']);
});

test('検索では PDF 名とコンパイル元の相対パスに一致した項目を並べる', () => {
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { filter: ' ARTICLE ' })), ['build-b', 'build-a', 'build-c']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { filter: 'CHAPTERS/' })), ['build-c']);
  assert.deepEqual(ids(visibleCompiledPDFs(entries, { filter: 'notes.md' })), ['build-b']);
  assert.deepEqual(visibleCompiledPDFs(entries, { filter: 'not found' }), []);
  const old = { buildId: 'old', main: '原稿/補足.tex', name: '' };
  assert.deepEqual(visibleCompiledPDFs([old], { filter: '補足' }), [old]);
});

test('同じ PDF 名ではコンパイル元の順になり，本文の項目が欠けた記録は一覧に出さない', () => {
  const values = [
    { buildId: 'second', main: 'chapter2/main.tex', name: 'main.pdf' },
    { buildId: 'first', main: 'chapter1/main.tex', name: 'main.pdf' },
    { buildId: 'missing-main', name: 'main.pdf' },
    { main: 'missing-id.tex', name: 'main.pdf' },
    null,
  ];
  assert.deepEqual(ids(visibleCompiledPDFs(values)), ['first', 'second']);
  assert.deepEqual(visibleCompiledPDFs(undefined), []);
});
