import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTarget } from '../web/src/tex-tools.js';

test('compiles the active complete document, including unsaved text', () => {
  assert.equal(compileTarget('notes.tex', '\\documentclass{article}\n\\begin{document}notes', 'main.tex'), 'notes.tex');
  assert.equal(compileTarget('other/PAPER.TEX', '\\input{preamble}\n\\begin{document}paper', 'main.tex'), 'other/PAPER.TEX');
  assert.equal(compileTarget('new.tex', '\\documentclass[10pt]{article}', ''), 'new.tex');
});

test('uses the default document for included content and other file types', () => {
  assert.equal(compileTarget('sections/introduction.tex', '\\section{Introduction}\nText', 'main.tex'), 'main.tex');
  assert.equal(compileTarget('references.bib', '@article{example}', 'main.tex'), 'main.tex');
  assert.equal(compileTarget('README.md', '# Title\n\\begin{document}', 'main.tex'), 'main.tex');
  assert.equal(compileTarget('', '', 'main.tex'), 'main.tex');
});

test('ignores commented and literal examples of document declarations', () => {
  const content = String.raw`% \documentclass{article}
\verb|\begin{document}|
\begin{verbatim}
\documentclass{article}
\end{verbatim}
\\documentclass
\documentclassname{example}`;
  assert.equal(compileTarget('chapter.tex', content, 'main.tex'), 'main.tex');
});

test('resolves an explicit TeX root relative to the active file', () => {
  assert.equal(compileTarget('sections/body.tex', '% !TeX root = ../paper.tex\nText', 'main.tex'), 'paper.tex');
  assert.equal(compileTarget('chapters/body.tex', '%!TEX root = "../日本語の 原稿.tex"\r\n\\documentclass{article}', 'main.tex'), '日本語の 原稿.tex');
  assert.equal(compileTarget('draft/notes.tex', '% !tex root = ..\\paper.tex', 'main.tex'), 'paper.tex');
  assert.equal(compileTarget('body.tex', '% !TeX root = ../outside.tex', 'main.tex'), '../outside.tex');
});
