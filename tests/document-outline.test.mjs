import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTexMetadata } from '../web/src/tex-tools.js';
import { wholeDocumentOutline } from '../web/src/document-outline.js';

function manuscript(sources) {
  const index = new Map(Object.entries(sources).map(([path, contents]) => [path, extractTexMetadata(contents, path)]));
  const project = { main: 'other.tex', root: '/research', mode: 'document', files: [...index.keys(), 'book/latexmkrc'].map(path => ({path})) };
  return (active, previous = '') => wholeDocumentOutline(index, project, active, previous);
}

test('the document outline follows nested files at the include position with their source lines', () => {
  const get = manuscript({
    'other.tex': '\\documentclass{article}\n\\section{Other paper}',
    'book/main.tex': '\\documentclass{book}\n\\input{setup}\n\\chapter{Intro}\\input{parts/method}\\section{Discussion}\n\\include{appendix}\n\\end{document}\n\\section{Ignored}',
    'book/setup.tex': '\\newcommand{\\liststuff}{\\section{A definition}\\input{unrelated}}\n% \\input{unrelated}',
    'book/parts/method.tex': '% comment\n\\section{Method}\\input{parts/details}',
    'book/parts/details.tex': '\\subsection{Details}\\input{../main}',
    'book/appendix.tex': '\\chapter{Appendix}\\input{../shared}\\input \\dynamic',
    'shared.tex': '\\section{Shared}\\endinput\\section{After end}',
    'book/unrelated.tex': '\\section{Not included}',
  });
  const result = get('book/main.tex');
  assert.deepEqual(result.outline.map(({path, line, title}) => [path, line, title]), [
    ['book/main.tex', 3, 'Intro'], ['book/parts/method.tex', 2, 'Method'], ['book/parts/details.tex', 1, 'Details'],
    ['book/main.tex', 3, 'Discussion'], ['book/appendix.tex', 1, 'Appendix'], ['shared.tex', 1, 'Shared'],
  ]);
  assert.equal(get('book/parts/details.tex').main, 'book/main.tex');
  assert.equal(get('shared.tex', 'book/main.tex').main, 'book/main.tex');
  assert.equal(get('other.tex', 'book/main.tex').main, 'other.tex');
});

test('root directives, names with spaces, unbraced input and missing/cyclic includes', () => {
  const get = manuscript({
    'book/main.tex': '\\documentclass{article}\\input first \\input{"with space.tex"}\\input{../shared.tex}\\input{missing}',
    'book/first.tex': '\\section{First}\\input{main}',
    'book/with space.tex': '\\section{Space}',
    'shared.tex': '% !TeX root = book/main.tex\n\\section{Shared}',
  });
  assert.deepEqual(get('shared.tex').outline.map(x => x.title), ['First','Space','Shared']);
});
