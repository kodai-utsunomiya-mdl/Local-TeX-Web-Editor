import MarkdownIt from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';
import { markdownMath } from './markdown-math.js';
import katex from 'katex';
import { Schema } from 'prosemirror-model';
import { schema as basicSchema, MarkdownParser, MarkdownSerializer, defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';

const mathAttrs = (block = false) => ({
  tex: { default: '' },
  delimiter: { default: block ? '$$' : '$`' },
  displayMode: { default: block },
  equationNumber: { default: '' },
});

let nodes = basicSchema.spec.nodes
  .update('heading', {
    ...basicSchema.spec.nodes.get('heading'), content: 'inline*',
    attrs: { level: { default: 1 }, markup: { default: '#' } },
  })
  .update('code_block', {
    ...basicSchema.spec.nodes.get('code_block'),
    attrs: { params: { default: '' }, fence: { default: '```' } },
  })
  .update('horizontal_rule', {
    ...basicSchema.spec.nodes.get('horizontal_rule'), attrs: { markup: { default: '---' } },
  })
  .update('bullet_list', {
    ...basicSchema.spec.nodes.get('bullet_list'),
    attrs: { tight: { default: true }, bullet: { default: '-' } },
  })
  .update('ordered_list', {
    ...basicSchema.spec.nodes.get('ordered_list'),
    attrs: { order: { default: 1 }, tight: { default: true }, delimiter: { default: '.' } },
  })
  .update('list_item', {
    ...basicSchema.spec.nodes.get('list_item'), content: 'paragraph block*',
    attrs: { checked: { default: null } },
    parseDOM: [{ tag: 'li', getAttrs: dom => ({ checked: dom.hasAttribute('data-checked') ? dom.getAttribute('data-checked') === 'true' : null }) }],
    toDOM: node => ['li', node.attrs.checked === null ? {} : { 'data-checked': String(node.attrs.checked) }, 0],
  })
  .addToEnd('math_inline', {
    inline: true, group: 'inline', atom: true, attrs: mathAttrs(),
    parseDOM: [{ tag: 'span[data-math-tex]', getAttrs: dom => ({ tex: dom.getAttribute('data-math-tex') || '', delimiter: dom.getAttribute('data-math-delimiter') || '$`' }) }],
    toDOM: node => ['span', { 'data-math-tex': node.attrs.tex, 'data-math-delimiter': node.attrs.delimiter }, node.attrs.tex],
  })
  .addToEnd('math_block', {
    group: 'block', atom: true, defining: true, attrs: mathAttrs(true),
    parseDOM: [{ tag: 'div[data-math-tex]', getAttrs: dom => ({ tex: dom.getAttribute('data-math-tex') || '', delimiter: dom.getAttribute('data-math-delimiter') || '$$', displayMode: true, equationNumber: dom.getAttribute('data-equation-number') || '' }) }],
    toDOM: node => ['div', { 'data-math-tex': node.attrs.tex, 'data-math-delimiter': node.attrs.delimiter, 'data-equation-number': node.attrs.equationNumber }, node.attrs.tex],
  })
  .addToEnd('raw_block', {
    content: 'text*', group: 'block', marks: '', code: true, defining: true,
    attrs: { kind: { default: 'markdown' } },
    parseDOM: [{ tag: 'pre[data-markdown-raw]', priority: 60, preserveWhitespace: 'full', getAttrs: dom => ({ kind: dom.getAttribute('data-markdown-raw') || 'markdown' }) }],
    toDOM: node => ['pre', { 'data-markdown-raw': node.attrs.kind }, ['code', 0]],
  })
  .append(tableNodes({
    tableGroup: 'block', cellContent: 'paragraph',
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: dom => ['left', 'center', 'right'].includes(dom.style.textAlign) ? dom.style.textAlign : null,
        setDOMAttr: (value, attrs) => { if (['left', 'center', 'right'].includes(value)) attrs.style = `text-align: ${value}`; },
      },
    },
  }));

let marks = basicSchema.spec.marks
  .update('em', { ...basicSchema.spec.marks.get('em'), attrs: { markup: { default: '*' } } })
  .update('strong', { ...basicSchema.spec.marks.get('strong'), attrs: { markup: { default: '**' } } })
  .addBefore('code', 'strike', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s'],
  });

export const markdownSchema = new Schema({ nodes, marks });

const tokenizer = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false }).use(cjkFriendly).use(markdownMath, {
  engine: katex,
  katexOptions: { trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: {} },
});

