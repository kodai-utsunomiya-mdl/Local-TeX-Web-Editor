import { extractCitations, extractTexMetadata, maskNonCode } from './tex-tools.js';

function balanced(text, start, open = '{', close = '}') {
  if (text[start] !== open) return null;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { from: start + 1, to: i, end: i + 1 };
  }
  return null;
}

function spaces(text, offset) { while (offset < text.length && /\s/.test(text[offset])) offset++; return offset; }
function escaped(text, offset) { let count = 0; while (offset > 0 && text[--offset] === '\\') count++; return count % 2 === 1; }
function lineStarts(text) { const starts = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1); return starts; }
function position(starts, from) {
  let low = 0, high = starts.length;
  while (low + 1 < high) { const middle = (low + high) >>> 1; if (starts[middle] <= from) low = middle; else high = middle; }
  return { line: low + 1, column: from - starts[low] + 1 };
}

// Definitions of user commands are not direct document references. Their
// parameters and expansion need TeX itself, so leave those bodies to the author.
function maskMacroDefinitions(content) {
  const text = maskNonCode(content), chars = text.split('');
  const pattern = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|def|gdef|edef|xdef)(?![A-Za-z@])/g;
  for (let match; (match = pattern.exec(text));) {
    if (escaped(text, match.index)) continue;
    let at = spaces(text, pattern.lastIndex);
    if (text[at] === '*') at = spaces(text, at + 1);
    if (/^(?:def|gdef|edef|xdef)$/.test(match[1])) {
      const brace = text.indexOf('{', at);
      if (brace < 0) continue;
      const body = balanced(text, brace);
      if (!body) continue;
      at = body.end;
    } else {
      if (text[at] === '{') {
        const name = balanced(text, at); if (!name) continue; at = name.end;
      } else {
        const name = /^\\(?:[A-Za-z@]+|[^\s])/.exec(text.slice(at)); if (!name) continue; at += name[0].length;
      }
      at = spaces(text, at);
      for (let count = 0; count < 2 && text[at] === '['; count++) {
        const option = balanced(text, at, '[', ']'); if (!option) break; at = spaces(text, option.end);
      }
      const count = /Document/.test(match[1]) ? (/Environment/.test(match[1]) ? 3 : 2) : /environment/.test(match[1]) ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const body = balanced(text, at); if (!body) break; at = spaces(text, body.end);
      }
    }
    for (let i = match.index; i < at; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    pattern.lastIndex = at;
  }
  return chars.join('');
}

const citationCommands = new Set(['cite', 'Cite', 'citep', 'Citep', 'citet', 'Citet', 'citealt', 'Citealt', 'citealp', 'Citealp', 'citeauthor', 'Citeauthor', 'citeyear', 'citeyearpar', 'citetitle', 'citeurl', 'citedate', 'citefullauthor', 'fullcite', 'footfullcite', 'nocite', 'parencite', 'Parencite', 'textcite', 'Textcite', 'autocite', 'Autocite', 'footcite', 'footcitetext', 'smartcite', 'Smartcite', 'supercite', 'cites', 'Cites', 'parencites', 'Parencites', 'textcites', 'Textcites', 'autocites', 'Autocites', 'footcites', 'footcitetexts', 'smartcites', 'Smartcites', 'supercites']);
const referenceCommands = new Set(['ref', 'eqref', 'autoref', 'Autoref', 'cref', 'Cref', 'pageref', 'cpageref', 'Cpageref', 'vref', 'Vref', 'vpageref', 'Vpageref', 'nameref', 'Nameref', 'crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange']);
const validExistingKey = key => !!key && key !== '*' && !/[\s{}\\#%]/.test(key);
export const validReferenceKey = key => /^[\p{L}\p{N}:._/+@-]+$/u.test(key || '');

function addKeys(result, source, group, properties, starts) {
  let at = group.from;
  for (const part of source.slice(group.from, group.to).split(',')) {
    const key = part.trim(), from = at + part.indexOf(key);
    if (validExistingKey(key)) result.push({ ...properties, key, from, to: from + key.length, ...position(starts, from) });
    at += part.length + 1;
  }
}

function texTokens(content, path) {
  const text = maskMacroDefinitions(content), starts = lineStarts(content), result = [];
  const labels = new Map(extractTexMetadata(content, path).labels.map(item => [`${item.key}:${item.line}`, item]));
  const pattern = /\\([A-Za-z@]+)(\*)?/g;
  for (let match; (match = pattern.exec(text));) {
    if (escaped(text, match.index)) continue;
    const name = match[1];
    const definition = name === 'label', citation = citationCommands.has(name), reference = referenceCommands.has(name);
    if (!definition && !citation && !reference && name !== 'hyperref') continue;
    let at = spaces(text, pattern.lastIndex);
    if (name === 'hyperref') {
      const value = balanced(text, at, '[', ']');
      if (value) addKeys(result, content, value, { path, kind: 'label', role: 'use', command: name }, starts);
      continue;
    }
    let groups = 0;
    do {
      for (let optional = 0; optional < 2 && text[at] === '['; optional++) {
        const option = balanced(text, at, '[', ']'); if (!option) break; at = spaces(text, option.end);
      }
      const value = balanced(text, at);
      if (!value) break;
      addKeys(result, content, value, { path, kind: citation ? 'citation' : 'label', role: definition ? 'definition' : 'use', command: name }, starts);
      at = spaces(text, value.end); groups++;
    } while ((citation && /cites$/.test(name)) || (/range$/.test(name) && groups < 2));
    pattern.lastIndex = Math.max(pattern.lastIndex, at);
  }
  for (const item of result) if (item.role === 'definition') item.context = labels.get(`${item.key}:${item.line}`)?.context || '';
  return result;
}

function bibEntry(text, start) {
  if (text[start] === '{') return balanced(text, start);
  let braces = 0, quoted = false;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '{') braces++;
    else if (text[i] === '}') braces--;
    else if (text[i] === '"' && braces === 0) quoted = !quoted;
    else if (text[i] === ')' && braces === 0 && !quoted) return { from: start + 1, to: i, end: i + 1 };
  }
  return null;
}

