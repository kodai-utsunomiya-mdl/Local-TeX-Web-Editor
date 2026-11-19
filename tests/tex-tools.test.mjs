import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { maskNonCode, extractOutline, extractLabels, extractCitations, extractLogLocations, texCompletionSource } from '../web/src/tex-tools.js';

test('masking comments and examples keeps UTF-16 offsets and Windows line endings', () => {
  const text = '本文 📖 50\\%\r\n% ignored 📚 \\section{Hidden}\r\n\\verb|\\label{example}|\r\n\\section{Visible}\\label{sec:visible}\r\n\\begin{verbatim}\r\n\\section{Example}\r\n\\end{verbatim}\r\n';
  const literals = [];
  const masked = maskNonCode(text, { onLiteral: value => literals.push(value) });
  assert.equal(masked.length, text.length);
  assert.deepEqual([...masked.matchAll(/\r\n/g)].map(match => match.index), [...text.matchAll(/\r\n/g)].map(match => match.index));
  assert.ok(masked.startsWith('本文 📖 50\\%\r\n'));
  assert.equal(masked.indexOf('\\section{Visible}'), text.indexOf('\\section{Visible}'));
  assert.equal(masked.includes('Hidden'), false);
  assert.equal(masked.includes('example'), false);
  assert.equal(masked.includes('Example'), false);
  assert.deepEqual(literals.map(value => ({ name: value.name, closed: value.closed })), [{ name: 'verbatim', closed: true }]);
  assert.equal(text.slice(literals[0].from, literals[0].to), '\\begin{verbatim}\r\n\\section{Example}\r\n\\end{verbatim}');
});

test('outline follows multiline headings and ignores comments, examples, and escaped commands', () => {
  const text = String.raw`% \section{コメント}
\section[短い題名]{日本語の \emph{序論}}
本文の 50\% と \label{sec:intro}．
\verb|\section{例}| と \\section{文字列}
\begin{minted}{tex}
\section{コードの中}
\end{minted}
\subsection*{
  補足 {A} の説明
}
\label{sec:appendix}
\newcommand{\tagged}[1]{\label{#1}}
\newcommand{\heading}[1]{\section{#1}}
`;
  const headings = extractOutline(text);
  assert.deepEqual(headings.map(({ level, title, line }) => ({ level, title, line })), [
    { level: 2, title: '日本語の 序論', line: 2 },
    { level: 3, title: '補足 A の説明', line: 8 },
  ]);
  assert.equal(text.slice(headings[0].from, headings[0].to), String.raw`\section[短い題名]{日本語の \emph{序論}}`);
  assert.deepEqual(extractLabels(text, '章/原稿.tex').map(({ key, path, line, context }) => ({ key, path, line, context })), [
    { key: 'sec:intro', path: '章/原稿.tex', line: 3, context: '日本語の 序論' },
    { key: 'sec:appendix', path: '章/原稿.tex', line: 11, context: '補足 A の説明' },
  ]);
  assert.equal(extractOutline(String.raw`\section{実験 \#1}`)[0].title, '実験 #1');
});

test('bibliography completion reads nested titles, quoted fields, concatenation, and parentheses', () => {
  const bib = String.raw`@string{venue = "Conference"}
@comment{ @article{not-a-citation, title={Ignore me}} }
@article{alpha2026,
  title = {Learning with {Gaussian} features},
  author = "A. Author and B. Researcher",
  year = 2026
}
@book(beta2025,
  title = "An (unfinished" # { discussion) of {TeX}},
  editor = {C. Editor},
  date = {2025-11}
)
`;
  assert.deepEqual(extractCitations(bib, 'references.bib'), [
    { key: 'alpha2026', title: 'Learning with Gaussian features', author: 'A. Author and B. Researcher', year: '2026', path: 'references.bib', line: 3 },
    { key: 'beta2025', title: 'An (unfinished discussion) of TeX', author: 'C. Editor', year: '2025-11', path: 'references.bib', line: 8 },
  ]);
});

test('citation and reference completion inserts at the current comma-separated key', () => {
  const complete = texCompletionSource(() => ({
    citations: [
      { key: 'alpha2026', author: 'A. Author', title: 'An article', year: '2026', path: 'ref.bib', line: 2 },
      { key: 'beta2025', author: 'B. Author', title: 'Another article', year: '2025', path: 'ref.bib', line: 8 },
      { key: 'beta2025', title: 'Duplicate from another bibliography' },
    ],
    labels: [{ key: 'sec:intro', context: '序論', path: 'main.tex', line: 12 }],
  }));
  const invoke = text => complete({ state: EditorState.create({ doc: text }), pos: text.length, explicit: true });
  const text = String.raw`本文の引用は \citep[see][p. 2]{alpha2026, be`;
  const result = invoke(text);
  assert.equal(result.from, text.length - 2);
  assert.deepEqual(result.options.map(option => option.label), ['beta2025']);
  assert.equal(typeof result.options[0].info, 'function');
  assert.equal(result.options[0].apply, 'beta2025');
  assert.deepEqual(invoke(String.raw`\Cref{sec:`).options.map(option => option.label), ['sec:intro']);
  assert.deepEqual(invoke(String.raw`\ref*{sec:`).options.map(option => option.label), ['sec:intro']);
  assert.deepEqual(invoke(String.raw`\parencite{be`).options.map(option => option.label), ['alpha2026', 'beta2025']);
  assert.equal(invoke(String.raw`% \cite{be`), null);
  assert.equal(invoke(String.raw`\verb|\cite{be`), null);
  assert.equal(invoke(String.raw`\\cite{be`), null);
  assert.equal(invoke('普通の本文'), null);
});

test('error links map actual TeX paths back to project files, including Windows names', () => {
  const log = String.raw`latexmk: beginning compilation
C:\研究 論文\chapters\追加の 原稿.tex:27: Undefined control sequence.
./main.tex:8: Missing $ inserted.
"C:\研究 論文\main.tex":9: Another error.
C:\研究 論文\chapters\追加の 原稿.tex:27: Undefined control sequence.
C:\texlive\texmf-dist\tex\latex\unknown.sty:14: A package error.
main.tex:0: Not a source line.
../shared/main.tex:18: Error from another project.
C:\another-project\main.tex:25: Error outside this project.
Repeated entry---line 18 of file references.bib
`;
  assert.deepEqual(extractLogLocations(log, ['main.tex', 'references.bib', { path: 'chapters/追加の 原稿.tex' }], String.raw`C:\研究 論文`), [
    { path: 'chapters/追加の 原稿.tex', line: 27, message: 'Undefined control sequence.' },
    { path: 'main.tex', line: 8, message: 'Missing $ inserted.' },
    { path: 'main.tex', line: 9, message: 'Another error.' },
    { path: 'references.bib', line: 18, message: 'Repeated entry' },
  ]);
});
