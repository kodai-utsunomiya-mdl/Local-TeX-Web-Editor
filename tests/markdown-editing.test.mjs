import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection, AllSelection } from 'prosemirror-state';
import { markdownEdit, markdownMathSource, selectedMarkdownMath, sameMarkdownSelection } from '../web/src/markdown-editing-commands.js';
import { markdownFormattingState } from '../web/src/markdown-toolbar-state.js';
import { markdownSchema } from '../web/src/markdown-rich-document.js';

function document(content, anchor = 0, head = anchor) {
  return { path: 'notes.md', projectRoot: '/project', pane: 'left', content, anchor, head };
}
function apply(doc, command, options) {
  const edit = markdownEdit(doc, command, options);
  let content = doc.content;
  for (const change of [...edit.changes].sort((a, b) => b.from - a.from)) content = content.slice(0, change.from) + change.insert + content.slice(change.to);
  return { ...doc, content, ...edit.selection };
}

test('formatting surrounds the selected text and the same action removes its markers', () => {
  const source = document('some text here', 5, 9);
  const bold = apply(source, 'bold');
  assert.equal(bold.content, 'some **text** here');
  assert.equal(bold.content.slice(bold.anchor, bold.head), 'text');
  assert.equal(apply(bold, 'bold').content, source.content);
  const strike = apply(document('word', 0, 4), 'strike');
  assert.equal(strike.content, '~~word~~');
  assert.equal(apply(strike, 'strike').content, 'word');
  assert.equal(apply(document('', 0), 'bold', { placeholder: '文字' }).content, '**文字**');
});

test('italic formatting can be added to and removed from bold text', () => {
  const both = apply(document('**word**', 2, 6), 'italic');
  assert.equal(both.content, '***word***');
  assert.equal(apply(both, 'italic').content, '**word**');
  assert.equal(apply(document('**word**', 0, 8), 'italic').content, '***word***');
});

test('headings and lists apply to selected lines without changing the next line', () => {
  assert.equal(apply(document('one\ntwo\nthree', 0, 8), 'bullet').content, '- one\n- two\nthree');
  assert.equal(apply(document('- one\n- two', 0, 11), 'ordered').content, '1. one\n2. two');
  assert.equal(apply(document('- [ ] one\n- [x] two', 0, 19), 'task').content, 'one\ntwo');
  assert.equal(apply(document('## Title', 4), 'heading', { level: 3 }).content, '### Title');
  assert.equal(apply(document('## Title', 4), 'heading', { level: 0 }).content, 'Title');
  assert.equal(apply(document('\ntext', 0), 'quote').content, '> \ntext');
  const quote = apply(document('one\n\ntwo', 0, 8), 'quote');
  assert.equal(quote.content, '> one\n> \n> two');
  assert.equal(apply(quote, 'quote').content, 'one\n\ntwo');
});

test('inline code uses a delimiter longer than backticks inside the text', () => {
  const result = apply(document('a`b', 0, 3), 'inlineCode');
  assert.equal(result.content, '``a`b``');
  assert.equal(apply(result, 'inlineCode').content, 'a`b');
  const ending = apply(document('a`', 0, 2), 'inlineCode');
  assert.equal(ending.content, '`` a` ``');
  assert.equal(apply(ending, 'inlineCode').content, 'a`');
  assert.equal(apply(document('`code`', 0, 6), 'inlineCode').content, 'code');
});

test('headings and list markers can be started on an empty line', () => {
  for (const [command, prefix, options] of [['heading', '## ', { level: 2 }], ['bullet', '- '], ['ordered', '1. '], ['task', '- [ ] '], ['quote', '> ']]) {
    const result = apply(document('before\n\nafter', 7), command, options);
    assert.equal(result.content, `before\n${prefix}\nafter`);
    assert.equal(result.anchor, 7 + prefix.length);
    assert.equal(result.head, result.anchor);
  }
});

test('code blocks can contain Markdown fences and keep neighboring paragraphs', () => {
  const text = 'before\n\n```python\nprint(1)\n```\n\nafter';
  const block = apply(document(text, 8, text.length - 7), 'codeBlock', { language: 'markdown', code: '```python\nprint(1)\n```' });
  assert.ok(block.content.includes('````markdown\n```python\nprint(1)\n```\n````'));
  assert.ok(block.content.endsWith('\n\nafter'));
  const inserted = apply(document(''), 'codeBlock', { language: 'python', code: 'print("hello")' });
  assert.equal(inserted.content, '```python\nprint("hello")\n```\n');
  assert.equal(inserted.content.slice(inserted.anchor, inserted.head), 'print("hello")');
  assert.throws(() => markdownEdit(document(''), 'codeBlock', { language: 'bad`name' }), /code-language/);
});

