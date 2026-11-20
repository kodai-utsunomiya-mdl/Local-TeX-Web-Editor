import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from 'prosemirror-state';
import { markdownSchema, MarkdownSource, parseMarkdown, serializeMarkdown } from '../web/src/markdown-rich-document.js';

function replaceText(doc, before, after, occurrence = 0) {
  let position;
  doc.descendants((node, offset) => {
    if (!node.isText || position !== undefined) return;
    const start = node.text.indexOf(before);
    if (start >= 0 && occurrence-- === 0) position = offset + start;
  });
  assert.notEqual(position, undefined, `Text was found: ${before}`);
  return EditorState.create({ doc }).tr.insertText(after, position, position + before.length).doc;
}

function nodePositions(doc, name) {
  const nodes = [];
  doc.descendants((node, position) => { if (node.type.name === name) nodes.push({ node, position }); });
  return nodes;
}

function applyChanges(text, changes) {
  for (const change of changes.toReversed()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return text;
}

function docWith(nodes) { return markdownSchema.nodes.doc.create(null, nodes); }
function paragraph(text) { return markdownSchema.nodes.paragraph.create(null, text ? markdownSchema.text(text) : null); }

test('直接編集の文書を開いても，空白，改行，Markdown の原文は変わらない', () => {
  const text = [
    '', '# 研究ノート  #', '', '本文の __強調__ と _斜体_，~~取消線~~，`コード`．',
    '次の行で $`x^2`$ と \\(a+b\\) を使う．  ', '改行の後の本文．', '',
    '+ [X] 完了した項目', '+ [ ] 次の項目', '  + 子の項目', '',
    '| 名前 | 値 |', '| :----- | -----: |', '| 結果 | $x$ |', '',
    '~~~tex', '\\textbf{本文}', '~~~', '', '![図](figures/figure%201.png "図の説明")', '',
    '[参考文献][paper]', '', '[paper]: https://example.org/paper', '  "タイトル"', '', '',
  ].join('\r\n');
  const source = new MarkdownSource(text);
  source.doc.check();
  assert.equal(nodePositions(source.doc, 'table').length, 1);
  assert.equal(nodePositions(source.doc, 'raw_block')[0].node.attrs.kind, 'reference');
  assert.equal(source.text, text);
  assert.deepEqual(source.update(source.doc), { text, changes: [], doc: source.doc });
  const equivalent = markdownSchema.nodeFromJSON(source.doc.toJSON());
  assert.deepEqual(source.update(equivalent), { text, changes: [], doc: equivalent });
});

test('本文を編集すると，そのブロックだけを書き換え，他の記法と参照定義が残る', () => {
  const text = '見出し\n=======\n\n最初の本文．\n\n\n後の __本文__ [参考][ref]．\n\n[ref]: ../reference.md "資料"\n\n';
  const source = new MarkdownSource(text);
  const result = source.update(replaceText(source.doc, '最初', '変更後'));
  assert.equal(result.text, text.replace('最初', '変更後'));
  assert.deepEqual(result.changes, [{ from: text.indexOf('最初'), to: text.indexOf('最初') + 2, insert: '変更後' }]);
  assert.equal(applyChanges(text, result.changes), result.text);
  const link = nodePositions(source.doc, 'paragraph').at(-1).node.content.content.find(node => node.marks.some(mark => mark.type.name === 'link'));
  assert.equal(link.marks.find(mark => mark.type.name === 'link').attrs.href, '../reference.md');
});

test('離れた二つの段落を変更すると，間の原文をそのまま使って複数の変更を返す', () => {
  const text = '一つ目．\n\n**元の記法** と [参照][r]．\n\n三つ目．\n\n[r]: /reference\n';
  const source = new MarkdownSource(text);
  let doc = replaceText(source.doc, '一つ目', '先頭');
  doc = replaceText(doc, '三つ目', '末尾');
  const result = source.update(doc);
  assert.equal(result.text, text.replace('一つ目', '先頭').replace('三つ目', '末尾'));
  assert.equal(result.changes.length, 2);
  assert.equal(applyChanges(text, result.changes), result.text);
});

test('同じ内容の段落が並んでいても，編集した位置に変更を反映する', () => {
  const text = '同じ本文．\n\n同じ本文．\n\n同じ本文．\n';
  const source = new MarkdownSource(text);
  const result = source.update(replaceText(source.doc, '同じ', '中央の', 1));
  assert.equal(result.text, '同じ本文．\n\n中央の本文．\n\n同じ本文．\n');
  assert.deepEqual(result.changes, [{ from: 7, to: 9, insert: '中央の' }]);
  assert.equal(applyChanges(text, result.changes), result.text);
});

test('段落の挿入，削除，並び替えの後も，本文と変更範囲が一致する', () => {
  const source = new MarkdownSource('最初の __段落__．\n\n二つ目．\n\n最後．\n');
  const first = source.doc.child(0);
  const second = source.doc.child(1);
  const last = source.doc.child(2);
  const inserted = paragraph('追加．');
  for (const next of [docWith([first, inserted, second, last]), docWith([first, inserted, last]), docWith([last, first, inserted])]) {
    const before = source.text;
    const result = source.update(next);
    assert.equal(applyChanges(before, result.changes), result.text);
    assert.deepEqual(parseMarkdown(result.text).toJSON(), next.toJSON());
    assert.match(result.text, /最初の __段落__．/);
  }
  assert.equal(source.text, '最後．\n\n最初の __段落__．\n\n追加．\n');
});

test('見出しを段落に変えると，隣の段落との間に空行が入る', () => {
  const source = new MarkdownSource('# 見出し\n本文．\n');
  const result = source.update(docWith([paragraph('見出し'), source.doc.lastChild]));
  assert.equal(result.text, '見出し\n\n本文．\n');
  assert.equal(parseMarkdown(result.text).childCount, 2);
});

test('空の文書，空白だけの文書，改行のない文書を編集できる', () => {
  for (const original of ['', '  \n\n', '\r\n', '\n\n']) {
    const source = new MarkdownSource(original);
    assert.equal(source.doc.firstChild.type.name, 'paragraph');
    assert.deepEqual(source.update(source.doc), { text: original, changes: [], doc: source.doc });
    const result = source.update(docWith([paragraph('本文')]));
    assert.equal(result.text, `${original}本文`);
    assert.equal(applyChanges(original, result.changes), result.text);
  }
  const source = new MarkdownSource('本文');
  assert.equal(source.update(docWith([paragraph('新しい本文')])).text, '新しい本文');
});

test('CRLF の文書で編集したブロックにも CRLF を使う', () => {
  const text = '# 見出し\r\n\r\n本文．\r\n\r\n最後．\r\n';
  const source = new MarkdownSource(text);
  const result = source.update(replaceText(source.doc, '本文', '新しい本文'));
  assert.equal(result.text, text.replace('本文', '新しい本文'));
  assert.doesNotMatch(result.text, /(?<!\r)\n/);
});

test('数式の各区切りと式番号を読み，編集した式を書き出す', () => {
  const cases = [
    ['前 $x$ 後', 'math_inline', '$', 'x', false, ''],
    ['前 $`x`$ 後', 'math_inline', '$`', 'x', false, ''],
    ['前 \\(x\\) 後', 'math_inline', '\\(', 'x', false, ''],
    ['前 $$x$$ 後', 'math_inline', '$$', 'x', true, ''],
    ['$$\nx\n$$', 'math_block', '$$', '\nx\n', true, ''],
    ['$$x$$ (A.1)', 'math_block', '$$', 'x', true, 'A.1'],
    ['\\[x\\] (B)', 'math_block', '\\[', 'x', true, 'B'],
    ['```math\nx\n```', 'math_block', '```math', 'x', true, ''],
  ];
  for (const [text, name, delimiter, tex, displayMode, equationNumber] of cases) {
    const source = new MarkdownSource(text);
    const { node, position } = nodePositions(source.doc, name)[0];
    assert.deepEqual({ ...node.attrs }, { tex, delimiter, displayMode, equationNumber }, text);
    const changed = EditorState.create({ doc: source.doc }).tr.setNodeMarkup(position, null, { ...node.attrs, tex: node.attrs.tex.replace('x', 'y^2') }).doc;
    const result = source.update(changed);
    assert.equal(result.text, text.replace('x', 'y^2'), text);
    assert.deepEqual(parseMarkdown(result.text).toJSON(), changed.toJSON(), text);
  }
});

test('表の配置，コード内の縦線，数式内の縦線を往復できる', () => {
  const text = String.raw`| 名前 | コード | 数式 |
| :--- | :---: | ---: |
| 本文 | \`a\|b\` | $\\|x\\|$ |`.replaceAll('\\`', '`');
  const doc = parseMarkdown(text);
  const table = doc.firstChild;
  assert.equal(table.type.name, 'table');
  assert.deepEqual(table.firstChild.content.content.map(cell => cell.attrs.align), ['left', 'center', 'right']);
  assert.equal(table.child(1).child(1).textContent, 'a|b');
  assert.equal(nodePositions(doc, 'math_inline')[0].node.attrs.tex, '\\|x\\|');
  assert.deepEqual(parseMarkdown(serializeMarkdown(doc)).toJSON(), doc.toJSON());
  const source = new MarkdownSource(`${text}\n\n後の _本文_．\n`);
  const result = source.update(replaceText(source.doc, '本文', '変更後'));
  assert.match(result.text, /後の _本文_．\n$/);
  assert.deepEqual(parseMarkdown(result.text).toJSON(), source.doc.toJSON());
});

test('タスクの状態と番号付きリストの開始番号，入れ子を往復できる', () => {
  const text = '3) [x] 完了した項目\n4) [ ] 次の項目\n   - 子の項目\n\n後の本文．\n';
  const source = new MarkdownSource(text);
  assert.equal(source.doc.firstChild.attrs.order, 3);
  assert.equal(source.doc.firstChild.attrs.delimiter, ')');
  const items = nodePositions(source.doc, 'list_item');
  assert.deepEqual(items.map(({ node }) => node.attrs.checked), [true, false, null]);
  const { node, position } = items[1];
  const changed = EditorState.create({ doc: source.doc }).tr.setNodeMarkup(position, null, { ...node.attrs, checked: true }).doc;
  const result = source.update(changed);
  assert.match(result.text, /4\) \[x\] 次の項目/);
  assert.deepEqual(parseMarkdown(result.text).toJSON(), changed.toJSON());
});