function mathTokenAttrs(token) {
  const block = token.type.startsWith('math_block');
  return {
    tex: token.content,
    delimiter: (block ? token.tag : token.markup) || (block ? '$$' : '$'),
    displayMode: block || token.type === 'math_inline_double',
    equationNumber: token.type === 'math_block_eqno' ? token.info : '',
  };
}

const cellAttrs = token => ({ align: /text-align:\s*(left|center|right)/.exec(token.attrGet('style') || '')?.[1] || null });
const parseRules = {
  ...defaultMarkdownParser.tokens,
  heading: { block: 'heading', getAttrs: token => ({ level: Number(token.tag.slice(1)), markup: token.markup }) },
  code_block: { block: 'code_block', noCloseToken: true, attrs: { params: '', fence: '' } },
  fence: { block: 'code_block', noCloseToken: true, getAttrs: token => ({ params: token.info || '', fence: token.markup || '```' }) },
  hr: { node: 'horizontal_rule', getAttrs: token => ({ markup: token.markup }) },
  bullet_list: {
    block: 'bullet_list',
    getAttrs: (token, tokens, index) => ({ ...defaultMarkdownParser.tokens.bullet_list.getAttrs(token, tokens, index), bullet: token.markup || '-' }),
  },
  ordered_list: {
    block: 'ordered_list',
    getAttrs: (token, tokens, index) => ({ ...defaultMarkdownParser.tokens.ordered_list.getAttrs(token, tokens, index), delimiter: token.markup || '.' }),
  },
  list_item: { block: 'list_item', getAttrs: token => ({ checked: token.meta?.checked ?? null }) },
  image: { node: 'image', getAttrs: token => ({ src: token.attrGet('src') || '', title: token.attrGet('title') || null, alt: token.children?.map(child => child.content).join('') || null }) },
  em: { mark: 'em', getAttrs: token => ({ markup: token.markup || '*' }) },
  strong: { mark: 'strong', getAttrs: token => ({ markup: token.markup || '**' }) },
  s: { mark: 'strike' },
  math_inline: { node: 'math_inline', getAttrs: mathTokenAttrs },
  math_inline_double: { node: 'math_inline', getAttrs: mathTokenAttrs },
  math_block: { node: 'math_block', getAttrs: mathTokenAttrs },
  math_block_eqno: { node: 'math_block', getAttrs: mathTokenAttrs },
  table: { block: 'table' }, thead: { ignore: true }, tbody: { ignore: true },
  tr: { block: 'table_row' }, th: { block: 'table_header', getAttrs: cellAttrs }, td: { block: 'table_cell', getAttrs: cellAttrs },
};

// Markdown-it resolves reference links across the entire document. The adapter
// then reads one top-level block at a time, so a block with unfamiliar tokens
// can still be edited as its original Markdown.
const blockParser = new MarkdownParser(markdownSchema, { parse: (_text, env) => env.tokens }, parseRules);

function prepareTokens(tokens) {
  const result = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'inline' && tokens[index - 1]?.type === 'paragraph_open' && tokens[index - 2]?.type === 'list_item_open') {
      const first = token.children?.[0];
      const match = first?.type === 'text' && /^\[([ xX])\](?:\s+|$)/.exec(first.content);
      if (match) {
        tokens[index - 2].meta = { ...tokens[index - 2].meta, checked: match[1] !== ' ' };
        first.content = first.content.slice(match[0].length);
      }
    }
    if (token.type === 'th_close' || token.type === 'td_close') result.push({ type: 'paragraph_close', nesting: -1 });
    result.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') result.push({ type: 'paragraph_open', nesting: 1 });
  }
  return result;
}

function lineStarts(text) {
  const starts = [0];
  const re = /\r\n|\r|\n/g;
  for (let match; (match = re.exec(text));) starts.push(match.index + match[0].length);
  return starts;
}

const trimBlockEnd = text => text.replace(/(?:\r\n|\r|\n)[\t \r\n]*$/, '');
const rawNode = (text, kind = 'markdown') => markdownSchema.nodes.raw_block.create({ kind }, text ? markdownSchema.text(text) : null);

