import { Prec } from '@codemirror/state';
import { foldService, foldedRanges, unfoldEffect } from '@codemirror/language';
import { extractOutline, maskNonCode } from './tex-tools.js';

const texPaths = /\.(?:tex|sty|cls|ltx|def|bst)$/i;
const rangesByDocument = new WeakMap();

function escaped(text, offset) {
  let count = 0;
  while (offset > 0 && text[--offset] === '\\') count++;
  return count % 2 === 1;
}

function texRanges(doc) {
  const source = doc.toString(), environments = [], opened = [];
  const code = maskNonCode(source, { onLiteral({ name, from, to, closed }) {
    if (closed) environments.push({ from, close: to - `\\end{${name}}`.length });
  } });
  const tokens = /\\(begin|end)(?![A-Za-z@])\s*\{\s*([A-Za-z][A-Za-z0-9*@._:-]*)\s*\}/g;
  for (const match of code.matchAll(tokens)) {
    if (escaped(code, match.index)) continue;
    const name = match[2];
    if (match[1] === 'begin') opened.push({ name, from: match.index });
    else {
      const index = opened.findLastIndex(item => item.name === name);
      if (index >= 0) {
        environments.push({ from: opened[index].from, close: match.index });
        opened.length = index;
      }
    }
  }

  const ranges = new Map();
  const add = (start, boundary) => {
    const line = doc.lineAt(start);
    let end = boundary >= doc.length ? doc.length : Math.max(0, doc.lineAt(boundary).from - 1);
    let last = doc.lineAt(end);
    while (last.number > line.number && !last.text.trim()) {
      last = doc.line(last.number - 1);
      end = last.to;
    }
    if (last.number <= line.number || end <= line.to) return;
    const range = { from: line.to, to: end };
    if (!ranges.has(line.from) || ranges.get(line.from).to < end) ranges.set(line.from, range);
  };
  for (const environment of environments) add(environment.from, environment.close);

  const headings = extractOutline(source);
  const stack = [], ends = new Map();
  for (const heading of headings) {
    while (stack.length && stack.at(-1).level >= heading.level) ends.set(stack.pop(), heading.from);
    stack.push(heading);
  }
  for (const heading of stack) ends.set(heading, doc.length);
  environments.sort((a, b) => a.from - b.from);
  let cursor = 0, containers = [];
  for (const heading of headings) {
    containers = containers.filter(item => item.close > heading.from);
    while (cursor < environments.length && environments[cursor].from < heading.from) {
      const container = environments[cursor++];
      if (container.close > heading.from) containers.push(container);
    }
    let end = ends.get(heading);
    for (const container of containers) end = Math.min(end, container.close);
    add(heading.from, end);
  }
  return ranges;
}

export function sourceFolding(path) {
  // Markdown's language support already supplies heading, fenced-code, and
  // block folding. This service supplies the missing ranges for StreamLanguage.
  if (!texPaths.test(path || '')) return [];
  return Prec.high(foldService.of((state, lineStart) => {
    let ranges = rangesByDocument.get(state.doc);
    if (!ranges) rangesByDocument.set(state.doc, ranges = texRanges(state.doc));
    return ranges.get(lineStart) || null;
  }));
}

export function revealSourceRange(state, from, to = from) {
  const start = Math.max(0, Math.min(state.doc.length, from, to));
  const end = Math.max(0, Math.min(state.doc.length, Math.max(from, to)));
  const effects = [];
  foldedRanges(state).between(start, end, (a, b) => {
    if (a < end && b > start || start === end && a < start && b > start) effects.push(unfoldEffect.of({ from: a, to: b }));
  });
  return effects;
}
