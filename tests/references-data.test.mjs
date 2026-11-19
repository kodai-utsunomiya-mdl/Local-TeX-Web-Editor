import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReferenceTokens, referenceAt, planReferenceRename } from '../web/src/references-data.js';

test('reference tokens use the original Unicode offsets and ignore examples and custom definitions', () => {
  const content = String.raw`日本語 😀 \section{方法}\label{sec:method}
式は \eqref{eq:first}，引用は \citep[see][p. 4]{alpha2026, beta2025}．
% \ref{ignored}
\verb|\ref{ignored}|
\begin{minted}{tex}
\label{ignored}
\end{minted}
\newcommand{\reference}[1]{\ref{#1}\ref{ignored}}
\NewDocumentCommand{\other}{m}{\ref{ignored}}
\def\reference#1{\ref{ignored}}
\customcite{ignored}
\hyperref[sec:method]{方法へ}
\crefrange{eq:first}{eq:last}
\parencites[see]{alpha2026}[p. 2]{beta2025}
`;
  const tokens = extractReferenceTokens(content, 'main.tex');
  assert.deepEqual(tokens.map(item => [item.kind, item.role, item.key]), [
    ['label', 'definition', 'sec:method'], ['label', 'use', 'eq:first'],
    ['citation', 'use', 'alpha2026'], ['citation', 'use', 'beta2025'],
    ['label', 'use', 'sec:method'], ['label', 'use', 'eq:first'], ['label', 'use', 'eq:last'],
    ['citation', 'use', 'alpha2026'], ['citation', 'use', 'beta2025'],
  ]);
  for (const token of tokens) assert.equal(content.slice(token.from, token.to), token.key);
  assert.equal(tokens[0].context, '方法');
  assert.equal(referenceAt(tokens, tokens[1].from + 2), tokens[1]);
  assert.equal(referenceAt(tokens, 0), null);
});

test('bibliography keys and literal cross references exclude comments and text in titles', () => {
  const content = String.raw`% @book{ignored, title={Ignored}}
@comment{ @book{ignored, title={Ignored}} }
@book(alpha2026,
title = {A title with crossref={not-a-reference}},
author = {A. Author}, year = 2026)
@incollection{chapter2026, title={Chapter}, crossref={alpha2026}}
@incollection{other2026, title={Other}, crossref=stringmacro}
`;
  const tokens = extractReferenceTokens(content, 'references.bib');
  assert.deepEqual(tokens.map(item => [item.role, item.key]), [['definition', 'alpha2026'], ['definition', 'chapter2026'], ['use', 'alpha2026'], ['definition', 'other2026']]);
  assert.equal(tokens[0].author, 'A. Author');
  for (const token of tokens) assert.equal(content.slice(token.from, token.to), token.key);
});

test('renaming a key changes its definition and real uses while preserving unrelated text', () => {
  const files = [
    { path: 'main.tex', revision: 'source-1', content: String.raw`\label{sec:method} Text sec:method. \ref{sec:method} % \ref{sec:method}` },
    { path: 'chapter.tex', revision: 'source-2', content: String.raw`\hyperref[sec:method]{Read the method} \ref{sec:other}` },
  ];
  const plan = planReferenceRename(files, 'label', 'sec:method', 'sec:approach');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].before, files[0].content);
  assert.equal(plan[0].revision, 'source-1');
  assert.equal(plan[0].content, String.raw`\label{sec:approach} Text sec:method. \ref{sec:approach} % \ref{sec:method}`);
  assert.equal(plan[1].content, String.raw`\hyperref[sec:approach]{Read the method} \ref{sec:other}`);
  assert.throws(() => planReferenceRename([...files, { path: 'another.tex', content: String.raw`\label{sec:method}` }], 'label', 'sec:method', 'next'), /exactly one/);
  assert.throws(() => planReferenceRename([...files, { path: 'another.tex', content: String.raw`\label{next}` }], 'label', 'sec:method', 'next'), /already/);
  assert.throws(() => planReferenceRename(files, 'label', 'sec:method', 'has space'), /different key/);
});