test('links use separate display text and destination and reject executable URLs', () => {
  const result = apply(document('draft', 0, 5), 'link', { label: 'Paper [draft]', url: 'https://example.com/paper (1).pdf' });
  assert.equal(result.content, '[Paper \\[draft\\]](https://example.com/paper%20%281%29.pdf)');
  assert.equal(apply(document(''), 'link', { label: 'Notes', url: '../notes.md#section' }).content, '[Notes](../notes.md#section)');
  assert.throws(() => markdownEdit(document(''), 'link', { label: 'Bad', url: 'javascript:alert(1)' }), /link-url/);
  assert.throws(() => markdownEdit(document(''), 'link', { url: 'data:text/html,x' }), /link-url/);
});

test('a dialog checks the project, pane, text, and selection before applying an edit', () => {
  const original = document('text', 1, 3);
  assert.ok(sameMarkdownSelection({ ...original }, original));
  for (const change of [{ projectRoot: '/another' }, { pane: 'right' }, { path: 'other.md' }, { content: 'new text' }, { anchor: 0 }, { head: 2 }]) {
    assert.equal(sameMarkdownSelection({ ...original, ...change }, original), false);
  }
});

test('inline math defaults to GitHub notation and supports the other inline delimiters', () => {
  const original = document('Let x + y be the sum.', 4, 9);
  for (const [delimiter, expected] of [['$`', '$`x + y`$'], ['$', '$x + y$'], ['\\(', '\\(x + y\\)']]) {
    const result = apply(original, 'math', { displayMode: false, delimiter });
    assert.equal(result.content, `Let ${expected} be the sum.`);
    assert.equal(result.content.slice(result.anchor, result.head), 'x + y');
  }
  assert.equal(apply(document(''), 'math', { tex: '\\alpha^2' }).content, '$`\\alpha^2`$');
  assert.equal(markdownMathSource(' x + y '), '$`x + y`$');
  assert.throws(() => markdownMathSource(' '), /math-empty/);
  assert.throws(() => markdownMathSource('x\ny'), /math-line/);
  assert.throws(() => markdownMathSource('x', { delimiter: '__proto__' }), /math-delimiter/);
});

test('display math makes its own block and selects the TeX without disturbing adjacent paragraphs', () => {
  const result = apply(document('before x + y after', 7, 12), 'math', { displayMode: true });
  assert.equal(result.content, 'before \n\n$$\nx + y\n$$\n\n after');
  assert.equal(result.content.slice(result.anchor, result.head), 'x + y');
  const original = document('before\n\nx + y\n\nafter', 8, 13);
  assert.equal(apply(original, 'math', { displayMode: true }).content, 'before\n\n$$\nx + y\n$$\n\nafter');
  assert.equal(markdownMathSource('x\r\n+ y', { displayMode: true }), '$$\nx\n+ y\n$$');
  assert.equal(apply(document(''), 'math', { displayMode: true, tex: 'x' }).content, '$$\nx\n$$\n');
});

test('changing the notation of selected math replaces its delimiters together with its TeX', () => {
  let current = apply(document('x + y', 0, 5), 'math');
  assert.equal(selectedMarkdownMath(current).delimiter, '$`');
  current = apply(current, 'math', { delimiter: '$', tex: 'x - y' });
  assert.equal(current.content, '$x - y$');
  current = apply(current, 'math', { delimiter: '\\(' });
  assert.equal(current.content, '\\(x - y\\)');
  current = apply(current, 'math', { displayMode: true });
  assert.equal(current.content, '$$\nx - y\n$$\n');
  assert.equal(selectedMarkdownMath(current).displayMode, true);
  current = apply(current, 'math', { displayMode: false, delimiter: '$`' });
  assert.equal(current.content, '$`x - y`$\n');
  assert.equal(selectedMarkdownMath(document('A $`x`$ B', 2, 7)).tex, 'x');
});

test('changing selected display TeX removes the entire original delimiter with or without line breaks', () => {
  for (const [notation, delimiter] of [['$$x$$', '$$'], ['$$\nx\n$$', '$$'], ['$$\r\n  x  \r\n$$', '$$'], ['\\[x\\]', '\\['], ['\\[\nx\n\\]', '\\[']]) {
    const content = `before\n\n${notation}\n\nafter`;
    const start = content.indexOf('x');
    const original = document(content, start, start + 1);
    const selected = selectedMarkdownMath(original);
    assert.equal(selected.delimiter, delimiter, notation);
    assert.equal(selected.displayMode, true, notation);
    assert.equal(selected.tex, 'x', notation);
    assert.equal(content.slice(selected.from, selected.to), notation);
    const result = apply(original, 'math', { tex: 'y', displayMode: false, delimiter: '$`' });
    assert.equal(result.content, 'before\n\n$`y`$\n\nafter', notation);
    assert.equal(result.content.slice(result.anchor, result.head), 'y');
  }
  assert.equal(apply(document('before $$x$$ after', 9, 10), 'math', { tex: 'y' }).content, 'before $`y`$ after');
});

