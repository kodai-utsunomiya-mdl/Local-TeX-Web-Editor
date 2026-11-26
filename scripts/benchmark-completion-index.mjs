import { performance } from 'node:perf_hooks';
import { combineCompletionItems } from '../web/src/completion-index.js';
import { PDFCitationTitles } from '../web/src/pdf-citations.js';

const iterations = 1000;
const texFiles = Array.from({ length: 100 }, (_, file) => ({ citations: [], labels: Array.from({ length: 10 }, (_, label) => ({ key: `section:${file}:${label}`, line: label + 1 })) }));
const bibFiles = Array.from({ length: 20 }, (_, file) => ({ labels: [], citations: Array.from({ length: 250 }, (_, entry) => ({ key: `paper:${file}:${entry}`, title: `Paper ${entry}`, author: 'Author', year: '2026', path: `references-${file}.bib` })) }));

function measure(reuse) {
  const entries = [...texFiles, ...bibFiles];
  let items = combineCompletionItems(null, entries);
  const titles = Object.create(PDFCitationTitles.prototype);
  titles.getCitations = () => items.citations;
  titles.entries = null;
  titles.getIndex();
  let rebuilt = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const before = items.citations;
    entries[0] = { ...entries[0], labels: entries[0].labels.map(label => ({ ...label, line: label.line + 1 })) };
    items = reuse ? combineCompletionItems(items, entries) : {
      citations: entries.flatMap(entry => entry.citations), labels: entries.flatMap(entry => entry.labels),
    };
    if (items.citations !== before) { titles.getIndex(); rebuilt++; }
  }
  return { milliseconds: Number((performance.now() - started).toFixed(2)), citationIndexRebuilds: rebuilt };
}

// This measures metadata and citation-map work only. Browser DOM updates and
// TeX parsing are not included, and both variants use the same input objects.
measure(false); measure(true);
const samples = Array.from({ length: 3 }, () => ({ before: measure(false), after: measure(true) }));
process.stdout.write(JSON.stringify({ iterations, texFiles: texFiles.length, bibliographyFiles: bibFiles.length, citations: 5000, samples }, null, 2) + '\n');
