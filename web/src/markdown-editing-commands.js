import { MarkdownSource } from './markdown-rich-document.js';

function sourceSelection(document) {
  const content = String(document.content || '');
  const clamp = value => Math.max(0, Math.min(content.length, Number.isInteger(value) ? value : 0));
  const anchor = clamp(document.anchor), head = clamp(document.head);
  return { content, from: Math.min(anchor, head), to: Math.max(anchor, head), anchor, head };
}

function edit(from, to, insert, anchor = from, head = anchor) {
  return { changes: [{ from, to, insert }], selection: { anchor, head } };
}

function longestBackticks(text) {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function selectedLines(document) {
  const selection = sourceSelection(document);
  const from = selection.from === 0 ? 0 : selection.content.lastIndexOf('\n', selection.from - 1) + 1;
  const last = selection.to > selection.from && selection.content[selection.to - 1] === '\n' ? selection.to - 1 : selection.to;
  const end = selection.content.indexOf('\n', last);
  const to = end < 0 ? selection.content.length : end;
  return { ...selection, from, to, lines: selection.content.slice(from, to).split('\n') };
}

function wrapped(document, marker, placeholder) {
  const { content, from, to } = sourceSelection(document);
  let selected = content.slice(from, to);
  const italicIsPresent = (left, right) => marker !== '*' || ((left.match(/\*+$/)?.[0].length || 0) % 2 === 1 && (right.match(/^\*+/)?.[0].length || 0) % 2 === 1);
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2 && italicIsPresent(selected.match(/^\*+/)?.[0] || '', selected.match(/\*+$/)?.[0] || '')) {
    selected = selected.slice(marker.length, -marker.length);
    return edit(from, to, selected, from, from + selected.length);
  }
  if (from >= marker.length && content.slice(from - marker.length, from) === marker && content.slice(to, to + marker.length) === marker && italicIsPresent(content.slice(0, from), content.slice(to))) {
    return edit(from - marker.length, to + marker.length, selected, from - marker.length, to - marker.length);
  }
  const value = selected || placeholder;
  return edit(from, to, marker + value + marker, from + marker.length, from + marker.length + value.length);
}

function inlineCode(document, placeholder) {
  const { content, from, to } = sourceSelection(document);
  let selected = content.slice(from, to);
  const existing = selected.match(/^(`+)([\s\S]*?)\1$/);
  if (existing && !existing[2].startsWith('`') && !existing[2].endsWith('`')) {
    let body = existing[2];
    if (body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) body = body.slice(1, -1);
    return edit(from, to, body, from, from + body.length);
  }
  const before = content.slice(0, from).match(/(`+)( ?)$/);
  const after = content.slice(to).match(/^( ?)(`+)/);
  if (before && after && before[1] === after[2] && before[2] === after[1] && selected) {
    const start = from - before[0].length;
    return edit(start, to + after[0].length, selected, start, start + selected.length);
  }
  selected ||= placeholder;
  const delimiter = '`'.repeat(longestBackticks(selected) + 1);
  const padding = selected.startsWith('`') || selected.endsWith('`') || (/^ .+ $/s.test(selected) && /[^ ]/.test(selected)) ? ' ' : '';
  const insert = delimiter + padding + selected + padding + delimiter;
  const start = from + delimiter.length + padding.length;
  return edit(from, to, insert, start, start + selected.length);
}

function linesWithPrefix(document, kind, level = 1) {
  const selected = selectedLines(document);
  const nonempty = selected.lines.filter(line => line.trim());
  const emptyCurrentLine = selected.anchor === selected.head && selected.lines.length === 1;
  const expressions = { bullet: /^(\s*)[-+*] (?!\[[ xX]\] )/, ordered: /^(\s*)\d+[.)] /, task: /^(\s*)[-+*] \[[ xX]\] /, quote: /^(\s*)> ?/ };
  let transformed;
  if (kind === 'heading') {
    const depth = Math.max(0, Math.min(6, Number(level) || 0));
    transformed = selected.lines.map(line => {
      if (!line.trim() && !emptyCurrentLine) return line;
      const stripped = line.replace(/^( {0,3})#{1,6}(?:[ \t]+|$)/, '$1');
      return depth ? '#'.repeat(depth) + ' ' + stripped : stripped;
    });
  } else if (kind === 'quote') {
    const remove = nonempty.length > 0 && nonempty.every(line => expressions.quote.test(line));
    transformed = selected.lines.map(line => remove ? line.replace(expressions.quote, '$1') : `> ${line}`);
  } else {
    const remove = nonempty.length > 0 && nonempty.every(line => expressions[kind].test(line));
    let index = 0;
    transformed = selected.lines.map(line => {
      if (!line.trim() && !emptyCurrentLine) return line;
      if (remove) return line.replace(expressions[kind], '$1');
      const indent = line.match(/^\s*/)[0];
      const text = line.slice(indent.length).replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
      const prefix = kind === 'ordered' ? `${++index}. ` : kind === 'task' ? '- [ ] ' : '- ';
      return indent + prefix + text;
    });
  }
  const insert = transformed.join('\n');
  if (selected.anchor === selected.head) {
    const oldLine = selected.lines[0], newLine = transformed[0];
    const offset = Math.max(0, Math.min(newLine.length, selected.anchor - selected.from + newLine.length - oldLine.length));
    return edit(selected.from, selected.to, insert, selected.from + offset);
  }
  return edit(selected.from, selected.to, insert, selected.from, selected.from + insert.length);
}

function markdownLink(document, { label, url, placeholder }) {
  const { content, from, to } = sourceSelection(document);
  const href = String(url || '').trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) throw new Error('link-url');
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) throw new Error('link-url');
  const text = String((label ?? content.slice(from, to)) || placeholder || href).replace(/\r?\n/g, ' ');
  const escaped = text.replaceAll('&', '&amp;').replace(/[\\[\]`*_<>]/g, character => `\\${character}`);
  const target = href.replace(/[\\\s<>()[\]]/g, character => encodeURIComponent(character).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`));
  const insert = `[${escaped}](${target})`;
  return edit(from, to, insert, from + 1, from + 1 + escaped.length);
}