test('コードに区切り文字が含まれるときは，外側の区切りを長くする', () => {
  const source = new MarkdownSource('```js\nconst value = 1;\n```\n\n本文．\n');
  const code = source.doc.firstChild;
  const changedCode = code.copy(markdownSchema.text('const value = "`````";'));
  const result = source.update(docWith([changedCode, source.doc.lastChild]));
  assert.match(result.text, /^``````js\n/);
  const parsed = parseMarkdown(result.text).firstChild;
  assert.equal(parsed.type.name, 'code_block');
  assert.equal(parsed.textContent, 'const value = "`````";');
  assert.equal(parsed.attrs.params, 'js');
});

test('画像，リンク，取消線，コード，改行を往復できる', () => {
  const text = '![図の説明](figures/a%20b.png "画像") と [リンク](../a.md#part "節") と ~~古い本文~~ と `x_y`．  \n次の行．';
  const doc = parseMarkdown(text);
  assert.deepEqual({ ...nodePositions(doc, 'image')[0].node.attrs }, { src: 'figures/a%20b.png', alt: '図の説明', title: '画像' });
  assert.deepEqual(parseMarkdown(serializeMarkdown(doc)).toJSON(), doc.toJSON());
});

test('引用やリストに含まれる参照定義も Markdown として編集できる', () => {
  for (const block of ['> [ref]: /reference\n> 引用の本文', '- [ref]: /reference\n  項目の本文']) {
    const source = new MarkdownSource(`${block}\n\n[参考][ref]\n`);
    assert.equal(source.doc.firstChild.type.name, 'raw_block');
    const result = source.update(replaceText(source.doc, '本文', '新しい本文'));
    assert.equal(result.text, `${block.replace('本文', '新しい本文')}\n\n[参考][ref]\n`);
    assert.match(result.text, /\[ref\]: \/reference/);
  }
});