function parseDocument(text) {
  const starts = lineStarts(text);
  let tokens;
  try { tokens = prepareTokens(tokenizer.parse(text.replace(/\r\n?/g, '\n'), {})); }
  catch { return documentFromRecords(text, [{ node: rawNode(text), from: 0, to: text.length, raw: text }]); }
  const groups = [];
  for (let index = 0; index < tokens.length;) {
    const first = tokens[index];
    let end = index + 1;
    if (first.nesting > 0) {
      let depth = first.nesting;
      while (end < tokens.length && depth > 0) depth += tokens[end++].nesting;
    }
    if (first.map) groups.push({ tokens: tokens.slice(index, end), from: starts[first.map[0]] ?? text.length, to: starts[first.map[1]] ?? text.length });
    index = end;
  }
  const records = [];
  const addRawGap = (from, to) => {
    const gap = text.slice(from, to);
    if (!/\S/.test(gap)) return;
    const leading = /^[\t \r\n]*/.exec(gap)[0].length;
    const raw = trimBlockEnd(gap.slice(leading));
    const kind = /^\[[^\]\n]+\]:/.test(raw) ? 'reference' : 'markdown';
    records.push({ node: rawNode(raw, kind), from: from + leading, to: from + leading + raw.length, raw });
  };
  let end = 0;
  for (const group of groups) {
    addRawGap(end, group.from);
    const raw = trimBlockEnd(text.slice(group.from, group.to));
    let node;
    // Definitions nested in a quote or list do not produce tokens. Keeping that
    // enclosing block as Markdown makes the definition available when it is edited.
    const embeddedDefinition = ['blockquote_open', 'bullet_list_open', 'ordered_list_open'].includes(group.tokens[0]?.type)
      && /^(?:\s*>\s*)*(?:\s*(?:[-+*]|\d+[.)])\s+)?\s*\[[^\]\n]+\]:/m.test(raw);
    const itemWithoutParagraph = group.tokens.some((token, index) => token.type === 'list_item_open'
      && !['paragraph_open', 'list_item_close'].includes(group.tokens[index + 1]?.type));
    try {
      if (embeddedDefinition || itemWithoutParagraph) throw new Error('The block uses Markdown that needs its original text');
      const parsed = blockParser.parse('', { tokens: group.tokens });
      parsed.check();
      if (parsed.childCount !== 1) throw new Error('The token block has multiple children');
      node = parsed.firstChild;
    } catch { node = rawNode(raw); }
    records.push({ node, from: group.from, to: group.from + raw.length, raw });
    end = group.to;
  }
  addRawGap(end, text.length);
  return documentFromRecords(text, records);
}

function documentFromRecords(text, records) {
  if (!records.length) records.push({ node: markdownSchema.nodes.paragraph.create(), from: text.length, to: text.length, raw: '' });
  const doc = markdownSchema.nodes.doc.create(null, records.map(record => record.node));
  const gaps = [];
  let end = 0;
  for (const record of records) { gaps.push(text.slice(end, record.from)); end = record.to; }
  gaps.push(text.slice(end));
  return { doc, records, gaps };
}

export function parseMarkdown(text = '') { return parseDocument(String(text)).doc; }

function writeMath(state, node, block) {
  const { tex, equationNumber } = node.attrs;
  const delimiter = node.attrs.delimiter || (block ? '$$' : '$`');
  const closing = { '$`': '`$', '\\(': '\\)', '\\[': '\\]', '```math': '```' }[delimiter] || delimiter;
  // An empty TeX group leaves an empty formula valid in every supported syntax.
  let content = String(tex) || '{}';
  if (block && delimiter === '```math') content = `\n${content.replace(/^\n|\n$/g, '')}\n`;
  state.write(delimiter);
  state.text(content, false);
  state.write(closing + (block && equationNumber ? ` (${equationNumber})` : ''));
  if (block) state.closeBlock(node);
}

