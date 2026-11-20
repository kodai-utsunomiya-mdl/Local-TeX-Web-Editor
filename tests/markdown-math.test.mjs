import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, serializeMarkdown } from '../web/src/markdown-rich-document.js';
import { renderMarkdownHTML } from '../web/src/markdown-preview.js';

test('inline equations next to numbers roundtrip in each supported notation', () => {
  for (const formula of ['$x$', '$`x`$', '\\(x\\)']) {
    for (const text of [`3${formula}`, `${formula}3`, `3${formula}4`, `本文3${formula}4です`]) {
      const document = parseMarkdown(text);
      const equations = [];
      document.descendants(node => { if (node.type.name === 'math_inline') equations.push(node); });
      assert.equal(equations.length, 1, text);
      assert.equal(equations[0].attrs.tex, 'x', text);
      assert.deepEqual(parseMarkdown(serializeMarkdown(document)).toJSON(), document.toJSON(), text);
      assert.match(renderMarkdownHTML(text), /class="katex"/, text);
    }
  }
});

test('adjacent inline equations keep their individual content', () => {
  for (const text of ['$x$$y$', '3$x$$y$4', '$`x`$$y$', '$x$\\(y\\)']) {
    const document = parseMarkdown(text);
    const values = [];
    document.descendants(node => { if (node.type.name === 'math_inline') values.push(node.attrs.tex); });
    assert.deepEqual(values, ['x', 'y'], text);
    assert.deepEqual(parseMarkdown(serializeMarkdown(document)).toJSON(), document.toJSON(), text);
  }
});

test('escaped dollars and code remain text when they appear next to digits', () => {
  for (const text of ['3\\$x\\$4', '\\$5-\\$10', '`3$x$4`', '価格は $5 と $10', '```text\n3$x$4\n```']) {
    const document = parseMarkdown(text);
    const equations = [];
    document.descendants(node => { if (node.type.name.startsWith('math_')) equations.push(node); });
    assert.equal(equations.length, 0, text);
    assert.doesNotMatch(renderMarkdownHTML(text), /class="katex"/, text);
  }
});
