import test from 'node:test';
import assert from 'node:assert/strict';
import { combineCompletionItems } from '../web/src/completion-index.js';
import { extractCitations, extractTexMetadata, texCompletionSource } from '../web/src/tex-tools.js';
import { citationsForDestination } from '../web/src/pdf-citations.js';

const bib = (text, path = 'references.bib') => ({ citations: extractCitations(text, path), labels: [] });
const tex = text => ({ ...extractTexMetadata(text, 'main.tex'), citations: [] });

test('TeX 本文やラベルの編集では文献の索引を使い続け，ラベルの候補を更新する', () => {
  const bibliography = bib('@article{first, title={Original title}, author={First author}, year=2026}');
  const initial = combineCompletionItems(null, [tex('\\label{before}'), bibliography]);
  const edited = combineCompletionItems(initial, [tex('New text\n\\label{after}'), bibliography]);
  assert.equal(edited.citations, initial.citations);
  assert.deepEqual(edited.labels.map(entry => entry.key), ['after']);
  assert.equal(citationsForDestination('cite.first', edited.citations)[0].title, 'Original title');
});

test('文献の題名や著者の変更，追加，削除と別ファイルへの移動を反映する', () => {
  let current = combineCompletionItems(null, [bib('@article{first, title={Original title}, author={Author}, year=2026}')]);
  const previous = current.citations;
  current = combineCompletionItems(current, [bib('@article{first, title={Changed title}, author={New author}, date={2027-01}}\n@book{second, title={Second title}}')]);
  assert.notEqual(current.citations, previous);
  assert.deepEqual(current.citations.map(entry => entry.key), ['first', 'second']);
  assert.equal(citationsForDestination('cite.2@first', current.citations)[0].title, 'Changed title');
  assert.equal(current.citations[0].author, 'New author');
  assert.equal(current.citations[0].year, '2027-01');
  current = combineCompletionItems(current, [bib('@book{second, title={Moved title}}', 'other.bib')]);
  assert.deepEqual(citationsForDestination('cite.first', current.citations), []);
  assert.equal(citationsForDestination('cite.second', current.citations)[0].path, 'other.bib');
  current = combineCompletionItems(current, []);
  assert.deepEqual(current.citations, []);
  assert.deepEqual(current.labels, []);
});

test('引用と相互参照の補完は更新後の内容を使う', () => {
  let current = combineCompletionItems(null, [tex('\\label{section:old}'), bib('@article{old2026, title={Old title}}')]);
  const source = texCompletionSource(() => current);
  const options = text => source({ pos: text.length, state: { doc: { sliceString: (from, to) => text.slice(from, to) } } })?.options.map(item => item.label) || [];
  assert.deepEqual(options('\\cite{old'), ['old2026']);
  current = combineCompletionItems(current, [tex('\\label{section:new}'), bib('@article{new2027, title={New title}}')]);
  assert.deepEqual(options('\\cite{new'), ['new2027']);
  assert.deepEqual(options('\\ref{section:'), ['section:new']);
});