function serializeCell(cell) {
  // Markdown-it removes one backslash before every pipe while reading a table.
  // Adding one here also works for pipes inside code and TeX expressions.
  return serializer.serialize(markdownSchema.nodes.doc.create(null, cell.content))
    .replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function emphasisDelimiter(mark, parent, index, closing) {
  const markup = mark.attrs.markup || (mark.type.name === 'strong' ? '**' : '*');
  if (!markup.startsWith('_')) return markup;
  let first = index - (closing ? 1 : 0);
  let last = first + 1;
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--;
  while (last < parent.childCount && mark.isInSet(parent.child(last).marks)) last++;
  const before = first > 0 ? parent.child(first - 1) : null;
  const after = last < parent.childCount ? parent.child(last) : null;
  if ((before?.isText && /[\p{L}\p{N}_]$/u.test(before.text)) || (after?.isText && /^[\p{L}\p{N}_]/u.test(after.text))) {
    return mark.type.name === 'strong' ? '**' : '*';
  }
  return markup;
}

const serializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  heading(state, node) {
    if (node.attrs.level <= 2 && ['=', '-'].includes(node.attrs.markup)) {
      state.renderInline(node, false);
      state.write(`\n${node.attrs.level === 1 ? '===' : '---'}`);
      state.closeBlock(node);
    } else defaultMarkdownSerializer.nodes.heading(state, node);
  },
  code_block(state, node) {
    if (node.attrs.fence === '' && node.textContent && !/\n\s*$/.test(node.textContent)) {
      state.wrapBlock('    ', null, node, () => state.text(node.textContent, false));
      return;
    }
    const marker = String(node.attrs.fence || '```')[0] === '~' ? '~' : '`';
    const runs = node.textContent.match(marker === '`' ? /`+/g : /~+/g) || [];
    const length = Math.max(3, node.attrs.fence?.length || 0, ...runs.map(run => run.length + 1));
    const fence = marker.repeat(length);
    state.write(`${fence}${node.attrs.params || ''}\n`);
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },
  ordered_list(state, node) {
    const start = node.attrs.order || 1;
    const width = String(start + node.childCount - 1).length;
    const delimiter = node.attrs.delimiter === ')' ? ')' : '.';
    state.renderList(node, ' '.repeat(width + 2), index => `${String(start + index).padStart(width)}${delimiter} `);
  },
  list_item(state, node) {
    if (node.attrs.checked !== null) state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
  math_inline: (state, node) => writeMath(state, node, false),
  math_block: (state, node) => writeMath(state, node, true),
  raw_block(state, node) { state.text(node.textContent, false); state.closeBlock(node); },
  table(state, node) {
    const rows = [];
    node.forEach(row => {
      const cells = [];
      row.forEach(cell => cells.push(serializeCell(cell)));
      rows.push(`| ${cells.join(' | ')} |`);
    });
    const alignment = [];
    node.firstChild?.forEach(cell => alignment.push(({ left: ':---', center: ':---:', right: '---:' })[cell.attrs.align] || '---'));
    rows.splice(1, 0, `| ${alignment.join(' | ')} |`);
    state.text(rows.join('\n'), false);
    state.closeBlock(node);
  },
}, {
  ...defaultMarkdownSerializer.marks,
  em: { ...defaultMarkdownSerializer.marks.em, open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false), close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true) },
  strong: { ...defaultMarkdownSerializer.marks.strong, open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false), close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true) },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
}, { escapeExtraCharacters: /\$/g });

export function serializeMarkdown(doc) { return serializer.serialize(doc); }

function children(doc) {
  const result = [];
  doc.forEach(node => result.push(node));
  return result;
}

function matchRecords(records, nextNodes) {
  const matched = new Array(nextNodes.length).fill(null);
  const used = new Set();
  const byIdentity = new Map();
  records.forEach((record, index) => {
    const indices = byIdentity.get(record.node) || [];
    indices.push(index);
    byIdentity.set(record.node, indices);
  });
  nextNodes.forEach((node, index) => {
    const oldIndex = byIdentity.get(node)?.shift();
    if (oldIndex !== undefined) { matched[index] = { index: oldIndex, unchanged: true }; used.add(oldIndex); }
  });
  const byContent = new Map();
  records.forEach((record, index) => {
    if (used.has(index)) return;
    const key = JSON.stringify(record.node.toJSON());
    const indices = byContent.get(key) || [];
    indices.push(index);
    byContent.set(key, indices);
  });
  nextNodes.forEach((node, index) => {
    if (matched[index]) return;
    const oldIndex = byContent.get(JSON.stringify(node.toJSON()))?.shift();
    if (oldIndex !== undefined) { matched[index] = { index: oldIndex, unchanged: true }; used.add(oldIndex); }
  });
  // Changed blocks between two unchanged neighbours inherit their original
  // whitespace. A split or an inserted block gets the usual blank line.
  let oldStart = 0;
  let nextStart = 0;
  for (let index = 0; index <= nextNodes.length; index++) {
    if (index < nextNodes.length && !matched[index]) continue;
    const oldEnd = index === nextNodes.length ? records.length : matched[index].index;
    const available = [];
    for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex++) if (!used.has(oldIndex)) available.push(oldIndex);
    for (let cursor = nextStart; cursor < index && available.length; cursor++) {
      const oldIndex = available.shift();
      matched[cursor] = { index: oldIndex, unchanged: false };
      used.add(oldIndex);
    }
    if (index < nextNodes.length) { oldStart = matched[index].index + 1; nextStart = index + 1; }
  }
  return matched;
}

function countLineBreaks(text) { return (text.match(/\r\n|\r|\n/g) || []).length; }

function appendChange(changes, oldText, newText, oldOffset) {
  if (oldText === newText) return;
  let from = 0;
  while (from < oldText.length && from < newText.length && oldText[from] === newText[from]) from++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > from && newEnd > from && oldText[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd--; }
  changes.push({ from: oldOffset + from, to: oldOffset + oldEnd, insert: newText.slice(from, newEnd) });
}

function sourceChanges(oldText, newText, oldRecords, nextRecords) {
  const changes = [];
  let oldEnd = 0;
  let nextEnd = 0;
  for (const record of nextRecords) {
    if (!record.unchanged) continue;
    const old = oldRecords[record.oldIndex];
    if (old.from < oldEnd) continue;
    appendChange(changes, oldText.slice(oldEnd, old.from), newText.slice(nextEnd, record.from), oldEnd);
    oldEnd = old.to;
    nextEnd = record.to;
  }
  appendChange(changes, oldText.slice(oldEnd), newText.slice(nextEnd), oldEnd);
  return changes;
}

// Positions use the same UTF-16 offsets as ProseMirror and CodeMirror. Text
// matches give exact positions in ordinary prose; the surrounding Markdown
// punctuation maps to the nearest text or block boundary.
function recordPoints(record, pmStart) {
  const points = [{ pm: pmStart, source: record.from }];
  let cursor = 0;
  const add = (pm, source) => points.push({ pm, source: record.from + Math.min(record.raw.length, Math.max(0, source)), content: true });
  record.node.descendants((node, position) => {
    const pm = pmStart + position + 1;
    if (node.isText) {
      const found = record.raw.indexOf(node.text, cursor);
      if (found >= 0) {
        add(pm, found);
        add(pm + node.text.length, found + node.text.length);
        cursor = found + node.text.length;
      } else {
        for (let offset = 0; offset < node.text.length; offset++) {
          const character = node.text[offset];
          let foundCharacter = record.raw.indexOf(character, cursor);
          if (/\s/.test(character)) {
            const whitespace = /\s/.exec(record.raw.slice(cursor));
            if (whitespace) foundCharacter = cursor + whitespace.index;
          }
          if (foundCharacter < 0) foundCharacter = cursor;
          add(pm + offset, foundCharacter);
          cursor = Math.min(record.raw.length, foundCharacter + 1);
          add(pm + offset + 1, cursor);
        }
      }
    } else if (node.type.name === 'math_inline') {
      const opening = node.attrs.delimiter || '$`';
      const start = record.raw.indexOf(opening, cursor);
      const closing = { '$`': '`$', '\\(': '\\)' }[opening] || opening;
      const end = start < 0 ? -1 : record.raw.indexOf(closing, start + opening.length + node.attrs.tex.length);
      if (start >= 0) {
        add(pm, start);
        cursor = end >= 0 ? end + closing.length : start + opening.length + node.attrs.tex.length;
        add(pm + 1, cursor);
      }
    } else if (node.type.name === 'image') {
      const start = record.raw.indexOf('![', cursor);
      if (start >= 0) {
        add(pm, start);
        const close = record.raw.indexOf(')', start + 2);
        cursor = close < 0 ? start + 2 : close + 1;
        add(pm + 1, cursor);
      }
    }
  });
  points.push({ pm: pmStart + record.node.nodeSize, source: record.to });
  return points;
}

