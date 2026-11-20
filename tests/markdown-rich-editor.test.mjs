import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { ChangeSet, Text } from '@codemirror/state';
import { MarkdownRichEditor } from '../web/src/markdown-rich-editor.js';
import { MarkdownSource, parseMarkdown } from '../web/src/markdown-rich-document.js';

function editorFor(text) {
  const editor = Object.create(MarkdownRichEditor.prototype);
  Object.assign(editor, { source: new MarkdownSource(text), readOnly: false, destroyed: false, embeddedViews: new Set(), pendingExternal: null,
    host: { scrollTop: 0, scrollLeft: 0 }, notifications: [], errors: [], selections: [] });
  editor.options = { onChange: change => editor.notifications.push(change), onSelectionChange: selection => editor.selections.push(selection), onError: error => editor.errors.push(error) };
  editor.updateTableTools = () => {};
  editor.view = {
    state: EditorState.create({ doc: editor.source.doc, plugins: editor.plugins() }), composing: false,
    dispatch: transaction => editor.dispatchTransaction(transaction),
    updateState(state) { this.state = state; }, focus() {},
  };
  return editor;
}
function selectText(editor, text) {
  const from = editor.text.indexOf(text);
  assert.ok(from >= 0, `Selection text: ${text}`);
  editor.selectSource(from, from + text.length);
}
function assertNotifications(editor, original) {
  let content = original;
  for (const change of editor.notifications) {
    assert.equal(change.beforeText, content);
    content = ChangeSet.of(change.changes, content.length).apply(Text.of(content.split('\n'))).toString();
    assert.equal(content, change.text);
    assert.ok(change.selection.anchor >= 0 && change.selection.head <= content.length);
  }
  assert.equal(content, editor.text);
  assert.deepEqual(editor.errors, []);
}

test('装飾の変更を原稿の変更として返し，他のブロックの記法をそのまま使う', () => {
  const original = '#  Title\n\nThis is a sentence.\n\n~~~txt\nunchanged\n~~~\n';
  const editor = editorFor(original);
  selectText(editor, 'sentence');
  assert.equal(editor.command('bold'), true);
  assert.ok(editor.text.includes('**sentence**'));
  assert.ok(editor.text.startsWith('#  Title\n'));
  assert.ok(editor.text.endsWith('~~~txt\nunchanged\n~~~\n'));
  selectText(editor, 'sentence'); editor.command('italic');
  assert.equal(editor.notifications[0].userEvent, 'input.format');
  assertNotifications(editor, original);
});

test('リンクとコードを挿入し，URL と言語の不正な値を処理する', () => {
  const editor = editorFor('Text\n'); selectText(editor, 'Text');
  editor.command('link', { label: 'Paper', url: 'notes/the paper.md' });
  assert.ok(editor.text.includes('[Paper](notes/the%20paper.md)'));
  assert.throws(() => editor.command('link', { url: 'javascript:alert(1)' }), /link-url/);
  assert.throws(() => editor.command('link', { url: '\n' }), /link-url/);
  assert.throws(() => editor.command('codeBlock', { language: 'js\nhtml' }), /code-language/);
  assert.throws(() => editor.command('codeBlock', { language: 'x`' }), /code-language/);
  editor.command('codeBlock', { language: 'python', code: 'print("hello")\n```' });
  assert.ok(editor.text.includes('````python\nprint("hello")\n```\n````'));
  assertNotifications(editor, 'Text\n');
});

test('表の先頭の行を追加・削除しても，先頭だけが見出しのセルになる', () => {
  const original = '| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n';
  const editor = editorFor(original);
  selectText(editor, 'A'); editor.command('addRowBefore');
  let table = editor.view.state.doc.firstChild;
  assert.equal(table.childCount, 4);
  for (let index = 0; index < table.childCount; index++) table.child(index).forEach(cell => assert.equal(cell.type.name, index === 0 ? 'table_header' : 'table_cell'));
  editor.view.updateState(editor.view.state.apply(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 4))));
  editor.command('deleteRow'); table = editor.view.state.doc.firstChild;
  assert.equal(table.childCount, 3);
  assert.equal(table.firstChild.firstChild.textContent, 'A');
  for (let index = 0; index < table.childCount; index++) table.child(index).forEach(cell => assert.equal(cell.type.name, index === 0 ? 'table_header' : 'table_cell'));
  assert.equal(parseMarkdown(editor.text).firstChild.eq(table), true);
  selectText(editor, 'one'); editor.command('addColumnAfter');
  assert.equal(editor.view.state.doc.firstChild.firstChild.childCount, 3);
  editor.command('deleteColumn');
  assert.equal(editor.view.state.doc.firstChild.firstChild.childCount, 2);
  assertNotifications(editor, original);
});