function fencedCode(document, { language = '', placeholder = 'code', code } = {}) {
  const selection = sourceSelection(document);
  let { content, from, to } = selection;
  if (from === to) ({ from, to } = selectedLines(document));
  let selected = content.slice(from, to);
  const wholeFence = selected.match(/^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\2\s*$/);
  if (wholeFence && code === undefined) return edit(from, to, wholeFence[4], from, from + wholeFence[4].length);
  const tag = String(language).trim();
  if (tag.length > 50 || /[\s`<>]/.test(tag)) throw new Error('code-language');
  selected = code === undefined ? selected || placeholder : String(code) || placeholder;
  const fence = '`'.repeat(Math.max(3, longestBackticks(selected) + 1));
  const prefix = from === 0 ? '' : content[from - 1] === '\n' ? (from > 1 && content[from - 2] === '\n' ? '' : '\n') : '\n\n';
  const suffix = to === content.length ? '\n' : content[to] === '\n' ? (content[to + 1] === '\n' ? '' : '\n') : '\n\n';
  const opening = prefix + fence + tag + '\n';
  const insert = opening + selected + (selected.endsWith('\n') ? '' : '\n') + fence + suffix;
  return edit(from, to, insert, from + opening.length, from + opening.length + selected.length);
}

export function markdownMathSource(tex, { displayMode = false, delimiter = '$`' } = {}) {
  const value = String(tex ?? '').replace(/\r\n?/g, '\n').trim();
  if (!value) throw new Error('math-empty');
  if (displayMode) return `$$\n${value}\n$$`;
  if (!['$`', '$', '\\('].includes(delimiter)) throw new Error('math-delimiter');
  const closing = { '$`': '`$', '$': '$', '\\(': '\\)' }[delimiter];
  if (value.includes('\n')) throw new Error('math-line');
  return delimiter + value + closing;
}

export function selectedMarkdownMath(document) {
  const { content, from, to } = sourceSelection(document);
  if (from === to) return null;
  const selection = content.slice(from, to);
  const selectedFrom = from + /^\s*/.exec(selection)[0].length;
  const selectedTo = to - /\s*$/.exec(selection)[0].length;
  let parsed;
  const escaped = position => {
    let count = 0;
    while (position > 0 && content[--position] === '\\') count++;
    return count % 2 === 1;
  };
  function enclosingMath(start, end, opening, closing, displayMode) {
    const closingStart = end - closing.length;
    const texStart = start + opening.length;
    if (start < 0 || end > content.length || texStart >= closingStart || content.slice(start, texStart) !== opening || content.slice(closingStart, end) !== closing || escaped(start) || escaped(closingStart)) return null;
    if (opening.startsWith('$')) {
      // Adjacent inline equations also have two dollars in a row. Use the
      // document's math nodes to find which expression owns each delimiter.
      parsed ||= new MarkdownSource(content);
      let found = false;
      parsed.doc.descendants((node, position) => {
        if (!['math_inline', 'math_block'].includes(node.type.name) || node.attrs.delimiter !== opening) return;
        const nodeFrom = parsed.sourceOffsetAt(position);
        let nodeTo = parsed.sourceOffsetAt(position + node.nodeSize);
        if (node.type.name === 'math_block') while (nodeTo > nodeFrom && /\s/.test(content[nodeTo - 1])) nodeTo--;
        if (nodeFrom === start && nodeTo === end) found = true;
      });
      if (!found) return null;
    }
    for (let index = content.indexOf(closing, texStart); index >= 0 && index < closingStart; index = content.indexOf(closing, index + closing.length)) {
      if (!escaped(index)) return null;
    }
    const tex = content.slice(texStart, closingStart).trim();
    if (!displayMode && /\r|\n/.test(tex)) return null;
    return { from: start, to: end, tex, displayMode, delimiter: opening };
  }
  for (const [opening, closing, displayMode] of [['$$', '$$', true], ['\\[', '\\]', true], ['$`', '`$', false], ['\\(', '\\)', false], ['$', '$', false]]) {
    const whole = enclosingMath(selectedFrom, selectedTo, opening, closing, displayMode);
    if (whole) return whole;
    let before = from, after = to;
    if (displayMode) {
      while (before > 0 && /\s/.test(content[before - 1])) before--;
      while (after < content.length && /\s/.test(content[after])) after++;
    }
    const surrounding = enclosingMath(before - opening.length, after + closing.length, opening, closing, displayMode);
    if (surrounding) return surrounding;
  }
  return null;
}

function markdownMath(document, options) {
  const selection = sourceSelection(document), existing = selectedMarkdownMath(document);
  const { content } = selection;
  const { from, to } = existing || selection;
  const tex = String(options.tex ?? existing?.tex ?? content.slice(from, to)).replace(/\r\n?/g, '\n').trim();
  const source = markdownMathSource(tex, options);
  if (!options.displayMode) {
    const start = from + (options.delimiter || '$`').length;
    return edit(from, to, source, start, start + tex.length);
  }
  const prefix = from === 0 ? '' : content[from - 1] === '\n' ? (from > 1 && content[from - 2] === '\n' ? '' : '\n') : '\n\n';
  const suffix = to === content.length ? '\n' : content[to] === '\n' ? (content[to + 1] === '\n' ? '' : '\n') : '\n\n';
  const start = from + prefix.length + 3;
  return edit(from, to, prefix + source + suffix, start, start + tex.length);
}

export function markdownEdit(document, command, options = {}) {
  switch (command) {
    case 'bold': return wrapped(document, '**', options.placeholder || 'text');
    case 'italic': return wrapped(document, '*', options.placeholder || 'text');
    case 'strike': return wrapped(document, '~~', options.placeholder || 'text');
    case 'inlineCode': return inlineCode(document, options.placeholder || 'code');
    case 'heading': return linesWithPrefix(document, command, options.level);
    case 'bullet': case 'ordered': case 'task': case 'quote': return linesWithPrefix(document, command);
    case 'codeBlock': return fencedCode(document, options);
    case 'math': return markdownMath(document, options);
    case 'link': return markdownLink(document, options);
    default: throw new Error('unknown-markdown-command');
  }
}

export function sameMarkdownSelection(current, expected) {
  return !!current && !!expected && current.path === expected.path && current.projectRoot === expected.projectRoot && current.pane === expected.pane && current.content === expected.content && current.anchor === expected.anchor && current.head === expected.head && current.richAnchor === expected.richAnchor && current.richHead === expected.richHead;
}