function interpolate(points, value, from, to) {
  let low = 0;
  let high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle][from] <= value) low = middle + 1; else high = middle; }
  if (!low) return points[0][to];
  const left = points[low - 1];
  if (from === 'source' && left[from] === value) {
    for (let index = low - 1; index >= 0 && points[index][from] === value; index--) if (points[index].content) return points[index][to];
  }
  if (low === points.length || left[from] === value) return left[to];
  const right = points[low];
  return Math.round(left[to] + (right[to] - left[to]) * (value - left[from]) / (right[from] - left[from]));
}

function referenceText(records) {
  return records.filter(record => record.node.type.name === 'raw_block' && /\[[^\]\n]+\]:/.test(record.raw)).map(record => record.raw).join('\u0000');
}

export class MarkdownSource {
  constructor(text = '') {
    this.text = String(text);
    const parsed = parseDocument(this.text);
    this.doc = parsed.doc;
    this.records = parsed.records;
    this.gaps = parsed.gaps;
    this.lineEnding = /\r\n/.test(this.text) ? '\r\n' : /\r/.test(this.text) ? '\r' : '\n';
    this.positions = null;
  }

  update(nextDoc) {
    if (nextDoc.eq(this.doc)) { this.doc = nextDoc; return { text: this.text, changes: [], doc: nextDoc }; }
    nextDoc.check();
    const nextNodes = children(nextDoc);
    const matches = matchRecords(this.records, nextNodes);
    const nextRecords = [];
    const gaps = [];
    let text = '';
    for (let index = 0; index < nextNodes.length; index++) {
      const node = nextNodes[index];
      const match = matches[index];
      const old = match && this.records[match.index];
      const raw = match?.unchanged ? old.raw : serializeMarkdown(markdownSchema.nodes.doc.create(null, [node])).replace(/\r\n?|\n/g, this.lineEnding);
      let gap;
      if (!index) gap = this.gaps[0];
      else {
        const previous = matches[index - 1];
        const adjacent = previous && match && previous.index + 1 === match.index;
        gap = match ? this.gaps[match.index] : this.lineEnding.repeat(2);
        const sameTypes = adjacent && this.records[previous.index].node.type === nextNodes[index - 1].type && old.node.type === node.type;
        if (!sameTypes) {
          const trailing = /[\t \r\n]*$/.exec(text)[0];
          const leading = /^[\t \r\n]*/.exec(raw)[0];
          const missing = 2 - countLineBreaks(trailing + gap + leading);
          if (missing > 0) gap += this.lineEnding.repeat(missing);
        }
      }
      gaps.push(gap);
      text += gap;
      const from = text.length;
      text += raw;
      nextRecords.push({ node, raw, from, to: text.length, oldIndex: match?.index, unchanged: Boolean(match?.unchanged) });
    }
    const tail = this.gaps[this.gaps.length - 1];
    gaps.push(tail);
    text += tail;
    const changes = sourceChanges(this.text, text, this.records, nextRecords);
    const referencesChanged = referenceText(this.records) !== referenceText(nextRecords);
    this.text = text;
    this.doc = nextDoc;
    this.records = nextRecords;
    this.gaps = gaps;
    this.positions = null;
    let mapPosition;
    if (referencesChanged) {
      const parsed = parseDocument(text);
      const byRange = new Map(parsed.records.map(record => [`${record.from}:${record.to}`, record.node]));
      const refreshed = nextRecords.map(record => {
        if (!record.unchanged || record.node.type.name === 'raw_block') return record.node;
        return byRange.get(`${record.from}:${record.to}`) || record.node;
      });
      if (refreshed.some((node, index) => !node.eq(nextNodes[index]))) {
        const previousPoints = this.positionPoints();
        this.records = nextRecords.map((record, index) => ({ ...record, node: refreshed[index] }));
        this.doc = docWithNodes(refreshed);
        this.positions = null;
        const nextPoints = this.positionPoints();
        mapPosition = position => interpolate(nextPoints, interpolate(previousPoints, position, 'pm', 'source'), 'source', 'pm');
      }
    }
    return { text, changes, doc: this.doc, ...(mapPosition ? { mapPosition } : {}) };
  }

  positionPoints() {
    if (!this.positions) {
      this.positions = [];
      let pmStart = 0;
      for (const record of this.records) {
        for (const point of recordPoints(record, pmStart)) this.positions.push(point);
        pmStart += record.node.nodeSize;
      }
    }
    return this.positions;
  }

  sourceOffsetAt(pmPosition) {
    return interpolate(this.positionPoints(), Math.min(this.doc.content.size, Math.max(0, Number(pmPosition) || 0)), 'pm', 'source');
  }

  positionAtSource(sourceOffset) {
    return interpolate(this.positionPoints(), Math.min(this.text.length, Math.max(0, Number(sourceOffset) || 0)), 'source', 'pm');
  }
}

function docWithNodes(content) { return markdownSchema.nodes.doc.create(null, content); }