test('入力途中の記法を開き，別の段落を編集しても原文が残る', () => {
  for (const fragment of ['式 $\\frac{1}{', '[途中](../', '**強調の途中', '```tex\n\\section{']) {
    const text = `先頭．\n\n${fragment}`;
    const source = new MarkdownSource(text);
    assert.deepEqual(source.update(source.doc), { text, changes: [], doc: source.doc });
    assert.equal(source.update(replaceText(source.doc, '先頭', '変更後')).text, text.replace('先頭', '変更後'));
  }
});

test('見出し，強調，表，数式の前後で本文と原稿のカーソル位置を対応させる', () => {
  const text = '# 見出し\n\n本文の **強調** と $`x`$ の後．\n\n| 名前 | 値 |\n| --- | --- |\n| 結果 | 3 |\n';
  const source = new MarkdownSource(text);
  for (const word of ['見出し', '本文', '強調', 'の後', '名前', '結果']) {
    const offset = text.indexOf(word);
    let expected;
    source.doc.descendants((node, position) => { if (node.isText && node.text.includes(word)) expected = position + node.text.indexOf(word); });
    assert.equal(source.positionAtSource(offset), expected, word);
    assert.equal(source.sourceOffsetAt(expected), offset, word);
    assert.equal(source.sourceOffsetAt(expected + 1), offset + 1, word);
  }
  const math = nodePositions(source.doc, 'math_inline')[0];
  assert.equal(source.sourceOffsetAt(math.position), text.indexOf('$`'));
  assert.equal(source.sourceOffsetAt(math.position + 1), text.indexOf(' の後'));
  const result = source.update(replaceText(source.doc, '見出し', '新しい見出し'));
  const offset = result.text.indexOf('結果');
  assert.equal(source.sourceOffsetAt(source.positionAtSource(offset)), offset);
});

