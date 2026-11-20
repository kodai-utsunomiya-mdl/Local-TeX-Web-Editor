import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { renderMarkdownHTML } from '../web/src/markdown-preview.js';
import { markdownSchema, MarkdownSource, parseMarkdown, serializeMarkdown } from '../web/src/markdown-rich-document.js';

test('日本語に接した斜体と取り消し線，括弧と句読点，入れ子の装飾を HTML にする', () => {
  for (const [source, expected] of [
    ['前*斜体*後', '前<em>斜体</em>後'],
    ['前~~取消線~~後', '前<s>取消線</s>後'],
    ['前*「斜体」*後', '前<em>「斜体」</em>後'],
    ['前~~「取消線」~~後', '前<s>「取消線」</s>後'],
    ['前*斜体。*後', '前<em>斜体。</em>後'],
    ['前~~取消線。~~後', '前<s>取消線。</s>後'],
    ['前*~~両方~~*後', '前<em><s>両方</s></em>後'],
    ['前~~**両方**~~後', '前<s><strong>両方</strong></s>後'],
    ['前***~~全部~~***後', '前<em><strong><s>全部</s></strong></em>後'],
    ['前~~***全部***~~後', '前<s><em><strong>全部</strong></em></s>後'],
    ['前***~~`コード`~~***後', '前<em><strong><s><code>コード</code></s></strong></em>後'],
  ]) {
    assert.equal(renderMarkdownHTML(source), `<p data-source-line="1" data-source-end-line="2">${expected}</p>\n`, source);
  }
});

test('日本語の周囲に文字や句読点があっても，保存した Markdown から同じ装飾を読み込む', () => {
  const { nodes, marks } = markdownSchema;
  const combinations = [['em'], ['strong'], ['strike'], ['em', 'strong'], ['em', 'strike'], ['strong', 'strike'], ['em', 'strong', 'strike']];
  for (const selected of ['本文', '「本文」', '本文。', '本文！', '本文 (説明)']) {
    for (const [before, after] of [['前', '後'], ['「', '」'], ['前，', '．後'], ['', '']]) {
      for (const names of combinations) {
        const content = [
          ...(before ? [markdownSchema.text(before)] : []),
          markdownSchema.text(selected, names.map(name => marks[name].create())),
          ...(after ? [markdownSchema.text(after)] : []),
        ];
        const doc = nodes.doc.create(null, nodes.paragraph.create(null, content));
        const markdown = serializeMarkdown(doc);
        assert.deepEqual(parseMarkdown(markdown).toJSON(), doc.toJSON(), markdown);
        const html = renderMarkdownHTML(markdown);
        for (const name of names) assert.ok(html.includes(`<${{ em: 'em', strong: 'strong', strike: 's' }[name]}>`), markdown);
      }
    }
  }
});

test('日本語の装飾がある文書を開いても，元の記法と改行はそのまま残る', () => {
  const original = '#  日本語の原稿\r\n\r\n前~~***「本文。」***~~後\r\n\r\n前*斜体。*後\r\n';
  const source = new MarkdownSource(original);
  assert.equal(source.text, original);
  const result = source.update(source.doc);
  assert.equal(result.text, original);
  assert.deepEqual(result.changes, []);
});

test('エスケープした記号とコードの例を文字として表示し，数式の記法も続けて使える', () => {
  const literal = renderMarkdownHTML('前\\*斜体\\*後\n\n前\\~\\~取消線\\~\\~後\n\n`*斜体* ~~取消線~~`\n\n```markdown\n前***~~本文~~***後\n```');
  assert.doesNotMatch(literal, /<(?:em|strong|s)>/);
  assert.match(literal, /<code>\*斜体\* ~~取消線~~<\/code>/);
  const math = renderMarkdownHTML('前$`x*y`$後\n\n前*斜体*と$`x+y`$後');
  assert.equal((math.match(/class="katex"/g) || []).length, 2);
  assert.match(math, /前<em>斜体<\/em>と/);
});

test('英語の単語内の下線や句読点では，既存の Markdown の解釈が続く', () => {
  const standard = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  for (const content of ['a_word_here', 'a__word__here', 'a**"word"**b', 'a~~**word**~~b', '*one **two** three*', '~~one **two** three~~']) {
    const html = renderMarkdownHTML(content).replace(/ data-source-(?:end-)?line="\d+"/g, '');
    assert.equal(html, standard.render(content), content);
  }
});
