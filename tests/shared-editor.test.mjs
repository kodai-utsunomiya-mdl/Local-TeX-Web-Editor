import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { stateForOtherView, restoredTabPaths } from '../web/src/shared-editor.js';

test('同じ原稿の二つの表示で編集，Undo，Redoを行い，各表示の選択範囲を更新する', () => {
  let left = EditorState.create({ doc: 'first\nsecond\nthird', extensions: [history()] });
  let right = left.update({ selection: { anchor: 13 } }).state;
  const change = left.update({ changes: { from: 0, insert: '日本語 ' }, annotations: isolateHistory.of('full') });
  left = change.state;
  right = stateForOtherView(left, right.selection, change.changes);
  assert.equal(right.selection.main.head, 17);
  const second = right.update({ changes: { from: right.doc.length, insert: '\nlast' }, annotations: isolateHistory.of('full') });
  right = second.state;
  left = stateForOtherView(right, left.selection, second.changes);
  assert.equal(left.doc.toString(), '日本語 first\nsecond\nthird\nlast');
  assert.equal(undo({ state: left, dispatch: transaction => {
    left = transaction.state;
    right = stateForOtherView(left, right.selection, transaction.changes);
  } }), true);
  assert.equal(right.doc.toString(), '日本語 first\nsecond\nthird');
  assert.equal(undo({ state: right, dispatch: transaction => {
    right = transaction.state;
    left = stateForOtherView(right, left.selection, transaction.changes);
  } }), true);
  assert.equal(left.doc.toString(), 'first\nsecond\nthird');
  assert.equal(redo({ state: left, dispatch: transaction => {
    left = transaction.state;
    right = stateForOtherView(left, right.selection, transaction.changes);
  } }), true);
  assert.equal(right.doc.toString(), '日本語 first\nsecond\nthird');
});

test('タブの復元では並び順を使い，重複と削除されたファイルを除く', () => {
  assert.deepEqual(restoredTabPaths({ tabs: ['b.tex', 'a.tex', 'b.tex', '../gone.tex', 7] }, ['a.tex', 'b.tex']), ['b.tex', 'a.tex']);
  assert.deepEqual(restoredTabPaths({ activePath: 'a.tex' }, [{ path: 'a.tex' }]), ['a.tex']);
  const many = Array.from({ length: 150 }, (_, index) => `chapter-${index}.tex`);
  assert.deepEqual(restoredTabPaths({ tabs: many }, many), many);
});