test('タスクリストを作り，Enter で未完了の次の項目へ進む', () => {
  const original = 'First\n';
  const editor = editorFor(original); selectText(editor, 'First'); editor.command('task');
  assert.equal(editor.view.state.doc.firstChild.firstChild.attrs.checked, false);
  const state = editor.view.state;
  editor.view.dispatch(state.tr.setNodeMarkup(1, undefined, { checked: true }));
  editor.selectSource(editor.text.indexOf('First') + 5);
  let handled = false;
  const view = { state: editor.view.state, dispatch: editor.view.dispatch, endOfTextblock: () => false };
  for (const plugin of view.state.plugins) if (plugin.props.handleKeyDown?.(view, { key: 'Enter', keyCode: 13, preventDefault() {} })) { handled = true; break; }
  assert.equal(handled, true);
  const list = editor.view.state.doc.firstChild;
  assert.equal(list.childCount, 2); assert.equal(list.firstChild.attrs.checked, true); assert.equal(list.lastChild.attrs.checked, false);
  assertNotifications(editor, original);
});

test('外部の本文と選択の更新では通知せず，同じ本文では状態を作り直さない', () => {
  const editor = editorFor('Hello\n'); const originalState = editor.view.state;
  assert.equal(editor.setText('Hello\n'), false); assert.equal(editor.view.state, originalState);
  editor.selectSource(2);
  editor.setText('Start Hello\n', ChangeSet.of({ from: 0, insert: 'Start ' }, 6));
  assert.equal(editor.sourceSelection().head, 8);
  assert.deepEqual(editor.notifications, []); assert.deepEqual(editor.selections, []); assert.deepEqual(editor.errors, []);
});

test('IME の入力中に別の画面から変更が来ても，双方の変更を本文へ反映する', () => {
  const editor = editorFor('alpha\n\nbeta\n');
  editor.selectSource(5); editor.view.composing = true;
  const remoteText = 'alpha\n\nnew beta\n';
  editor.setText(remoteText, ChangeSet.of({ from: 7, insert: 'new ' }, 12));
  assert.equal(editor.source.text, 'alpha\n\nbeta\n');
  editor.view.dispatch(editor.view.state.tr.insertText('日本語'));
  assert.equal(editor.text, 'alpha日本語\n\nnew beta\n');
  assert.equal(editor.notifications.at(-1).beforeText, remoteText);
  assert.equal(editor.notifications.at(-1).selection.head, 8);
  assert.deepEqual(editor.errors, []);
});

test('参照定義を編集すると，本文のリンク先と入力位置にも反映する', () => {
  const original = '[label][ref]\n\n[ref]: first.md\n';
  const editor = editorFor(original);
  selectText(editor, 'first.md'); editor.view.dispatch(editor.view.state.tr.insertText('second.md'));
  assert.equal(editor.view.state.doc.firstChild.firstChild.marks.find(mark => mark.type.name === 'link').attrs.href, 'second.md');
  selectText(editor, '[ref]: second.md'); editor.view.dispatch(editor.view.state.tr.insertText(''));
  assert.equal(editor.view.state.doc.firstChild.textContent, '[label][ref]');
  assert.ok(editor.sourceSelection().head <= editor.text.length);
  assertNotifications(editor, original);
});

test('上書きした画像を再取得し，同じ画像の複数の表示で取得を共有する', async () => {
  const editor = editorFor('');
  const requests = [], revoked = [];
  let nextURL = 0;
  Object.assign(editor, { path: 'notes/main.md', projectRoot: '/project', token: 'token', assets: new Map(), imageViews: new Set(),
    window: { fetch: async url => { requests.push(url); return { ok: true, blob: async () => ({ type: 'image/png' }) }; },
      URL: { createObjectURL: () => `blob:${++nextURL}`, revokeObjectURL: url => revoked.push(url) } } });
  function addImage(src, path) {
    const image = { node: { attrs: { src } }, asset: editor.acquireImage(path), refreshSource({ force }) {
      assert.equal(force, true);
      editor.releaseImage(this.asset); this.asset = editor.acquireImage(path);
    } };
    editor.imageViews.add(image); return image;
  }
  const first = addImage('../images/figure.png', 'images/figure.png');
  const second = addImage('../images/figure.png', 'images/figure.png');
  const other = addImage('../images/other.png', 'images/other.png');
  await Promise.all([first.asset.promise, second.asset.promise, other.asset.promise]);
  const previous = first.asset, otherAsset = other.asset;
  assert.equal(requests.length, 2); assert.equal(first.asset, second.asset);
  assert.equal(editor.refreshImages('images/missing.png'), false);
  assert.equal(editor.refreshImages('images/figure.png'), true);
  await first.asset.promise;
  assert.equal(requests.length, 3); assert.notEqual(first.asset, previous);
  assert.equal(first.asset, second.asset); assert.equal(first.asset.references, 2);
  assert.equal(editor.assets.get(first.asset.key), first.asset);
  assert.equal(other.asset, otherAsset);
  assert.equal(previous.references, 0); assert.equal(previous.controller.signal.aborted, true);
  assert.ok(revoked.includes(previous.url)); assert.equal(revoked.length, 1);
  assert.equal(revoked.includes(otherAsset.url), false);
  assert.equal(editor.refreshImages('IMAGES/FIGURE.PNG'), false);
  assert.equal(editor.refreshImages('IMAGES/FIGURE.PNG', { caseInsensitive: true }), true);
  await first.asset.promise;
  assert.equal(requests.length, 4); assert.equal(first.asset, second.asset); assert.equal(other.asset, otherAsset);
  assert.equal(revoked.includes(otherAsset.url), false);
  assert.deepEqual(editor.notifications, []); assert.deepEqual(editor.errors, []);
});
