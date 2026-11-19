import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownEdit, sameMarkdownSelection } from '../web/src/markdown-editing-commands.js';

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
