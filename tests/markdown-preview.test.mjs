import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdownOutline, isMarkdownPath, renderMarkdownHTML, resolveMarkdownReference } from '../web/src/markdown-preview.js';
import { setLanguage } from '../web/src/i18n.js';

test.beforeEach(() => setLanguage('ja'));

test('Markdown の本文，表，コード，完了した項目を表示用の HTML にする', () => {
  const html = renderMarkdownHTML([
    '# 研究ノート', '', '本文の **強調** と [参考資料](https://example.org/paper).', '',
    '| 文書 | 状態 |', '| --- | --- |', '| 原稿 | 編集中 |', '',
    '- [x] 実験を確認する', '- [ ] 結果を書く', '',
    '```tex', '\\textbf{<本文>}', '```', '', '![図](figures/example.png)',
  ].join('\n'));
  assert.match(html, /<h1[^>]*>研究ノート<\/h1>/);
  assert.match(html, /<strong>強調<\/strong>/);
  assert.match(html, /<table/);
  assert.match(html, /<td>編集中<\/td>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled aria-label="未完了"/);
  assert.match(html, /class="language-tex">\\textbf\{&lt;本文&gt;\}/);
  assert.match(html, /data-markdown-image="figures\/example.png"/);
  assert.doesNotMatch(html, /<img[^>]*\ssrc=/);
});

test('GitHub のインライン数式と独立した数式を KaTeX で組む', () => {
  const html = renderMarkdownHTML([
    '通常の $x^2$ と GitHub の $`f_{\\theta}(x)`$ を使う．', '',
    '$$', '\\frac{1}{n}\\sum_{i=1}^n x_i', '$$', '',
    '```math', 'A^\\top A', '```', '', '\\(a+b\\) を本文に書く．',
  ].join('\n'));
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.match(html, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /class="markdown-equation"/);
  assert.doesNotMatch(html, /katex-error/);
});

test('式の入力途中でも後続の本文を表示し，式から HTML の機能を呼び出さない', () => {
  const html = renderMarkdownHTML('式 $\\frac{1}{$ の後に本文が続く．\n\n$\\href{javascript:alert(1)}{リンク}$\n\n$\\includegraphics{https://example.org/a.png}$');
  assert.match(html, /katex-error/);
  assert.match(html, /後に本文が続く/);
  assert.doesNotMatch(html, /<a\s[^>]*href=/);
  assert.doesNotMatch(html, /<img\s/);
});

test('HTML や JavaScript のリンクを原稿から実行しない', () => {
  const html = renderMarkdownHTML('<script>window.attack = true</script>\n\n<img src="x" onerror="window.attack = true">\n\n[実行](javascript:alert(1))\n\n[実行](data:text/html,attack)');
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):/);
  assert.match(html, /&lt;script&gt;/);
});

test('Markdown の相対パスを原稿のフォルダーから読み，見出しも扱う', () => {
  assert.deepEqual(resolveMarkdownReference('../figures/図%201.png', 'notes/intro.md'), { kind: 'local', path: 'figures/図 1.png', fragment: '' });
  assert.deepEqual(resolveMarkdownReference('./detail.markdown#実験の結果', 'notes/intro.md'), { kind: 'local', path: 'notes/detail.markdown', fragment: '実験の結果' });
  assert.deepEqual(resolveMarkdownReference('/README.md#top', 'notes/intro.md'), { kind: 'local', path: 'README.md', fragment: 'top' });
  assert.deepEqual(resolveMarkdownReference('#%E7%B5%90%E6%9E%9C', 'notes/intro.md'), { kind: 'anchor', fragment: '結果' });
  assert.equal(isMarkdownPath('notes/REPORT.MARKDOWN'), true);
  assert.equal(isMarkdownPath('main.tex'), false);
});

test('ローカルのリンクがプロジェクト外や実行用の URL を指した場合は開かない', () => {
  for (const reference of ['../../secret.txt', '%2e%2e/%2e%2e/secret.txt', '..\\..\\secret.txt', 'file:///C:/secret.txt', 'C:\\secret.txt', 'javascript:alert(1)', 'data:text/html,test', 'https:\n//example.org', '%00a.md']) {
    assert.equal(resolveMarkdownReference(reference, 'notes/intro.md'), null, reference);
  }
  assert.deepEqual(resolveMarkdownReference('https://example.org/paper?q=1#section'), { kind: 'external', href: 'https://example.org/paper?q=1#section' });
  assert.deepEqual(resolveMarkdownReference('//example.org/figure.png'), { kind: 'external', href: 'https://example.org/figure.png' });
});

test('同じ見出しが続いても，リンクで移動する先をそれぞれ作る', () => {
  const html = renderMarkdownHTML('# 実験の結果\n\n# 実験の結果\n\n## New Result\n');
  assert.match(html, /data-markdown-heading="実験の結果"/);
  assert.match(html, /data-markdown-heading="実験の結果-1"/);
  assert.match(html, /data-markdown-heading="new-result"/);
});

test('Markdown の見出しと行番号を取り出し，コード内の例を含めない', () => {
  const content = [
    '# **研究ノート** と [参考資料](https://example.org)', '', '複数行の', '見出し', '-------', '',
    '```markdown', '# 例の見出し', '```', '', '> ### 引用内の `コード`', '',
    '#### 結果 $x^2$ と ![図](figure.png)',
  ].join('\r\n');
  assert.deepEqual(extractMarkdownOutline(content), [
    { level: 1, title: '研究ノート と 参考資料', line: 1 },
    { level: 2, title: '複数行の 見出し', line: 3 },
    { level: 3, title: '引用内の コード', line: 11 },
    { level: 4, title: '結果 x^2 と 図', line: 13 },
  ]);
  assert.deepEqual(extractMarkdownOutline(''), []);
  assert.deepEqual(extractMarkdownOutline('本文だけの文書．'), []);
});

test('本文，入れ子の項目，表，コード，数式から原稿の行範囲を参照できる', () => {
  const html = renderMarkdownHTML([
    '# 見出し', '', '複数行の本文．', '次の行から本文が続く．', '',
    '- 一つ目', '  - 子の項目', '- 二つ目', '',
    '| 名前 | 値 |', '| --- | --- |', '| 結果 | 3 |', '',
    '```tex', '\\section{本文}', '\\textbf{次の行}', '```', '',
    '$$', 'a^2+b^2=c^2', '$$', '',
    '    first line', '    second line', '', '最後．',
  ].join('\r\n'));
  assert.match(html, /<h1 data-source-line="1" data-source-end-line="2"/);
  assert.match(html, /<p data-source-line="3" data-source-end-line="5">複数行の本文/);
  assert.match(html, /<li data-source-line="7" data-source-end-line="8">子の項目/);
  assert.match(html, /<tr data-source-line="12" data-source-end-line="13">/);
  assert.match(html, /<pre data-source-line="14" data-source-end-line="18">/);
  assert.match(html, /class="markdown-equation" data-source-line="19" data-source-end-line="22"/);
  assert.match(html, /<pre data-source-line="23" data-source-end-line="25">/);
  assert.match(html, /<p data-source-line="26" data-source-end-line="27">最後．/);
});
