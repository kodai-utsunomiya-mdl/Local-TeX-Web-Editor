import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLogIssues } from '../web/src/log-issues-data.js';

test('the final TeX pass removes reference warnings that a later pass resolves', () => {
  const log = String.raw`This is pdfTeX, Version 1
(./main.tex
LaTeX Warning: Reference \`sec:method' on page 1 undefined on input line 4.
)
This is pdfTeX, Version 1
(./main.tex
(./chapters/method.tex
Overfull \hbox (12.0pt too wide) in paragraph at lines 8--9
LaTeX Warning: Citation \`missing2026' on page 2 undefined on input line 11.
)
LaTeX Warning: Reference \`sec:appendix' on page 2 undefined on input line 25.
)
`;
  const issues = extractLogIssues(log, ['main.tex', 'chapters/method.tex'], '/project');
  assert.deepEqual(issues.map(item => [item.category, item.path, item.line]), [
    ['box', 'chapters/method.tex', 8], ['citation', 'chapters/method.tex', 11], ['reference', 'main.tex', 25],
  ]);
  assert.ok(!issues.some(item => item.message.includes('sec:method')));
});

test('file-line errors, multiline warnings, and bibliography errors keep their locations', () => {
  const log = String.raw`This is upBibTeX
Repeated entry---line 14 of file references.bib
This is LuaHBTeX, Version 1
(./main.tex
C:\研究\chapters\章.tex:17: Undefined control sequence.
LaTeX Warning: Reference \`sec:missing' on page 1 undefined on input
  line 22.
! Missing $ inserted.
<inserted text>
l.28 Text
)
`;
  const issues = extractLogIssues(log, ['main.tex', 'references.bib', 'chapters/章.tex'], 'C:\\研究');
  assert.deepEqual(issues.map(item => [item.category, item.path, item.line]), [
    ['citation', 'references.bib', 14], ['error', 'chapters/章.tex', 17], ['reference', 'main.tex', 22], ['error', 'main.tex', 28],
  ]);
  assert.equal(issues[0].severity, 'error');
});
