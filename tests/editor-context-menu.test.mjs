import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState as SourceState, EditorSelection } from '@codemirror/state';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { parseMarkdown } from '../web/src/markdown-rich-document.js';
import { editorInsertionItems, prepareEditorContext, editorContextIsCurrent } from '../web/src/editor-context-menu.js';

function targetFor(kind, state, hit) {
  const target = { kind, path: kind === 'source' ? 'notes.tex' : 'notes.md', active: 0, current: true };
  target.activate = () => { target.active++; };
  target.isCurrent = () => target.current;
  target.view = {
    state, composing: false,
    dom: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    posAtCoords: () => hit,
    coordsAtPos: position => ({ left: position * 7, bottom: 48 }),
    dispatch(transaction) { this.state = kind === 'source' ? this.state.update(transaction).state : this.state.apply(transaction); },
  };
  return target;
}

test('原稿で使える既存の挿入操作を TeX と Markdown ごとに示す', () => {
  assert.deepEqual(editorInsertionItems('notes.tex').map(item => item.action), ['image', 'table']);
  for (const path of ['notes.md', 'notes.MARKDOWN']) assert.deepEqual(editorInsertionItems(path).map(item => item.action), ['image', 'table', 'page', 'link', 'math', 'code']);
  for (const path of ['', 'refs.bib', 'main.py', 'manual.pdf']) assert.deepEqual(editorInsertionItems(path), []);
});

test('ソースの選択範囲内では逆向きの選択も使い，範囲外ではクリック位置へ移す', () => {
  const state = SourceState.create({ doc: '0123456789', selection: EditorSelection.single(8, 3) });
  const inside = targetFor('source', state, 5);
  const selected = prepareEditorContext(inside, { x: 100, y: 80 });
  assert.equal(selected.selection, state.selection); assert.equal(inside.active, 1);
  assert.equal(selected.x, 100); assert.equal(selected.y, 80); assert.equal(editorContextIsCurrent(selected), true);
  for (const position of [3, 8]) assert.equal(prepareEditorContext(targetFor('source', state, position), { x: 0, y: 0 }).selection, state.selection);
  const outside = targetFor('source', state, 1);
  prepareEditorContext(outside, { x: 20, y: 80 });
  assert.equal(outside.view.state.selection.main.anchor, 1); assert.equal(outside.view.state.selection.main.head, 1);
  assert.equal(outside.view.state.doc.toString(), '0123456789');
});

test('複数のソースの選択範囲では，クリックした範囲を挿入先にする', () => {
  const state = SourceState.create({ doc: '0123456789', extensions: [SourceState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([EditorSelection.range(1, 3), EditorSelection.range(8, 6)], 0) });
  const target = targetFor('source', state, 7);
  prepareEditorContext(target, { x: 0, y: 0 });
  assert.equal(target.view.state.selection.main.anchor, 8); assert.equal(target.view.state.selection.main.head, 6);
});

test('直接編集の選択を使い，範囲外の数式ではその数式を選ぶ', () => {
  const doc = parseMarkdown('Before $x$ after');
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 7, 2) });
  const inside = targetFor('rich', state, { pos: 4, inside: 0 });
  assert.equal(prepareEditorContext(inside, { x: 0, y: 0 }).selection, state.selection);
  const outside = targetFor('rich', state, { pos: 14, inside: 0 });
  prepareEditorContext(outside, { x: 0, y: 0 });
  assert.equal(outside.view.state.selection.head, 14); assert.equal(outside.view.state.doc, doc);
  const math = targetFor('rich', state, { pos: 8, inside: 8 });
  prepareEditorContext(math, { x: 0, y: 0 });
  assert.ok(math.view.state.selection instanceof NodeSelection); assert.equal(math.view.state.selection.node.type.name, 'math_inline');
  const selected = math.view.state.selection;
  assert.equal(prepareEditorContext(math, { x: 0, y: 0 }).selection, selected);
});

test('キーボードでは現在の選択と入力位置を使い，メニューをカーソルの下に開く', () => {
  for (const kind of ['source', 'rich']) {
    const state = kind === 'source' ? SourceState.create({ doc: 'Text', selection: { anchor: 1, head: 3 } }) : EditorState.create({ doc: parseMarkdown('Text') });
    const target = targetFor(kind, state, null);
    target.view.posAtCoords = () => { throw new Error('Pointer coordinates should not be read.'); };
    const context = prepareEditorContext(target, { keyboard: true });
    assert.equal(context.selection, state.selection); assert.equal(context.y, 48);
    assert.equal(context.x, (kind === 'source' ? state.selection.main.head : state.selection.head) * 7);
  }
});

test('入力中，読取り専用，座標が本文にない場合は選択を変えず，古い挿入先を使わない', () => {
  const state = SourceState.create({ doc: 'Text' });
  const composing = targetFor('source', state, 2); composing.view.composing = true;
  assert.equal(prepareEditorContext(composing, { x: 0, y: 0 }), null); assert.equal(composing.active, 0);
  const readonly = targetFor('source', SourceState.create({ doc: 'Text', extensions: [SourceState.readOnly.of(true)] }), 1);
  assert.equal(prepareEditorContext(readonly, { x: 0, y: 0 }), null); assert.equal(readonly.active, 0);
  const missing = targetFor('source', state, null);
  assert.equal(prepareEditorContext(missing, { x: 0, y: 0 }), null);
  const target = targetFor('source', state, 2), context = prepareEditorContext(target, { x: 0, y: 0 });
  target.view.dispatch({ selection: { anchor: 3 } }); assert.equal(editorContextIsCurrent(context), false);
  target.view.dispatch({ selection: { anchor: 2 } }); assert.equal(editorContextIsCurrent(context), true);
  target.view.dispatch({ changes: { from: 0, insert: 'New ' } }); assert.equal(editorContextIsCurrent(context), false);
  target.view.state = context.view.state = state; target.current = false; assert.equal(editorContextIsCurrent(context), false);
});
