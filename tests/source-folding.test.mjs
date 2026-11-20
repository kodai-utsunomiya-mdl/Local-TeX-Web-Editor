import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { codeFolding, foldable, foldEffect, foldedRanges, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { sourceFolding, revealSourceRange } from '../web/src/source-folding.js';
import { outlineHierarchy } from '../web/src/outline-tree.js';

const stateFor = (doc, path = 'main.tex') => EditorState.create({
  doc, extensions: [codeFolding(), /\.md$/.test(path) ? markdown() : [], sourceFolding(path)],
});
function rangeAt(state, number) {
  const line = state.doc.line(number);
  return foldable(state, line.from, line.to);
}
function hiddenAt(state, number) {
  const range = rangeAt(state, number);
  return range ? state.doc.sliceString(range.from, range.to) : null;
}
function rangeCount(state) {
  let count = 0; foldedRanges(state).between(0, state.doc.length, () => count++); return count;
}
function parsedState(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 500);
  assert.ok(tree, 'the parser must finish before folding ranges are read');
  // ensureSyntaxTree advances the parse context. An editor transaction makes
  // that completed tree available to foldable through the language state field.
  const parsed = state.update({}).state;
  assert.equal(syntaxTree(parsed), tree);
  return parsed;
}

test('TeX sections fold through child headings and stop before the next peer or document ending', () => {
  const state = stateFor(String.raw`\begin{document}
\section{Introduction}
Opening text.
\subsection{Background}
Background text.
\subsubsection{Details}
Detailed text.

\section*{Results}
Results text.
\end{document}
`);
  assert.equal(hiddenAt(state, 2), '\nOpening text.\n\\subsection{Background}\nBackground text.\n\\subsubsection{Details}\nDetailed text.');
  assert.equal(hiddenAt(state, 4), '\nBackground text.\n\\subsubsection{Details}\nDetailed text.');
  assert.equal(hiddenAt(state, 6), '\nDetailed text.');
  assert.equal(hiddenAt(state, 9), '\nResults text.');
  assert.equal(rangeAt(state, 10), null);
  assert.equal(state.doc.lineAt(rangeAt(state, 1).to).number, 10);
});

test('nested environments close at matching names and preserve the closing line', () => {
  const state = stateFor(String.raw`\begin{itemize}
\item First
\begin{itemize}
\item Nested
\end{itemize}
\item Last
\end{itemize}
\begin{align*}
x &= y
% \end{align*} is a comment
z &= w
\end{align*}`);
  assert.equal(hiddenAt(state, 1), '\n\\item First\n\\begin{itemize}\n\\item Nested\n\\end{itemize}\n\\item Last');
  assert.equal(hiddenAt(state, 3), '\n\\item Nested');
  assert.equal(hiddenAt(state, 8), '\nx &= y\n% \\end{align*} is a comment\nz &= w');
});

test('comments, inline examples, and literal environments do not create false section ranges', () => {
  const state = stateFor(String.raw`% \section{Comment}
\verb|\section{Inline example}|
\begin{minted}{tex}
\section{Code example}
\begin{equation}
a = b
\end{equation}
\end{minted}
\section[Short]{A multiline
  heading}
The actual text.
\section{Empty}
\section{Last}
Last text.
`);
  assert.equal(rangeAt(state, 1), null);
  assert.equal(rangeAt(state, 2), null);
  assert.equal(rangeAt(state, 4), null);
  assert.equal(rangeAt(state, 5), null);
  assert.equal(state.doc.lineAt(rangeAt(state, 3).to).number, 7);
  assert.equal(hiddenAt(state, 9), '\n  heading}\nThe actual text.');
  assert.equal(rangeAt(state, 12), null);
  assert.equal(hiddenAt(state, 13), '\nLast text.');
});

test('section ranges stop at the enclosing environment and update after an edit', () => {
  let state = stateFor(String.raw`\begin{frame}
\section{A frame heading}
Frame text.
\end{frame}
Outside text.
\begin{unfinished}
Not closed yet.`);
  assert.equal(hiddenAt(state, 2), '\nFrame text.');
  assert.equal(rangeAt(state, 6), null);
  const insert = state.doc.line(3).from;
  state = state.update({ changes: { from: insert, insert: '\\section{Another heading}\n' } }).state;
  assert.equal(rangeAt(state, 2), null);
  assert.equal(hiddenAt(state, 3), '\nFrame text.');
});

test('Markdown folds ATX and Setext sections and fenced code through its language support', () => {
  const state = parsedState(stateFor('# Introduction\n\nOpening text.\n\n## Details\n\n```js\nconst value = 1;\n```\n\nResults\n=======\n\nDone.\n', 'notes.md'));
  assert.match(hiddenAt(state, 1), /## Details/);
  assert.doesNotMatch(hiddenAt(state, 1), /Results/);
  assert.match(hiddenAt(state, 5), /const value = 1/);
  assert.match(hiddenAt(state, 7), /const value = 1/);
  assert.match(hiddenAt(state, 11), /Done\./);
});

test('Markdown folding works after the initial parse runs out of its time budget', context => {
  let elapsed = 0, state;
  const clock = context.mock.method(Date, 'now', () => elapsed += 25);
  try {
    state = stateFor('# Introduction\n\nOpening text.\n\n```js\nconst value = 1;\n```\n', 'notes.md');
  } finally { clock.mock.restore(); }
  assert.ok(syntaxTree(state).length < state.doc.length, 'start with an incomplete initial parse');
  state = parsedState(state);
  assert.match(hiddenAt(state, 5), /const value = 1/);
});

test('a cursor jump opens nested folds and an explicit range reveals its selected text', () => {
  let state = stateFor('\\section{One}\nOpening.\n\\subsection{Child}\nChild text.\n\\section{Two}\nLater text.');
  const parent = rangeAt(state, 1), child = rangeAt(state, 3);
  state = state.update({ effects: [foldEffect.of(parent), foldEffect.of(child)] }).state;
  assert.equal(rangeCount(state), 2);
  const position = state.doc.line(4).from;
  const selected = state.update({ selection: { anchor: position } }).state;
  assert.equal(rangeCount(selected), 0);
  const effects = revealSourceRange(state, position, state.doc.length);
  assert.equal(effects.length, 2);
  state = state.update({ effects, selection: { anchor: position, head: state.doc.length } }).state;
  assert.equal(rangeCount(state), 0);
});

test('outline hierarchy follows heading levels and keeps expansion keys stable when lines move', () => {
  const outline = [
    { level: 2, title: 'Introduction', line: 1 },
    { level: 3, title: 'Background', line: 4 },
    { level: 5, title: 'A skipped level', line: 7 },
    { level: 3, title: 'Background', line: 10 },
    { level: 2, title: 'Methods', line: 13 },
  ];
  const result = outlineHierarchy(outline);
  assert.equal(result.roots.length, 2);
  assert.equal(result.roots[0].children.length, 2);
  assert.equal(result.nodes[2].parent, result.nodes[1]);
  assert.notEqual(result.nodes[1].id, result.nodes[3].id);
  assert.deepEqual(outlineHierarchy(outline.map(item => ({ ...item, line: item.line + 20 }))).nodes.map(node => node.id), result.nodes.map(node => node.id));
});