test('参照定義を編集すると，表示中のリンクと画像の参照先も変わる', () => {
  const text = '[資料][ref]\n\n![図][image]\n\n[ref]: /old "以前の資料"\n[image]: figures/old.png\n';
  const source = new MarkdownSource(text);
  let changed = replaceText(source.doc, '/old "以前の資料"', '/new "新しい資料"');
  changed = replaceText(changed, 'figures/old.png', 'figures/new.png');
  const result = source.update(changed);
  assert.equal(result.doc, source.doc);
  assert.equal(source.doc.firstChild.firstChild.marks[0].attrs.href, '/new');
  assert.equal(source.doc.firstChild.firstChild.marks[0].attrs.title, '新しい資料');
  assert.equal(source.doc.child(1).firstChild.attrs.src, 'figures/new.png');
  assert.equal(result.text, text.replace('/old "以前の資料"', '/new "新しい資料"').replace('figures/old.png', 'figures/new.png'));
  assert.equal(applyChanges(text, result.changes), result.text);
  assert.equal(source.doc.lastChild.type.name, 'raw_block');
  assert.equal(result.mapPosition(2), 2);
});

test('参照定義の追加と削除で表示の長さが変わっても，入力位置を対応させる', () => {
  const source = new MarkdownSource('[資料][later]\n\n[old]: /old\n');
  const changed = replaceText(source.doc, '/old', '/old\n[later]: /new');
  const raw = nodePositions(changed, 'raw_block')[0];
  const caret = raw.position + raw.node.nodeSize - 1;
  const result = source.update(changed);
  assert.equal(source.doc.firstChild.textContent, '資料');
  assert.equal(source.doc.firstChild.firstChild.marks[0].attrs.href, '/new');
  const updatedRaw = nodePositions(source.doc, 'raw_block')[0];
  assert.equal(result.mapPosition(caret), updatedRaw.position + updatedRaw.node.nodeSize - 1);
  assert.equal(source.sourceOffsetAt(result.mapPosition(caret)), result.text.length - 1);
  const removed = source.update(replaceText(source.doc, '[later]: /new', ''));
  assert.equal(removed.doc.firstChild.textContent, '[資料][later]');
  assert.equal(removed.doc.firstChild.firstChild.marks.length, 0);
  assert.equal(removed.doc.lastChild.type.name, 'raw_block');
});

test('引用内の表とコードを編集しても，引用の各行に記号が付く', () => {
  for (const text of [
    '> | 名前 | 値 |\n> | --- | --- |\n> | 本文 | 3 |\n',
    '> ```js\n> const 本文 = 3;\n> ```\n',
  ]) {
    const source = new MarkdownSource(text);
    const result = source.update(replaceText(source.doc, '本文', '変更後'));
    for (const line of result.text.trimEnd().split('\n')) assert.match(line, /^>/);
    assert.deepEqual(parseMarkdown(result.text).toJSON(), source.doc.toJSON());
  }
});

test('空のタスクも Markdown として往復できる', () => {
  const doc = parseMarkdown('- [ ]\n- [x]\n');
  assert.deepEqual(nodePositions(doc, 'list_item').map(({ node }) => node.attrs.checked), [false, true]);
  assert.deepEqual(parseMarkdown(serializeMarkdown(doc)).toJSON(), doc.toJSON());
});

test('下線で記した強調の前後に文字を入力しても，強調が残る', () => {
  for (const [original, name] of [['_word_', 'em'], ['__word__', 'strong']]) {
    const source = new MarkdownSource(`${original}\n`);
    const changed = EditorState.create({ doc: source.doc }).tr.insert(1, markdownSchema.text('prefix')).doc;
    const result = source.update(changed);
    const parsed = parseMarkdown(result.text).firstChild;
    assert.equal(parsed.textContent, 'prefixword');
    assert.equal(parsed.lastChild.text, 'word');
    assert.equal(parsed.lastChild.marks[0].type.name, name);
  }
});

test('見出しで始まるリストを元の Markdown として編集できる', () => {
  const text = '- # 見出し\n  本文．\n\n後の本文．\n';
  const source = new MarkdownSource(text);
  assert.equal(source.doc.firstChild.type.name, 'raw_block');
  const result = source.update(replaceText(source.doc, '見出し', '新しい見出し'));
  assert.equal(result.text, text.replace('見出し', '新しい見出し'));
  assert.deepEqual(parseMarkdown(result.text).toJSON(), source.doc.toJSON());
});

test('数式の本文を空にしても，空の式として Markdown に書き出す', () => {
  for (const name of ['math_inline', 'math_block']) {
    const math = markdownSchema.nodes[name].create();
    const doc = docWith([name === 'math_inline' ? markdownSchema.nodes.paragraph.create(null, math) : math]);
    const parsed = parseMarkdown(serializeMarkdown(doc));
    assert.equal(nodePositions(parsed, name)[0].node.attrs.tex, '{}');
  }
});