function bibTokens(content, path) {
  const text = content.replace(/^[\t ]*%[^\n\r]*/gm, value => ' '.repeat(value.length));
  const starts = lineStarts(content), metadata = new Map(extractCitations(text, path).map(item => [`${item.key}:${item.line}`, item])), result = [];
  const pattern = /@([A-Za-z]+)\s*([{(])/g;
  for (let match; (match = pattern.exec(text));) {
    const entry = bibEntry(text, pattern.lastIndex - 1);
    if (!entry) continue;
    pattern.lastIndex = entry.end;
    if (/^(comment|string|preamble)$/i.test(match[1])) continue;
    const keyMatch = /^\s*([^\s,{}()]+)\s*,/.exec(text.slice(entry.from, entry.to));
    if (!keyMatch) continue;
    const from = entry.from + keyMatch[0].indexOf(keyMatch[1]), key = keyMatch[1];
    const details = metadata.get(`${key}:${position(starts, match.index).line}`);
    result.push({ ...details, key, path, kind: 'citation', role: 'definition', command: match[1], from, to: from + key.length, ...position(starts, from) });
    const field = /(?:^|,)\s*([A-Za-z][\w-]*)\s*=\s*/g;
    const bodyFrom = entry.from + keyMatch[0].length, body = text.slice(bodyFrom, entry.to);
    for (let found; (found = field.exec(body));) {
      const at = bodyFrom + field.lastIndex;
      let value = text[at] === '{' ? balanced(text, at) : null;
      if (text[at] === '"') {
        for (let end = at + 1; end < entry.to; end++) {
          if (text[end] === '\\') { end++; continue; }
          if (text[end] === '"') { value = { from: at + 1, to: end, end: end + 1 }; break; }
        }
      }
      if (!value) {
        const raw = /^[^,\s}#)]+/.exec(text.slice(at, entry.to));
        if (raw) value = { from: at, to: at + raw[0].length, end: at + raw[0].length };
      }
      if (!value) continue;
      if (/^(crossref|xref|xdata|entryset)$/i.test(found[1]) && ['{', '"'].includes(text[at]) && text[spaces(text, value.end)] !== '#') {
        addKeys(result, content, value, { path, kind: 'citation', role: 'use', command: found[1] }, starts);
      }
      field.lastIndex = value.end - bodyFrom;
    }
  }
  return result;
}

export function extractReferenceTokens(content, path = '') {
  return /\.bib$/i.test(path) ? bibTokens(content, path) : /\.(tex|sty|cls|ltx)$/i.test(path) ? texTokens(content, path) : [];
}

export function referenceAt(tokens, offset) { return tokens.find(item => item.from <= offset && offset <= item.to) || null; }

export function planReferenceRename(files, kind, key, nextKey) {
  if (!validReferenceKey(nextKey) || nextKey === key) throw new Error('Choose a different key using letters, digits, or : . _ / + @ - .');
  const indexed = files.map(file => ({ ...file, tokens: extractReferenceTokens(file.content, file.path) }));
  const definitions = indexed.flatMap(file => file.tokens).filter(item => item.kind === kind && item.role === 'definition');
  if (definitions.filter(item => item.key === key).length !== 1) throw new Error('The current key must have exactly one definition.');
  if (definitions.some(item => item.key === nextKey)) throw new Error('The new key already has a definition.');
  return indexed.flatMap(file => {
    const changes = file.tokens.filter(item => item.kind === kind && item.key === key).map(item => ({ from: item.from, to: item.to, insert: nextKey, line: item.line, column: item.column, role: item.role }));
    if (!changes.length) return [];
    let content = file.content;
    for (const change of [...changes].sort((a, b) => b.from - a.from)) content = content.slice(0, change.from) + change.insert + content.slice(change.to);
    return [{ path: file.path, before: file.content, revision: file.revision, content, changes }];
  });
}