test('recognizing selected math respects surrounding spaces, escaped delimiters, and neighboring equations', () => {
  const original = document('before  $x$  after', 6, 13);
  assert.equal(apply(original, 'math', { tex: 'y' }).content, 'before  $`y`$  after');
  for (const content of ['\\$x$', '\\\\(x\\)', '$x$ + $y$', '$$x$$ + $$y$$']) {
    const from = content.includes('+') ? 0 : content.indexOf('x');
    const to = content.includes('+') ? content.length : from + 1;
    assert.equal(selectedMarkdownMath(document(content, from, to)), null, content);
  }
  assert.equal(selectedMarkdownMath(document('$$x$$', 1, 4)), null);
  for (const content of ['$x$$y$', '**$x$$y$**']) {
    const from = content.indexOf('x');
    assert.equal(apply(document(content, from, from + 1), 'math', { tex: 'z' }).content, content.replace('$x$', () => '$`z`$'));
  }
  assert.equal(apply(document('$x$$y$$z$', 4, 5), 'math', { tex: 't' }).content, '$x$$`t`$$z$');
  const escapedDollar = '$a\\$b$';
  assert.equal(selectedMarkdownMath(document(escapedDollar, 1, escapedDollar.length - 1)).tex, 'a\\$b');
  const brackets = '\\(x\\)';
  assert.equal(apply(document(brackets, 2, 3), 'math', { tex: 'y' }).content, '$`y`$');
});

function richState(content, anchor = 1, head = anchor) {
  const doc = markdownSchema.nodes.doc.create(null, content);
  return EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head) });
}

test('formatting state follows pending marks, including an explicit empty storedMarks value', () => {
  const { nodes, marks } = markdownSchema;
  const paragraph = nodes.paragraph.create(null, markdownSchema.text('word', [marks.strong.create()]));
  let state = richState([paragraph], 3);
  assert.equal(markdownFormattingState(state).bold, true);
  state = state.apply(state.tr.setStoredMarks([marks.em.create(), marks.strike.create()]));
  const pending = markdownFormattingState(state);
  assert.equal(pending.bold, false);
  assert.equal(pending.italic, true);
  assert.equal(pending.strike, true);
  state = state.apply(state.tr.setStoredMarks([]));
  assert.equal(markdownFormattingState(state).bold, false);
  assert.equal(markdownFormattingState(state).italic, false);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
  assert.equal(markdownFormattingState(state).bold, true);
});

test('formatting state reports combined marks and a selection containing differently formatted text', () => {
  const { nodes, marks } = markdownSchema;
  const paragraph = nodes.paragraph.create(null, [
    markdownSchema.text('both', [marks.strong.create(), marks.em.create()]),
    markdownSchema.text(' plain '),
    markdownSchema.text('code', [marks.code.create()]),
  ]);
  const selected = richState([paragraph], 1, 5);
  assert.equal(markdownFormattingState(selected).bold, true);
  assert.equal(markdownFormattingState(selected).italic, true);
  const whole = selected.apply(selected.tr.setSelection(new AllSelection(selected.doc)));
  assert.equal(markdownFormattingState(whole).bold, 'mixed');
  assert.equal(markdownFormattingState(whole).italic, 'mixed');
  assert.equal(markdownFormattingState(whole).inlineCode, 'mixed');
  const code = selected.apply(selected.tr.setSelection(TextSelection.create(selected.doc, 13)));
  assert.equal(markdownFormattingState(code).inlineCode, true);
  assert.equal(markdownFormattingState(code).bold, false);
});

test('formatting state follows the nearest list and preserves the enclosing quote indicator', () => {
  const { nodes } = markdownSchema;
  const paragraph = text => nodes.paragraph.create(null, markdownSchema.text(text));
  const bullet = nodes.bullet_list.create(null, nodes.list_item.create({ checked: null }, paragraph('bullet')));
  const task = nodes.bullet_list.create(null, nodes.list_item.create({ checked: false }, paragraph('task')));
  const ordered = nodes.ordered_list.create(null, nodes.list_item.create(null, paragraph('ordered')));
  const nested = nodes.blockquote.create(null, [bullet, task, ordered]);
  const state = richState([nested], 4);
  assert.equal(markdownFormattingState(state).bullet, true);
  assert.equal(markdownFormattingState(state).quote, true);
  for (const [text, command] of [['task', 'task'], ['ordered', 'ordered']]) {
    let position;
    state.doc.descendants((node, offset) => { if (node.isText && node.text === text) position = offset; });
    const current = state.apply(state.tr.setSelection(TextSelection.create(state.doc, position)));
    const active = markdownFormattingState(current);
    assert.equal(active[command], true);
    assert.equal(active.bullet, false);
    assert.equal(active.quote, true);
  }
  const all = markdownFormattingState(state.apply(state.tr.setSelection(new AllSelection(state.doc))));
  assert.equal(all.quote, true);
  assert.equal(all.bullet, 'mixed');
  assert.equal(all.task, 'mixed');
  assert.equal(all.ordered, 'mixed');
  const code = richState([nodes.code_block.create(null, markdownSchema.text('print(1)'))]);
  assert.equal(markdownFormattingState(code).codeBlock, true);
  assert.equal(markdownFormattingState(code).inlineCode, false);
});
