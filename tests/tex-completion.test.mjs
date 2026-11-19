import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { CompletionContext, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import { createTeXCompletionSource } from '../web/src/tex-completion.js';

function editor(marked, extensions = []) {
  const at = marked.indexOf('§'), position = at < 0 ? marked.length : at;
  const view = { state: EditorState.create({ doc: marked.replace('§', ''), selection: { anchor: position }, extensions }) };
  view.dispatch = transaction => { view.state = transaction.state || view.state.update(transaction).state; };
  return view;
}
const source = createTeXCompletionSource(() => ({ citations: [{ key: 'alpha2026' }, { key: 'beta2025' }], labels: [{ key: 'sec:method', context: 'Method' }] }));
const complete = view => source(new CompletionContext(view.state, view.state.selection.main.head, true));
function choose(view, label) {
  const result = complete(view);
  assert.ok(result, 'A completion source is available');
  const completion = result.options.find(option => option.label === label);
  assert.ok(completion, 'The requested completion is available: ' + label);
  const to = view.state.selection.main.head;
  if (typeof completion.apply === 'function') completion.apply(view, completion, result.from, to);
  else view.dispatch(view.state.update({ changes: { from: result.from, to, insert: completion.apply || completion.label } }));
  return view.state.doc.toString();
}
const selected = view => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);

test('begin creates an editable environment argument and Tab leaves the argument', () => {
  const view = editor(String.raw`\b`);
  assert.equal(choose(view, '\\begin'), String.raw`\begin{}`);
  assert.equal(view.state.selection.main.from, 7);
  assert.equal(nextSnippetField(view), true);
  assert.equal(view.state.selection.main.from, 8);
});

test('itemize expands with one closing brace, an item, and indentation from the editor', () => {
  const view = editor('    \\begin{i§}', [indentUnit.of('   ')]);
  assert.equal(choose(view, 'itemize'), '    \\begin{itemize}\n       \\item \n    \\end{itemize}');
  assert.equal(view.state.doc.sliceString(0, view.state.selection.main.from).endsWith('\\item '), true);
  assert.equal(nextSnippetField(view), true);
  assert.equal(view.state.selection.main.from, view.state.doc.length);
});

test('fraction fields and Shift-Tab work with existing empty arguments', () => {
  const view = editor(String.raw`\fr§{}{}`);
  assert.equal(choose(view, '\\frac'), String.raw`\frac{}{}`);
  const numerator = view.state.selection.main.from;
  assert.equal(nextSnippetField(view), true);
  const denominator = view.state.selection.main.from;
  assert.ok(denominator > numerator);
  assert.equal(prevSnippetField(view), true);
  assert.equal(view.state.selection.main.from, numerator);
  assert.equal(nextSnippetField(view), true);
  assert.equal(nextSnippetField(view), true);
  assert.equal(view.state.selection.main.from, view.state.doc.length);
  const heading = editor(String.raw`\sect§{Existing title}`);
  assert.equal(choose(heading, '\\section'), String.raw`\section{Existing title}`);
  const root = editor(String.raw`\sq§[3]{x}`);
  assert.equal(choose(root, '\\sqrt[n]'), String.raw`\sqrt[3]{x}`);
});

test('an empty environment reuses its existing end while an existing body stays intact', () => {
  const empty = editor('\\begin{i§}\n\\end{itemize}\nFollowing text.');
  assert.equal(choose(empty, 'itemize'), '\\begin{itemize}\n  \\item \n\\end{itemize}\nFollowing text.');
  const inline = editor(String.raw`\begin{i§}\end{itemize}`);
  assert.equal(choose(inline, 'itemize'), '\\begin{itemize}\n  \\item \n\\end{itemize}');
  const populated = editor('\\begin{ali§gn}\n  x &= y\n\\end{align}\nFollowing text.');
  assert.equal(choose(populated, 'align'), '\\begin{align}\n  x &= y\n\\end{align}\nFollowing text.');
  const options = editor('\\begin{fi§}[t]\nExisting figure body.\n\\end{figure}');
  assert.equal(choose(options, 'figure'), '\\begin{figure}[t]\nExisting figure body.\n\\end{figure}');
});

test('end completion prefers the innermost environment and accepts an existing brace', () => {
  const view = editor('\\begin{document}\n\\begin{itemize}\n  \\item Text.\n\\end{i§}');
  const options = complete(view).options;
  assert.ok(options.find(option => option.label === 'itemize').boost > options.find(option => option.label === 'document').boost);
  assert.equal(choose(view, 'itemize'), '\\begin{document}\n\\begin{itemize}\n  \\item Text.\n\\end{itemize}');
});

