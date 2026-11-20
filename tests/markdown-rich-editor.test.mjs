import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { ChangeSet, Text, EditorState as SourceState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { MarkdownRichEditor } from '../web/src/markdown-rich-editor.js';
import { MarkdownSource, parseMarkdown } from '../web/src/markdown-rich-document.js';

function editorFor(text) {
  const editor = Object.create(MarkdownRichEditor.prototype);
  Object.assign(editor, { source: new MarkdownSource(text), readOnly: false, destroyed: false, embeddedViews: new Set(), pendingExternal: null,
    host: { scrollTop: 0, scrollLeft: 0, classList: { toggle() {} } }, notifications: [], errors: [], selections: [], states: [] });
  editor.options = { onChange: change => editor.notifications.push(change), onSelectionChange: selection => editor.selections.push(selection), onError: error => editor.errors.push(error), onStateChange: () => editor.states.push(editor.view.state) };
  editor.updateTableTools = () => {};
  editor.view = {
    state: EditorState.create({ doc: editor.source.doc, plugins: editor.plugins() }), composing: false,
    dispatch: transaction => editor.dispatchTransaction(transaction),
    updateState(state) { this.state = state; }, focus() {}, setProps() {}, endOfTextblock: () => false,
  };
  return editor;
}
function selectText(editor, text) {
  const from = editor.text.indexOf(text);
  assert.ok(from >= 0, `Selection text: ${text}`);
  editor.selectSource(from, from + text.length);
}
function typeText(editor, text, { oneInput = false } = {}) {
  for (const part of oneInput ? [text] : text) {
    const { from, to } = editor.view.state.selection;
    const handled = editor.view.state.plugins.some(plugin => plugin.props.handleTextInput?.(editor.view, from, to, part));
    if (!handled) editor.view.dispatch(editor.view.state.tr.insertText(part, from, to));
  }
}
function pressKey(editor, key, keyCode) {
  return editor.view.state.plugins.some(plugin => plugin.props.handleKeyDown?.(editor.view, { key, keyCode, preventDefault() {} }));
}
function nodesOf(editor, type) {
  const result = [];
  editor.view.state.doc.descendants(node => { if (node.type.name === type) result.push(node); });
  return result;
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


test('日本語に続くインライン数式を閉じる区切りで変換し，入力した区切りを書き出す', () => {
  for (const [notation, delimiter, tex] of [['$x$', '$', 'x'], ['$`x_1`$', '$`', 'x_1'], ['\\(x^2\\)', '\\(', 'x^2'], ['$a\\$b$', '$', 'a\\$b']]) {
    const editor = editorFor('日本語の後'); editor.selectSource(3);
    typeText(editor, notation.slice(0, -1));
    assert.equal(nodesOf(editor, 'math_inline').length, 0, notation);
    typeText(editor, notation.slice(-1)); typeText(editor, '続き');
    const [math] = nodesOf(editor, 'math_inline');
    assert.equal(math?.attrs.tex, tex, notation); assert.equal(math.attrs.delimiter, delimiter);
    assert.equal(editor.text, `日本語${notation}続きの後`);
    assert.equal(parseMarkdown(editor.text).eq(editor.view.state.doc), true);
    assertNotifications(editor, '日本語の後');
  }
  const editor = editorFor(''); typeText(editor, '日本語$`x`$続き', { oneInput: true });
  // Input rules run at the caret, so completed syntax followed by text is left
  // for Markdown paste rather than rewriting earlier input.
  assert.equal(nodesOf(editor, 'math_inline').length, 0);
  const committed = editorFor(''); typeText(committed, '日本語$`x`$', { oneInput: true });
  assert.equal(nodesOf(committed, 'math_inline').length, 1);
});

test('日本語に続く太字，斜体，取り消し線，コードと入れ子の装飾を変換する', () => {
  for (const [notation, types, text] of [['**太字**', ['strong'], '太字'], ['*斜体*', ['em'], '斜体'], ['***両方***', ['em', 'strong'], '両方'], ['~~取消~~', ['strike'], '取消'], ['`コード`', ['code'], 'コード']]) {
    const editor = editorFor('日本語の後'); editor.selectSource(3);
    typeText(editor, notation.slice(0, -1));
    assert.equal(editor.view.state.doc.firstChild.childCount, 1, notation);
    typeText(editor, notation.slice(-1)); typeText(editor, '続き');
    const child = editor.view.state.doc.firstChild.child(1);
    assert.equal(child.text, text); assert.deepEqual(child.marks.map(mark => mark.type.name), types);
    assert.equal(editor.text, `日本語${notation}続きの後`);
    assert.equal(parseMarkdown(editor.text).eq(editor.view.state.doc), true);
    assertNotifications(editor, '日本語の後');
  }
  const nested = editorFor(''); typeText(nested, '**太字と*斜体***');
  const children = []; nested.view.state.doc.firstChild.forEach(node => children.push(node));
  assert.deepEqual(children.map(node => node.marks.map(mark => mark.type.name)), [['strong'], ['em', 'strong']]);
  assert.equal(parseMarkdown(nested.text).eq(nested.view.state.doc), true);
  const escaped = editorFor(''); typeText(escaped, '**太字の中の\\*記号**');
  assert.equal(escaped.view.state.doc.firstChild.firstChild.text, '太字の中の*記号');
  assert.equal(escaped.text, '**太字の中の\\*記号**');
  const underscore = editorFor(''); typeText(underscore, ' __太字__');
  assert.equal(underscore.view.state.doc.firstChild.lastChild.marks[0].attrs.markup, '__');
  const word = editorFor('日本語'); word.selectSource(word.text.length); typeText(word, '_そのまま_');
  assert.equal(word.view.state.doc.firstChild.childCount, 1);
  assert.equal(word.view.state.doc.firstChild.firstChild.marks.length, 0);
});

test('エスケープと入力途中の数式を文字のまま編集し，コード内では入力を変換しない', () => {
  for (const text of ['\\$x$', '\\\\(x\\)', '$x\\$', '$$x$', '\\**文字**', '\\*文字*', '$x_1', '$`x`', '\\(x']) {
    const editor = editorFor(''); typeText(editor, text);
    assert.equal(nodesOf(editor, 'math_inline').length, 0, text);
    assert.equal(editor.view.state.doc.firstChild.textContent, text);
    assert.equal(editor.view.state.doc.firstChild.firstChild.marks.length, 0, text);
    assertNotifications(editor, '');
  }
  const code = editorFor(''); typeText(code, '`$x$ **文字** ---`');
  assert.equal(code.view.state.doc.firstChild.firstChild.marks[0].type.name, 'code');
  assert.equal(code.view.state.doc.firstChild.textContent, '$x$ **文字** ---');
  assert.equal(nodesOf(code, 'math_inline').length, 0);
  const marked = editorFor(''); marked.command('inlineCode'); typeText(marked, '$x$ **文字** --- ');
  assert.equal(nodesOf(marked, 'math_inline').length, 0); assert.equal(nodesOf(marked, 'horizontal_rule').length, 0);
  assert.equal(marked.view.state.doc.firstChild.textContent, '$x$ **文字** --- ');
  const block = editorFor('```tex\n\n```'); block.view.dispatch(block.view.state.tr.setSelection(TextSelection.create(block.view.state.doc, 1)));
  typeText(block, '$x$ **文字** ---'); pressKey(block, 'Enter', 13);
  assert.equal(block.view.state.doc.firstChild.type.name, 'code_block');
  assert.equal(block.view.state.doc.firstChild.textContent, '$x$ **文字** ---\n');
  const following = editorFor('`$未完了` の後'); following.selectSource(following.text.length);
  typeText(following, '$x$**太字**');
  assert.equal(nodesOf(following, 'math_inline').length, 1);
  assert.equal(following.view.state.doc.firstChild.lastChild.marks[0].type.name, 'strong');
  const adjacent = editorFor('`code`$x'); adjacent.selectSource(adjacent.text.length); typeText(adjacent, '$');
  assert.equal(nodesOf(adjacent, 'math_inline').length, 1);
  assert.deepEqual(nodesOf(adjacent, 'math_inline')[0].marks, []);
  assert.equal(adjacent.text, '`code`$x$');
});

test('横線を Space または Enter で確定し，続く段落へ入力する', () => {
  for (const [markup, key] of [['---', 'Space'], ['----', 'Enter'], ['***', 'Enter'], ['___', 'Space']]) {
    const editor = editorFor(''); typeText(editor, markup);
    assert.equal(editor.view.state.doc.firstChild.type.name, 'paragraph');
    if (key === 'Enter') assert.equal(pressKey(editor, 'Enter', 13), true); else typeText(editor, ' ');
    assert.equal(editor.view.state.doc.firstChild.type.name, 'horizontal_rule', markup);
    assert.equal(editor.view.state.doc.firstChild.attrs.markup, markup);
    assert.equal(editor.view.state.selection.$from.parent.type.name, 'paragraph');
    typeText(editor, '次の段落');
    assert.equal(editor.text, `${markup}\n\n次の段落`);
    assertNotifications(editor, '');
  }
  for (const text of ['---本文', '\\---', '本文---']) {
    const editor = editorFor(''); typeText(editor, text); pressKey(editor, 'Enter', 13);
    assert.equal(nodesOf(editor, 'horizontal_rule').length, 0, text);
  }
  const list = editorFor('- item'); selectText(list, 'item'); typeText(list, '---'); pressKey(list, 'Enter', 13);
  assert.equal(nodesOf(list, 'horizontal_rule').length, 1); list.view.state.doc.check();
  const quote = editorFor('> text'); selectText(quote, 'text'); typeText(quote, '--- ');
  assert.equal(nodesOf(quote, 'horizontal_rule').length, 1); quote.view.state.doc.check();
  const table = editorFor('| Cell |\n| --- |\n| text |'); selectText(table, 'text'); typeText(table, '--- ');
  assert.equal(nodesOf(table, 'horizontal_rule').length, 0); table.view.state.doc.check();
});

test('入力規則を Backspace で取り消し，原稿の Undo と Redo でも数式の前後へ戻れる', () => {
  for (const [text, enter] of [['日本語$x$', false], ['$`x`$', false], ['**太字**', false], ['--- ', false], ['---', true]]) {
    const editor = editorFor(''); typeText(editor, text); if (enter) pressKey(editor, 'Enter', 13);
    assert.equal(pressKey(editor, 'Backspace', 8), true);
    assert.equal(editor.view.state.doc.firstChild.type.name, 'paragraph');
    assert.equal(editor.view.state.doc.firstChild.textContent, text);
    assert.equal(nodesOf(editor, 'math_inline').length, 0);
    assertNotifications(editor, '');
  }
  const editor = editorFor(''); let source = SourceState.create({ doc: '', extensions: [history()] });
  const applySource = transaction => {
    source = transaction.state; editor.setText(source.doc.toString(), transaction.changes);
    editor.selectSource(source.selection.main.anchor, source.selection.main.head);
  };
  editor.options.onChange = change => {
    assert.equal(change.beforeText, source.doc.toString());
    source = source.update({ changes: change.changes, selection: change.selection, userEvent: change.userEvent,
      annotations: change.userEvent === 'input.format' ? isolateHistory.of('full') : undefined }).state;
  };
  editor.options.onUndo = () => undo({ state: source, dispatch: applySource });
  editor.options.onRedo = () => redo({ state: source, dispatch: applySource });
  typeText(editor, '日本語$x'); const before = editor.text;
  typeText(editor, '$'); assert.equal(editor.text, '日本語$x$');
  const event = { key: 'z', ctrlKey: true, preventDefault() {}, stopPropagation() {} };
  editor.handleShortcut(event); assert.equal(editor.text, before); assert.equal(nodesOf(editor, 'math_inline').length, 0);
  editor.handleShortcut({ ...event, shiftKey: true }); assert.equal(editor.text, '日本語$x$'); assert.equal(nodesOf(editor, 'math_inline').length, 1);
  assert.deepEqual(editor.errors, []);
});

test('IME の確定後に入力規則を適用し，変換の途中では記号列を編集できる', async () => {
  for (const notation of ['日本語$x$', '日本語$`x`$', '日本語**太字**']) {
    const editor = editorFor(''); editor.view.composing = true;
    typeText(editor, notation, { oneInput: true });
    assert.equal(editor.view.state.doc.firstChild.textContent, notation);
    editor.view.composing = false;
    for (const plugin of editor.view.state.plugins) plugin.props.handleDOMEvents?.compositionend?.(editor.view);
    await new Promise(resolve => setTimeout(resolve, 10));
    if (notation.includes('$')) assert.equal(nodesOf(editor, 'math_inline').length, 1);
    else assert.equal(editor.view.state.doc.firstChild.lastChild.marks[0].type.name, 'strong');
    assert.equal(editor.text, notation); assertNotifications(editor, '');
  }
});

test('数式コマンドで既定と指定した区切りを使い，本文の TeX を書き出す', () => {
  for (const [displayMode, delimiter] of [[false, undefined], [false, '$`'], [false, '$'], [false, '\\('], [true, '$$'], [true, '\\['], [true, '```math']]) {
    const editor = editorFor('');
    assert.equal(editor.command('math', { tex: 'x_1 + \\alpha', displayMode, ...(delimiter ? { delimiter } : {}) }), true);
    const math = nodesOf(editor, displayMode ? 'math_block' : 'math_inline')[0];
    assert.equal(math.attrs.delimiter, delimiter || '$`');
    assert.equal(math.attrs.tex, 'x_1 + \\alpha');
    assert.equal(parseMarkdown(editor.text).eq(editor.view.state.doc), true);
    assertNotifications(editor, '');
  }
  const formatted = editorFor(''); formatted.command('bold');
  assert.equal(formatted.command('math', { tex: 'x', displayMode: false }), true);
  assert.equal(nodesOf(formatted, 'math_inline')[0].marks[0].type.name, 'strong');
  assert.equal(formatted.view.state.selection.node.type.name, 'math_inline');
  assert.equal(parseMarkdown(formatted.text).eq(formatted.view.state.doc), true);
  for (const previous of ['前$x$後', '$$x$$']) {
    const existing = editorFor(previous);
    const position = previous.startsWith('前') ? 2 : 0;
    existing.view.dispatch(existing.view.state.tr.setSelection(NodeSelection.create(existing.view.state.doc, position)));
    existing.command('math', { tex: 'y^2', displayMode: false, delimiter: '\\(' });
    assert.equal(nodesOf(existing, 'math_inline').length, 1); assert.equal(nodesOf(existing, 'math_block').length, 0);
    assert.equal(existing.text, previous.startsWith('前') ? '前\\(y^2\\)後' : '\\(y^2\\)');
    assert.equal(parseMarkdown(existing.text).eq(existing.view.state.doc), true);
  }
  const editor = editorFor(''); assert.throws(() => editor.command('math', { displayMode: false, delimiter: '$$' }), /math-delimiter/);
  assert.equal(editor.text, '');
});

test('ツールバーへ storedMarks，選択，本文，外部の更新と読取り専用の状態を通知する', () => {
  const editor = editorFor('Text');
  editor.command('bold');
  assert.equal(editor.states.length, 1); assert.equal(editor.states.at(-1), editor.view.state);
  assert.equal(editor.states.at(-1).storedMarks[0].type.name, 'strong');
  assert.deepEqual(editor.notifications, []); assert.deepEqual(editor.selections, []);
  editor.command('bold'); assert.equal(editor.states.at(-1).storedMarks.length, 0);
  editor.selectSource(2); assert.equal(editor.states.at(-1).selection.head, 3);
  typeText(editor, '新'); assert.equal(editor.states.at(-1), editor.view.state);
  const changes = editor.notifications.length, selections = editor.selections.length, count = editor.states.length;
  editor.setText('**External**'); assert.equal(editor.states.length, count + 1);
  editor.selectSource(4); assert.equal(editor.states.length, count + 2);
  editor.setReadOnly(true); assert.equal(editor.states.length, count + 3);
  assert.equal(editor.notifications.length, changes); assert.equal(editor.selections.length, selections);
  assert.deepEqual(editor.errors, []);
});


test('数字に接するドル記号の式も，入力した区切りと TeX のまま往復する', () => {
  for (const notation of ['$x$', '$\\text{a *b* c}$']) {
    const editor = editorFor('34'); editor.selectSource(1); typeText(editor, notation);
    assert.equal(editor.text, `3${notation}4`);
    assert.equal(nodesOf(editor, 'math_inline').length, 1);
    assert.equal(parseMarkdown(editor.text).eq(editor.view.state.doc), true);
    assertNotifications(editor, '34');
  }
  const editor = editorFor('34'); editor.selectSource(1);
  assert.equal(editor.command('math', { tex: 'x', displayMode: false, delimiter: '$' }), true);
  assert.equal(editor.text, '3$x$4'); assert.equal(parseMarkdown(editor.text).eq(editor.view.state.doc), true);
});

test('表のセルに独立した数式を入れず，コードの書式からも行内数式を挿入できる', () => {
  const original = '| A | B |\n| --- | --- |\n| one | two |';
  const table = editorFor(original); selectText(table, 'one');
  const before = table.view.state;
  assert.equal(table.command('math', { tex: 'x', displayMode: true }), false);
  assert.equal(table.view.state, before); assert.equal(table.text, original); assert.deepEqual(table.notifications, []);
  assert.equal(table.command('math', { tex: 'x', displayMode: false, delimiter: '$' }), true);
  assert.equal(nodesOf(table, 'table').length, 1); assert.equal(nodesOf(table, 'math_inline').length, 1);
  assert.equal(parseMarkdown(table.text).eq(table.view.state.doc), true);
  const code = editorFor(''); code.command('inlineCode');
  assert.equal(code.command('math', { tex: 'x', displayMode: false }), true);
  assert.deepEqual(nodesOf(code, 'math_inline')[0].marks, []);
  assert.equal(parseMarkdown(code.text).eq(code.view.state.doc), true);
});