test('comments, escaped commands, and literal environments suppress code completion', () => {
  for (const text of [String.raw`% \b`, String.raw`\\b`, String.raw`\verb|\b`, '\\begin{minted}{tex}\n\\fr', '\\begin{verbatim}\n' + 'literal example\n'.repeat(1500) + '\\cite{be']) assert.equal(complete(editor(text)), null, text.slice(-80));
  assert.ok(complete(editor(String.raw`50\% \b`)));
  assert.ok(complete(editor(String.raw`\\\b`)));
  assert.ok(complete(editor('\\begin{verbatim}\n\\frac{}{}\n\\end{verbatim}\n\\fr')));
  const closing = editor('\\begin{verbatim}\nLiteral text\n\\end{ve§}');
  assert.deepEqual(complete(closing).options.map(option => option.label), ['verbatim']);
  assert.equal(choose(closing, 'verbatim'), '\\begin{verbatim}\nLiteral text\n\\end{verbatim}');
});

test('a commented end does not close a new environment, and nested ends are counted', () => {
  const commented = editor('\\begin{i§}\n% \\end{itemize}\n');
  assert.equal(choose(commented, 'itemize'), '\\begin{itemize}\n  \\item \n\\end{itemize}\n% \\end{itemize}\n');
  const nested = editor('\\begin{i§}\n  \\begin{itemize}\n    \\item Inner\n  \\end{itemize}\n\\end{itemize}');
  const before = nested.state.doc.toString();
  assert.equal(choose(nested, 'itemize'), before.replace('\\begin{i}', '\\begin{itemize}'));
});

test('project citation and label keys remain available alongside command snippets', () => {
  const citation = editor(String.raw`\citep[see]{alpha2026, be§}`);
  assert.deepEqual(complete(citation).options.map(option => option.label), ['beta2025']);
  assert.equal(choose(citation, 'beta2025'), String.raw`\citep[see]{alpha2026, beta2025}`);
  const reference = editor(String.raw`\ref{sec:§}`);
  assert.equal(choose(reference, 'sec:method'), String.raw`\ref{sec:method}`);
  assert.equal(complete(editor('Ordinary prose.')), null);
});

test('matrix fields and escaped TeX delimiters keep their syntax through expansion', () => {
  const matrix = editor(String.raw`\begin{pma§}`);
  assert.equal(choose(matrix, 'pmatrix'), '\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}');
  for (const value of ['a', 'b', 'c', 'd']) { assert.equal(selected(matrix), value); assert.equal(nextSnippetField(matrix), true); }
  assert.equal(matrix.state.selection.main.from, matrix.state.doc.length);
  const braces = editor(String.raw`\lef`);
  assert.equal(choose(braces, '\\left\\{'), String.raw`\left\{\right\}`);
  assert.equal(braces.state.doc.sliceString(0, braces.state.selection.main.from), String.raw`\left\{`);
  assert.equal(nextSnippetField(braces), true);
  assert.equal(braces.state.selection.main.from, braces.state.doc.length);
});

test('a figure moves through placement, width, file, caption, and label after typing', () => {
  const view = editor(String.raw`\begin{fig§}`);
  const result = choose(view, 'figure');
  assert.match(result, /\\includegraphics\[width=\\linewidth\]\{\}/);
  assert.match(result, /\\caption\{\}/);
  for (const [before, replacement] of [['htbp', 't'], ['\\linewidth', '0.8\\linewidth'], ['', 'figures/result.pdf'], ['', 'An example'], ['fig:', 'fig:result']]) {
    assert.equal(selected(view), before);
    const range = view.state.selection.main;
    view.dispatch(view.state.update({ changes: { from: range.from, to: range.to, insert: replacement }, selection: { anchor: range.from + replacement.length }, userEvent: 'input.type' }));
    assert.equal(nextSnippetField(view), true);
  }
  assert.equal(view.state.selection.main.from, view.state.doc.length);
  assert.match(view.state.doc.toString(), /\\includegraphics\[width=0\.8\\linewidth\]\{figures\/result.pdf\}/);
  assert.match(view.state.doc.toString(), /\\caption\{An example\}/);
  assert.match(view.state.doc.toString(), /\\label\{fig:result\}/);
  assert.equal(view.state.doc.toString().match(/\\end\{figure\}/g).length, 1);
});

test('theorem environments defined in the document can be completed', () => {
  const view = editor('\\newtheorem{claim}{Claim}\n\\begin{cl§}');
  assert.equal(choose(view, 'claim'), '\\newtheorem{claim}{Claim}\n\\begin{claim}\n  \n\\end{claim}');
});
