import { EditorState, TextSelection, NodeSelection, Selection, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Fragment, Slice, Mark } from 'prosemirror-model';
import { baseKeymap, chainCommands, toggleMark, setBlockType, wrapIn, lift, exitCode, newlineInCode } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { inputRules, InputRule, wrappingInputRule, textblockTypeInputRule, undoInputRule } from 'prosemirror-inputrules';
import { wrapInList, splitListItemKeepMarks, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { tableEditing, TableView, isInTable, goToNextCell, addRowBefore, addRowAfter, deleteRow,
  addColumnBefore, addColumnAfter, deleteColumn, deleteTable } from 'prosemirror-tables';
import { ChangeSet, Text } from '@codemirror/state';
import katex from 'katex';
import { MarkdownSource, markdownSchema, parseMarkdown } from './markdown-rich-document.js';
import { resolveMarkdownReference } from './markdown-preview.js';
import { attachFontZoom, prepareRichEditorResize } from './editor-zoom.js';
import { t, getLanguage, onLanguageChange, translateElements } from './i18n.js';

const imageData = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;
const imageExtensions = /\.(?:png|apng|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const clamp = (value, maximum) => Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0));
const tableCommands = { addRowBefore, addRowAfter, deleteRow, addColumnBefore, addColumnAfter, deleteColumn, deleteTable };

function element(document, tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function labelled(node, key) {
  node.setAttribute('aria-label', t(key)); node.setAttribute('data-i18n-aria-label', key);
  return node;
}
function selectionAt(document, anchor, head = anchor) {
  const $anchor = document.resolve(clamp(anchor, document.content.size));
  const $head = document.resolve(clamp(head, document.content.size));
  return anchor === head ? Selection.near($head) : TextSelection.between($anchor, $head);
}
function sourceChanges(changes) {
  const result = [];
  changes.iterChanges((from, to, _from, _to, insert) => result.push({ from, to, insert: insert.toString() }));
  return result;
}
function changesBetween(before, after) {
  let from = 0, beforeEnd = before.length, afterEnd = after.length;
  while (from < beforeEnd && from < afterEnd && before[from] === after[from]) from++;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  return ChangeSet.of(from === beforeEnd && from === afterEnd ? [] : [{ from, to: beforeEnd, insert: after.slice(from, afterEnd) }], before.length);
}
function languageName(value) {
  const language = String(value || '').trim();
  if (language.length > 50 || /[\s`<>]/.test(language)) throw new Error('code-language');
  return language;
}
function linkAddress(value) {
  const href = String(value || '').trim();
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (!href || /[\u0000-\u001f\u007f]/.test(href) || (scheme && !['http', 'https', 'mailto'].includes(scheme))) throw new Error('link-url');
  return href.replace(/[\\\s<>()[\]]/g, character => encodeURIComponent(character).replace(/[!'()*]/g, part => `%${part.charCodeAt(0).toString(16).toUpperCase()}`));
}
function closestNode($position, predicate) {
  for (let depth = $position.depth; depth > 0; depth--) {
    const node = $position.node(depth);
    if (predicate(node)) return { node, depth, position: $position.before(depth) };
  }
  return null;
}

class MathView {
  constructor(node, view, getPos, editor) {
    Object.assign(this, { node, view, getPos, editor, composing: false });
    const document = editor.document;
    this.dom = element(document, node.isInline ? 'span' : 'div', `rich-math ${node.isInline ? 'rich-math-inline' : 'rich-math-block'}`);
    this.dom.contentEditable = 'false';
    this.preview = labelled(element(document, 'button', 'rich-math-preview'), '数式を編集'); this.preview.type = 'button';
    this.rendered = element(document, 'span', 'rich-math-rendered');
    this.number = element(document, 'span', 'rich-equation-number');
    this.preview.append(this.rendered, this.number);
    this.field = element(document, 'span', 'rich-math-editor'); this.field.hidden = true;
    this.input = labelled(element(document, 'textarea', 'rich-math-input'), '数式の TeX');
    this.input.rows = node.isInline ? 2 : 4; this.input.spellcheck = false; this.input.value = node.attrs.tex;
    this.done = element(document, 'button', 'button button-small', t('完了')); this.done.type = 'button'; this.done.dataset.i18n = '完了';
    this.field.append(this.input, this.done); this.dom.append(this.preview, this.field);
    this.preview.addEventListener('click', () => this.open());
    this.done.addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this.commit());
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.commit(); editor.flushPendingText(); });
    this.input.addEventListener('keydown', event => {
      if (event.isComposing || this.composing) return;
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
        event.preventDefault(); event.stopPropagation(); this.close();
      }
    });
    editor.embeddedViews.add(this); this.setReadOnly(editor.readOnly); this.render();
  }
  open(selectAll = false) {
    const position = this.getPos();
    if (!Number.isInteger(position)) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, position)));
    this.field.hidden = false; this.dom.classList.add('is-editing');
    this.input.focus(); if (selectAll) this.input.select();
  }
  close() {
    this.commit(); this.field.hidden = true; this.dom.classList.remove('is-editing'); this.editor.focus();
  }
  commit() {
    if (this.editor.readOnly || this.node.attrs.tex === this.input.value) return;
    const position = this.getPos();
    if (!Number.isInteger(position)) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, tex: this.input.value }).setMeta('richUserEvent', 'input.type'));
  }
  render() {
    this.number.textContent = this.node.attrs.equationNumber ? `(${this.node.attrs.equationNumber})` : '';
    try {
      katex.render(this.node.attrs.tex || '\\text{…}', this.rendered, {
        displayMode: Boolean(this.node.attrs.displayMode), trust: false, throwOnError: false,
        strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: {},
      });
    } catch { this.rendered.textContent = this.node.attrs.tex; }
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.tex !== this.node.attrs.tex || node.attrs.equationNumber !== this.node.attrs.equationNumber || node.attrs.displayMode !== this.node.attrs.displayMode;
    this.node = node;
    if (!this.composing && this.input.value !== node.attrs.tex) this.input.value = node.attrs.tex;
    if (changed) this.render();
    return true;
  }
  setReadOnly(value) { this.input.readOnly = value; }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  stopEvent() { return true; }
  ignoreMutation() { return true; }
  destroy() { this.editor.embeddedViews.delete(this); }
}

class CodeView {
  constructor(node, view, getPos, editor) {
    Object.assign(this, { node, view, getPos, editor, composing: false });
    const document = editor.document;
    this.dom = element(document, 'div', node.type.name === 'raw_block' ? 'rich-code-block rich-raw-block' : 'rich-code-block');
    this.header = element(document, 'div', 'rich-code-heading'); this.header.contentEditable = 'false';
    if (node.type.name === 'raw_block') {
      this.header.textContent = 'Markdown';
    } else {
      this.language = labelled(element(document, 'input', 'rich-code-language'), '言語 (省略可)');
      this.language.type = 'text'; this.language.maxLength = 50; this.language.spellcheck = false;
      this.language.value = node.attrs.params || ''; this.language.placeholder = t('言語 (省略可)');
      this.language.dataset.i18nPlaceholder = '言語 (省略可)';
      this.header.append(this.language);
      this.language.addEventListener('input', () => {
        if (editor.readOnly) return;
        try {
          const params = languageName(this.language.value); this.language.setCustomValidity(''); this.language.removeAttribute('aria-invalid');
          const position = this.getPos();
          if (Number.isInteger(position) && params !== this.node.attrs.params) view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, params }).setMeta('richUserEvent', 'input.type'));
        } catch {
          this.language.setCustomValidity(t('言語の名前は空白や backtick を含めずに入力してください．')); this.language.setAttribute('aria-invalid', 'true');
        }
      });
      this.language.addEventListener('compositionstart', () => { this.composing = true; });
      this.language.addEventListener('compositionend', () => { this.composing = false; editor.flushPendingText(); });
    }
    const pre = element(document, 'pre'); this.contentDOM = element(document, 'code'); pre.append(this.contentDOM);
    this.dom.append(this.header, pre); editor.embeddedViews.add(this); this.setReadOnly(editor.readOnly);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.language && !this.composing && this.editor.document.activeElement !== this.language && this.language.value !== (node.attrs.params || '')) this.language.value = node.attrs.params || '';
    return true;
  }
  setReadOnly(value) { if (this.language) this.language.readOnly = value; }
  stopEvent(event) { return this.header.contains(event.target); }
  ignoreMutation(record) { return record.type !== 'selection' && this.header.contains(record.target); }
  destroy() { this.editor.embeddedViews.delete(this); }
}

class ListItemView {
  constructor(node, view, getPos, editor) {
    Object.assign(this, { node, view, getPos, editor });
    this.dom = element(editor.document, 'li');
    this.check = labelled(element(editor.document, 'input', 'rich-task-checkbox'), 'タスクの完了');
    this.check.type = 'checkbox'; this.check.contentEditable = 'false';
    this.contentDOM = element(editor.document, 'div', 'rich-list-content'); this.dom.append(this.check, this.contentDOM);
    this.check.addEventListener('change', () => {
      if (editor.readOnly) { this.check.checked = Boolean(this.node.attrs.checked); return; }
      const position = this.getPos();
      if (Number.isInteger(position)) view.dispatch(view.state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, checked: this.check.checked }).setMeta('richUserEvent', 'input.format'));
    });
    editor.embeddedViews.add(this); this.update(node); this.setReadOnly(editor.readOnly);
  }
  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node; this.check.hidden = node.attrs.checked == null; this.check.checked = Boolean(node.attrs.checked);
    this.dom.classList.toggle('rich-task-item', node.attrs.checked != null); this.dom.classList.toggle('is-checked', node.attrs.checked === true);
    return true;
  }
  setReadOnly(value) { this.check.disabled = value; }
  stopEvent(event) { return event.target === this.check; }
  ignoreMutation(record) { return record.type !== 'selection' && record.target === this.check; }
  destroy() { this.editor.embeddedViews.delete(this); }
}

class ImageView {
  constructor(node, view, getPos, editor) {
    Object.assign(this, { node, editor, version: 0, asset: null, referenceKey: '' });
    this.dom = element(editor.document, 'span', 'rich-image'); this.dom.contentEditable = 'false';
    editor.imageViews.add(this); this.refreshSource();
  }
  refreshSource({ force = false } = {}) {
    const { src, alt, title } = this.node.attrs;
    const key = `${this.editor.projectRoot}\n${this.editor.path}\n${src}`;
    if (!force && key === this.referenceKey) {
      const image = this.dom.querySelector('img'); if (image) { image.alt = alt || ''; image.title = title || ''; }
      return;
    }
    this.referenceKey = key; const version = ++this.version;
    this.editor.releaseImage(this.asset); this.asset = null;
    const resolved = resolveMarkdownReference(src, this.editor.path);
    if (imageData.test(src) || (resolved?.kind === 'local' && imageExtensions.test(resolved.path))) {
      const image = element(this.editor.document, 'img'); image.alt = alt || ''; image.title = title || ''; image.draggable = false;
      this.dom.replaceChildren(image); this.dom.dataset.state = 'loading';
      if (imageData.test(src)) { image.src = src; this.dom.dataset.state = 'ready'; return; }
      this.asset = this.editor.acquireImage(resolved.path);
      this.asset.promise.then(url => {
        if (!url || this.version !== version || this.editor.destroyed) return;
        image.src = url; this.dom.dataset.state = 'ready';
      }).catch(error => {
        if (this.version !== version || error.name === 'AbortError' || this.editor.destroyed) return;
        this.dom.dataset.state = 'error'; image.alt ||= resolved.path; image.title = String(error.message || error);
        this.editor.reportError(error);
      });
    } else {
      const link = element(this.editor.document, resolved ? 'a' : 'span', 'rich-image-link', alt || src || t('画像'));
      if (resolved) this.editor.prepareLink(link, src);
      this.dom.replaceChildren(link); this.dom.dataset.state = 'link';
    }
  }
  update(node) { if (node.type !== this.node.type) return false; this.node = node; this.refreshSource(); return true; }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  ignoreMutation() { return true; }
  destroy() { this.version++; this.editor.releaseImage(this.asset); this.editor.imageViews.delete(this); }
}

function escapedAt(text, index) {
  let backslashes = 0;
  while (index > 0 && text[--index] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

// Defer formatting while an opening math or code delimiter is still being typed.
// Existing inline nodes occupy one character, matching ProseMirror positions.
function pendingInlineDelimiter(text) {
  let closing = '', code = false;
  for (let index = 0; index < text.length;) {
    if (closing) {
      if (code && text[index] === '`') {
        const run = /^`+/.exec(text.slice(index))[0];
        if (run === closing) { closing = ''; code = false; }
        index += run.length;
      } else if (!code && text.startsWith(closing, index) && !escapedAt(text, index)) {
        index += closing.length; closing = '';
      } else index++;
      continue;
    }
    if (text.startsWith('\\(', index) || text.startsWith('\\[', index)) {
      closing = text[index + 1] === '(' ? '\\)' : '\\]'; index += 2;
    } else if (text[index] === '\\') index += 2;
    else if (text[index] === '`') {
      closing = /^`+/.exec(text.slice(index))[0]; code = true; index += closing.length;
    } else if (text[index] === '$' && !/\s/.test(text[index + 1] || '')) {
      const opening = text.startsWith('$`', index) ? '$`' : text.startsWith('$$', index) ? '$$' : '$';
      closing = opening === '$`' ? '`$' : opening; index += opening.length;
    } else index++;
  }
  return Boolean(closing);
}

function inlineInputContext(state, match, start, end, inserted) {
  const from = start + match[0].length - inserted.length;
  const $from = state.doc.resolve(from), $end = state.doc.resolve(end);
  if (!$from.sameParent($end) || (state.storedMarks || $from.marks()).some(mark => mark.type.spec.code)) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc') + inserted;
  let syntax = before;
  $from.parent.forEach((node, offset) => {
    if (offset < $from.parentOffset && node.marks.some(mark => mark.type.spec.code)) {
      const length = Math.min(node.nodeSize, $from.parentOffset - offset);
      syntax = syntax.slice(0, offset) + '\ufffc'.repeat(length) + syntax.slice(offset + length);
    }
  });
  return { from, start: $from.start(), before, syntax,
    after: $end.parent.textBetween($end.parentOffset, $end.parent.content.size, '', '\ufffc') };
}

function parsedInlineCandidate(context, start) {
  const previous = [...context.before.slice(Math.max(0, start - 2), start)].at(-1) || '';
  const following = [...context.after.slice(0, 2)][0] || '';
  // The surrounding characters give Markdown-it the actual emphasis and dollar
  // boundaries. The outer text makes the input a paragraph even at line start.
  const prefix = `a ${previous}`, suffix = `${following} z`;
  const parsed = parseMarkdown(prefix + context.before.slice(start) + suffix);
  const paragraph = parsed.firstChild;
  if (parsed.childCount !== 1 || paragraph.type !== markdownSchema.nodes.paragraph || paragraph.content.size < prefix.length + suffix.length) return null;
  return paragraph.content.cut(prefix.length, paragraph.content.size - suffix.length);
}

function mathInputRule() {
  return new InputRule(/[^\n]*(?:\$|\\\))$/, (state, match, start, end, inserted) => {
    const context = inlineInputContext(state, match, start, end, inserted);
    if (!context) return null;
    const text = context.before;
    const opening = text.endsWith('`$') ? '$`' : text.endsWith('\\)') ? '\\(' : '$';
    const closing = opening === '$`' ? '`$' : opening === '\\(' ? '\\)' : '$';
    if (opening === '$' && text.endsWith('$$')) return null;
    for (let index = Math.max(0, text.length - 500); index < text.length - opening.length - closing.length; index++) {
      if (!text.startsWith(opening, index) || escapedAt(text, index) || pendingInlineDelimiter(context.syntax.slice(0, index))) continue;
      if (context.syntax.slice(index) !== text.slice(index) || text.slice(index).includes('\ufffc')) continue;
      if (opening === '$' && (text[index - 1] === '$' || text[index + 1] === '$' || text[index + 1] === '`')) continue;
      const parsed = parsedInlineCandidate(context, index);
      if (parsed?.childCount !== 1 || parsed.firstChild.type !== markdownSchema.nodes.math_inline || parsed.firstChild.attrs.delimiter !== opening) continue;
      const from = context.start + index;
      const transaction = state.tr.insertText(inserted, context.from, end);
      const marks = state.storedMarks || transaction.doc.nodeAt(from)?.marks || [];
      return transaction.replaceWith(from, context.start + text.length, parsed.firstChild.mark(marks)).setMeta('richUserEvent', 'input.format');
    }
    return null;
  }, { inCodeMark: true });
}

function markInputRule() {
  return new InputRule(/[^\n]*[*_~`]$/, (state, match, start, end, inserted) => {
    const context = inlineInputContext(state, match, start, end, inserted);
    if (!context) return null;
    const text = context.before, closing = /([*_~`])\1*$/.exec(text)[0];
    const types = closing[0] === '`' ? ['code'] : closing === '~~' ? ['strike']
      : ['*', '_'].includes(closing[0]) && closing.length <= 3
        ? closing.length === 3 ? ['em', 'strong'] : [closing.length === 2 ? 'strong' : 'em'] : [];
    if (!types.length) return null;
    for (let index = Math.max(0, text.length - 500); index < text.length - 2 * closing.length; index++) {
      if (!text.startsWith(closing, index) || text[index - 1] === closing[0] || text[index + closing.length] === closing[0] || escapedAt(text, index) || pendingInlineDelimiter(context.syntax.slice(0, index))) continue;
      if (context.syntax.slice(index) !== text.slice(index)) continue;
      const parsed = parsedInlineCandidate(context, index);
      if (!parsed?.childCount) continue;
      const marks = types.map(name => parsed.firstChild.marks.find(mark => mark.type === markdownSchema.marks[name]));
      if (marks.some(mark => !mark)) continue;
      let allMarked = true;
      parsed.forEach(node => { if (marks.some(mark => !mark.isInSet(node.marks))) allMarked = false; });
      if (!allMarked) continue;
      const from = context.start + index;
      let transaction;
      if (closing[0] === '`') {
        transaction = state.tr.insertText(inserted, context.from, end);
        const inherited = state.storedMarks || transaction.doc.nodeAt(from)?.marks || [];
        transaction.replaceWith(from, context.start + text.length, markdownSchema.text(parsed.textBetween(0, parsed.size), [...inherited.filter(mark => mark.type !== markdownSchema.marks.code), ...marks]));
      } else {
        transaction = state.tr.insertText(inserted, context.from, end);
        const to = context.start + text.length, original = transaction.doc.slice(from, to).content;
        if (original.childCount === 1 && original.firstChild.isText) {
          const content = [];
          parsed.forEach(node => {
            let combined = original.firstChild.marks;
            for (const mark of node.marks) combined = mark.addToSet(combined);
            content.push(node.mark(combined));
          });
          transaction.replaceWith(from, to, Fragment.fromArray(content));
        } else {
          // Earlier input rules may already have formatted part of the text or
          // inserted an inline formula. Apply the outer mark to those nodes.
          const closingFrom = to - closing.length;
          transaction.delete(closingFrom, to).delete(from, from + closing.length);
          for (const mark of marks) transaction.addMark(from, closingFrom - closing.length, mark);
        }
      }
      for (const mark of marks) transaction.removeStoredMark(mark.type);
      return transaction.setMeta('richUserEvent', 'input.format');
    }
    return null;
  }, { inCodeMark: true });
}

function horizontalRuleTransaction(state, text, end) {
  const { $from } = state.selection, { nodes } = markdownSchema;
  if ($from.parent.type !== nodes.paragraph || end !== $from.end() || !/^ {0,3}(?:-{3,}|_{3,}|\*{3,})[ \t]*$/.test(text)) return null;
  if ((state.storedMarks || $from.marks()).some(mark => mark.type.spec.code)) return null;
  let code = false;
  $from.parent.forEach(node => { if (node.marks.some(mark => mark.type.spec.code)) code = true; });
  if (code) return null;
  const parent = $from.node(-1), index = $from.index(-1), paragraph = nodes.paragraph.create();
  const rule = nodes.horizontal_rule.create({ markup: text.trim() });
  const content = parent.type === nodes.list_item && index === 0 ? [paragraph, rule, paragraph] : [rule, paragraph];
  const replacement = Fragment.fromArray(content);
  if (!parent.canReplace(index, index + 1, replacement)) return null;
  const from = $from.before(), transaction = state.tr.replaceWith(from, $from.after(), replacement);
  transaction.setSelection(TextSelection.create(transaction.doc, from + replacement.size - 1));
  return transaction.setMeta('richUserEvent', 'input.format');
}

export class MarkdownRichEditor {
  constructor(options) {
    this.options = options; this.host = options.host; this.document = this.host.ownerDocument; this.window = this.document.defaultView;
    this.path = options.path || ''; this.projectRoot = options.projectRoot || ''; this.token = options.token || '';
    this.source = new MarkdownSource(String(options.text || '')); this.readOnly = false; this.destroyed = false;
    this.assets = new Map(); this.imageViews = new Set(); this.embeddedViews = new Set(); this.pendingExternal = null;
    this.host.classList.add('markdown-rich-editor'); this.host.dataset.testid = 'markdown-rich-editor';
    this.tools = this.createTableTools(); this.mount = element(this.document, 'div', 'rich-document-mount');
    this.host.replaceChildren(this.tools, this.mount);
    this.view = new EditorView(this.mount, {
      state: EditorState.create({ doc: this.source.doc, plugins: this.plugins() }),
      dispatchTransaction: transaction => this.dispatchTransaction(transaction),
      editable: () => !this.readOnly,
      attributes: { class: 'markdown-rich-document', role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('Markdown の直接編集'), spellcheck: 'false' },
      nodeViews: {
        math_inline: (node, view, getPos) => new MathView(node, view, getPos, this),
        math_block: (node, view, getPos) => new MathView(node, view, getPos, this),
        code_block: (node, view, getPos) => new CodeView(node, view, getPos, this),
        raw_block: (node, view, getPos) => new CodeView(node, view, getPos, this),
        list_item: (node, view, getPos) => new ListItemView(node, view, getPos, this),
        image: (node, view, getPos) => new ImageView(node, view, getPos, this),
        table: node => new TableView(node, 80),
      },
      markViews: { link: mark => { const dom = element(this.document, 'a'); this.prepareLink(dom, mark.attrs.href); if (mark.attrs.title) dom.title = mark.attrs.title; return { dom }; } },
      handlePaste: (view, event) => this.handlePaste(view, event),
      handleDrop: (view, event, _slice, moved) => this.handleDrop(view, event, moved),
      handleDOMEvents: {
        compositionend: () => { this.flushPendingText(); return false; },
        dragover: (_view, event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); return true; } return false; },
        click: (_view, event) => this.handleLink(event),
      },
    });
    this.focusListener = () => this.options.onFocus?.();
    this.keyListener = event => this.handleShortcut(event);
    this.host.addEventListener('focusin', this.focusListener); this.host.addEventListener('keydown', this.keyListener, true);
    this.stopZoom = options.zoom ? attachFontZoom(this.host, {
      ...options.zoom,
      isComposing: () => this.composing || options.zoom.isComposing?.(),
      captureSelection: event => this.captureZoomSelection(event.target),
      restoreSelection: saved => this.restoreZoomSelection(saved),
    }) : null;
    this.stopLanguage = onLanguageChange(() => {
      translateElements(this.host); this.view.dom.setAttribute('aria-label', t('Markdown の直接編集')); this.updateTableTools();
    });
    this.updateTableTools(); this.notifyStateChange();
  }
  get text() { return this.pendingExternal?.text ?? this.source.text; }
  get composing() { return this.view?.composing || [...this.embeddedViews].some(view => view.composing); }
  prepareResize(origin = null) { return prepareRichEditorResize(this.view, this.host, origin); }
  captureZoomSelection(target) {
    const field = target?.closest?.('textarea, input'), { doc, selection, storedMarks } = this.view.state;
    return { document: doc, selection, storedMarks,
      field: Number.isInteger(field?.selectionStart) ? { element: field, value: field.value,
        start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection } : null };
  }
  restoreZoomSelection(saved) {
    if (this.destroyed || this.view.state.doc !== saved.document) return;
    const { state } = this.view;
    const sameMarks = state.storedMarks === saved.storedMarks || (state.storedMarks && saved.storedMarks && Mark.sameSet(state.storedMarks, saved.storedMarks));
    if (!state.selection.eq(saved.selection) || !sameMarks) {
      this.view.dispatch(state.tr.setSelection(saved.selection).setStoredMarks(saved.storedMarks).setMeta('addToHistory', false));
    }
    const field = saved.field;
    if (field?.element.isConnected && field.element.value === field.value) field.element.setSelectionRange(field.start, field.end, field.direction);
  }
  reportError(error) { this.options.onError?.(error); }
  notifyStateChange() { this.options.onStateChange?.(); }

  plugins() {
    const { nodes } = markdownSchema;
    const rules = [
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list),
      wrappingInputRule(/^(\d+)[.)]\s$/, nodes.ordered_list, match => ({ order: Number(match[1]) }), (match, node) => node.childCount + node.attrs.order === Number(match[1])),
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, match => ({ level: match[1].length, markup: '#' })),
      textblockTypeInputRule(/^(`{3,}|~{3,})([^\s`~]*)\s$/, nodes.code_block, match => ({ params: match[2], fence: match[1] })),
      new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
        const item = closestNode(state.selection.$from, node => node.type === nodes.list_item);
        if (!item) return null;
        return state.tr.delete(start, end).setNodeMarkup(item.position, undefined, { ...item.node.attrs, checked: match[1] !== ' ' });
      }),
      new InputRule(/^ {0,3}(?:-{3,}|_{3,}|\*{3,})[ \t]$/, (state, match, _start, end) => horizontalRuleTransaction(state, match[0], end), { inCodeMark: false }),
      mathInputRule(),
      markInputRule(),
    ];
    const rulesPlugin = inputRules({ rules });
    const enter = (state, dispatch) => {
      if (isInTable(state)) { this.tab(state, dispatch, 1); return true; }
      const { $from, empty } = state.selection;
      const rule = empty && horizontalRuleTransaction(state, $from.parent.textContent, state.selection.to);
      if (rule) {
        if (dispatch) dispatch(rule.setMeta(rulesPlugin, { transform: rule, from: state.selection.from, to: state.selection.to, text: '' }));
        return true;
      }
      const fence = empty && $from.parent.type === nodes.paragraph && $from.parentOffset === $from.parent.content.size && $from.parent.textContent.match(/^(`{3,}|~{3,})([^\s`~]*)$/);
      if (fence) {
        if (dispatch) dispatch(state.tr.delete($from.start(), $from.end()).setBlockType($from.start(), $from.start(), nodes.code_block, { params: fence[2], fence: fence[1] }));
        return true;
      }
      const item = closestNode($from, node => node.type === nodes.list_item);
      return splitListItemKeepMarks(nodes.list_item, item?.node.attrs.checked == null ? undefined : { ...item.node.attrs, checked: false })(state, dispatch);
    };
    const moveToDocumentBoundary = (direction, extend = false) => (state, dispatch) => {
      const boundary = direction < 0 ? Selection.atStart(state.doc) : Selection.atEnd(state.doc);
      const selection = extend
        ? TextSelection.between(state.selection.$anchor, direction < 0 ? boundary.$from : boundary.$to, direction)
        : boundary;
      if (dispatch) dispatch(state.tr.setSelection(selection).scrollIntoView());
      return true;
    };
    return [
      rulesPlugin,
      keymap({
        'Mod-b': () => this.command('bold'), 'Mod-i': () => this.command('italic'), 'Mod-Shift-x': () => this.command('strike'),
        'Mod-`': () => this.command('inlineCode'),
        'Mod-Home': moveToDocumentBoundary(-1), 'Mod-End': moveToDocumentBoundary(1),
        'Mod-Shift-Home': moveToDocumentBoundary(-1, true), 'Mod-Shift-End': moveToDocumentBoundary(1, true),
        Enter: chainCommands(enter, baseKeymap.Enter),
        'Shift-Enter': (state, dispatch) => {
          if (isInTable(state)) { this.tab(state, dispatch, -1); return true; }
          if (newlineInCode(state, dispatch)) return true;
          if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
          return true;
        },
        Backspace: chainCommands(undoInputRule, baseKeymap.Backspace),
        Tab: (state, dispatch) => this.tab(state, dispatch, 1),
        'Shift-Tab': (state, dispatch) => this.tab(state, dispatch, -1),
        'Mod-Enter': exitCode,
      }),
      keymap(baseKeymap),
      tableEditing(),
      new Plugin({ appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null;
        const transaction = state.tr;
        state.doc.descendants((node, position) => {
          if (node.type !== nodes.table) return;
          node.forEach((row, rowOffset, rowIndex) => row.forEach((cell, cellOffset) => {
            const type = rowIndex === 0 ? nodes.table_header : nodes.table_cell;
            if (cell.type !== type) transaction.setNodeMarkup(position + 2 + rowOffset + cellOffset, type, cell.attrs);
          }));
          return false;
        });
        return transaction.docChanged ? transaction : null;
      } }),
    ];
  }

  dispatchTransaction(transaction) {
    if (this.destroyed || (this.readOnly && transaction.docChanged)) return;
    try {
      const previous = this.view.state;
      let { state: next } = previous.applyTransaction(transaction);
      const beforeText = this.source.text;
      const changed = !next.doc.eq(previous.doc);
      const updated = changed ? this.source.update(next.doc) : null;
      if (updated?.doc && !updated.doc.eq(next.doc)) {
        const position = value => updated.mapPosition ? updated.mapPosition(value) : value;
        const corrected = next.tr.replaceWith(0, next.doc.content.size, updated.doc.content);
        corrected.setSelection(selectionAt(corrected.doc, position(next.selection.anchor), position(next.selection.head)));
        next = next.apply(corrected);
      }
      this.view.updateState(next); this.updateTableTools();
      if (updated && updated.text !== beforeText) {
        let payload = { text: updated.text, changes: updated.changes, beforeText };
        if (this.pendingExternal) {
          const local = ChangeSet.of(updated.changes, beforeText.length);
          const changes = local.map(this.pendingExternal.changes);
          const text = changes.apply(Text.of(this.pendingExternal.text.split('\n'))).toString();
          payload = { text, changes: sourceChanges(changes), beforeText: this.pendingExternal.text };
          this.pendingExternal = { text, changes: this.pendingExternal.changes.map(local, true) };
        }
        this.options.onChange?.({ ...payload, userEvent: transaction.getMeta('richUserEvent') || (transaction.getMeta('uiEvent') === 'paste' ? 'input.paste' : 'input.type'), selection: this.sourceSelection() });
      }
      if (changed || !next.selection.eq(previous.selection)) this.options.onSelectionChange?.(this.sourceSelection());
      this.notifyStateChange();
    } catch (error) { this.reportError(error); }
  }

  setDocument({ text = '', path = '', projectRoot = '' }) {
    const moved = path !== this.path || projectRoot !== this.projectRoot;
    this.path = path; this.projectRoot = projectRoot;
    if (moved) {
      this.pendingExternal = null;
      if (this.host.contains(this.document.activeElement)) this.document.activeElement.blur();
      const replaced = this.replaceText(String(text), null);
      if (!replaced) this.notifyStateChange();
      for (const image of this.imageViews) image.refreshSource();
      for (const link of this.view.dom.querySelectorAll('a[data-rich-link]')) this.prepareLink(link, link.dataset.richLink);
    } else this.setText(String(text));
  }
  setText(text, changes = null) {
    text = String(text);
    if (this.destroyed || text === this.text) return false;
    if (this.composing) {
      const before = this.pendingExternal?.text ?? this.source.text;
      const next = changes?.compose ? changes : changesBetween(before, text);
      this.pendingExternal = { text, changes: this.pendingExternal ? this.pendingExternal.changes.compose(next) : next };
      return false;
    }
    this.pendingExternal = null;
    return this.replaceText(text, changes);
  }
  replaceText(text, changes) {
    if (text === this.source.text) return false;
    const oldSelection = this.sourceSelection();
    const mapped = changes?.mapPos ? changes : changesBetween(this.source.text, text);
    const nextSource = new MarkdownSource(text);
    const anchor = nextSource.positionAtSource(mapped.mapPos(oldSelection.anchor, 1));
    const head = nextSource.positionAtSource(mapped.mapPos(oldSelection.head, 1));
    const top = this.host.scrollTop, left = this.host.scrollLeft;
    this.source = nextSource;
    if (!this.view.state.doc.eq(nextSource.doc)) {
      const transaction = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, nextSource.doc.content);
      transaction.setSelection(selectionAt(transaction.doc, anchor, head));
      this.view.updateState(this.view.state.apply(transaction));
    }
    this.host.scrollTop = top; this.host.scrollLeft = left; this.updateTableTools(); this.notifyStateChange();
    return true;
  }
  flushPendingText() {
    this.window.clearTimeout(this.compositionTimer);
    this.compositionTimer = this.window.setTimeout(() => {
      if (this.destroyed || !this.pendingExternal) return;
      if (this.composing) { this.flushPendingText(); return; }
      const pending = this.pendingExternal; this.pendingExternal = null;
      this.replaceText(pending.text, pending.changes);
    }, 25);
  }
  setReadOnly(value) {
    value = Boolean(value);
    if (value === this.readOnly) return;
    this.readOnly = value; this.host.classList.toggle('is-readonly', this.readOnly);
    this.view.setProps({ editable: () => !this.readOnly });
    for (const view of this.embeddedViews) view.setReadOnly(this.readOnly);
    this.updateTableTools(); this.notifyStateChange();
  }
  focus() { if (!this.destroyed) this.view.focus(); }
  selectionSnapshot() { const { anchor, head } = this.view.state.selection; return { richAnchor: anchor, richHead: head }; }
  selectedText() { const { from, to } = this.view.state.selection; return this.view.state.doc.textBetween(from, to, '\n', node => node.attrs.tex || node.attrs.alt || ''); }
  headingLevel() { return closestNode(this.view.state.selection.$from, node => node.type === markdownSchema.nodes.heading)?.node.attrs.level || 0; }
  sourceSelection() {
    const { anchor, head } = this.view.state.selection;
    const result = { anchor: this.source.sourceOffsetAt(anchor), head: this.source.sourceOffsetAt(head) };
    if (this.pendingExternal) for (const key of ['anchor', 'head']) result[key] = this.pendingExternal.changes.mapPos(result[key], 1);
    return result;
  }
  selectSource(anchor, head = anchor, { scrollIntoView = false } = {}) {
    if (this.destroyed || this.composing) return;
    const selection = selectionAt(this.view.state.doc, this.source.positionAtSource(anchor), this.source.positionAtSource(head));
    let transaction = this.view.state.tr.setSelection(selection);
    if (scrollIntoView) transaction = transaction.scrollIntoView();
    this.view.updateState(this.view.state.apply(transaction)); this.updateTableTools(); this.notifyStateChange();
  }
  insertMarkdown(text) {
    if (this.readOnly || this.destroyed) return false;
    const parsed = parseMarkdown(String(text).replace(/\r\n?/g, '\n'));
    const inline = parsed.childCount === 1 && parsed.firstChild.type === markdownSchema.nodes.paragraph;
    const slice = new Slice(parsed.content, inline ? 1 : 0, inline ? 1 : 0);
    this.view.dispatch(this.view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('richUserEvent', 'input.paste'));
    this.focus(); return true;
  }

  command(name, options = {}) {
    if (this.readOnly || this.destroyed || this.composing) return false;
    const { nodes, marks } = markdownSchema, state = this.view.state;
    const dispatch = transaction => this.view.dispatch(transaction.scrollIntoView().setMeta('richUserEvent', 'input.format'));
    let result = false;
    if (['bold', 'italic', 'strike', 'inlineCode'].includes(name)) result = toggleMark(marks[{ bold: 'strong', italic: 'em', strike: 'strike', inlineCode: 'code' }[name]])(state, dispatch);
    else if (name === 'heading') {
      const level = clamp(Number(options.level), 6);
      result = setBlockType(level ? nodes.heading : nodes.paragraph, level ? { level, markup: '#' } : undefined)(state, dispatch);
    } else if (['bullet', 'ordered', 'task'].includes(name)) result = this.toggleList(name, dispatch);
    else if (name === 'quote') result = (closestNode(state.selection.$from, node => node.type === nodes.blockquote) ? lift : wrapIn(nodes.blockquote))(state, dispatch);
    else if (name === 'link') {
      const href = linkAddress(options.url);
      const label = String((options.label ?? this.selectedText()) || options.placeholder || href).replace(/\r?\n/g, ' ');
      const mark = marks.link.create({ href, title: null });
      const { from, to } = state.selection;
      if (!state.selection.empty && label === this.selectedText()) dispatch(state.tr.addMark(from, to, mark));
      else dispatch(state.tr.replaceSelectionWith(markdownSchema.text(label, [...(state.storedMarks || state.selection.$from.marks()).filter(value => value.type !== marks.link), mark]), false));
      result = true;
    } else if (name === 'codeBlock') {
      const params = languageName(options.language);
      const code = String(options.code ?? this.selectedText());
      const node = nodes.code_block.create({ params, fence: '```' }, code ? markdownSchema.text(code) : undefined);
      this.view.dispatch(state.tr.replaceSelectionWith(node).scrollIntoView().setMeta('richUserEvent', 'input.insert')); result = true;
    } else if (name === 'math') {
      const displayMode = options.displayMode !== false;
      if (displayMode && isInTable(state)) return false;
      const delimiter = options.delimiter ?? (displayMode ? '$$' : '$`');
      if (!(displayMode ? ['$$', '\\[', '```math'] : ['$`', '$', '\\(']).includes(delimiter)) throw new Error('math-delimiter');
      const inherited = displayMode ? [] : (state.storedMarks || (state.selection.empty ? state.selection.$from.marks() : state.selection.$from.marksAcross(state.selection.$to)) || []).filter(mark => mark.type !== marks.code);
      const node = (displayMode ? nodes.math_block : nodes.math_inline).create({ tex: String(options.tex ?? 'x'), displayMode, delimiter, equationNumber: '' }, null, inherited);
      const transaction = state.tr.replaceSelectionWith(node, false).scrollIntoView().setMeta('richUserEvent', 'input.insert');
      let position = transaction.selection.from;
      transaction.doc.descendants((child, offset) => { if (child.type === node.type && child.attrs === node.attrs) position = offset; });
      transaction.setSelection(NodeSelection.create(transaction.doc, position));
      this.view.dispatch(transaction); this.focus();
      const created = [...this.embeddedViews].find(view => view instanceof MathView && view.getPos() === position);
      if (created) { if (options.tex == null) created.open(true); else created.close(); }
      return true;
    } else if (tableCommands[name]) result = tableCommands[name](state, dispatch);
    if (result) this.focus();
    return result;
  }

  toggleList(name, dispatch) {
    const { state } = this.view, { nodes } = markdownSchema;
    const type = name === 'ordered' ? nodes.ordered_list : nodes.bullet_list;
    const list = closestNode(state.selection.$from, node => node.type === nodes.bullet_list || node.type === nodes.ordered_list);
    const item = closestNode(state.selection.$from, node => node.type === nodes.list_item);
    if (list) {
      if (list.node.type === type && (name === 'task' ? item?.node.attrs.checked != null : item?.node.attrs.checked == null)) return liftListItem(nodes.list_item)(state, dispatch);
      const transaction = state.tr.setNodeMarkup(list.position, type, type === nodes.ordered_list ? { order: list.node.attrs.order || 1 } : undefined);
      list.node.forEach((child, offset) => {
        if (child.type === nodes.list_item) transaction.setNodeMarkup(list.position + 1 + offset, undefined, { ...child.attrs, checked: name === 'task' ? Boolean(child.attrs.checked) : null });
      });
      dispatch(transaction); return true;
    }
    return wrapInList(type)(state, transaction => {
      if (name === 'task') transaction.doc.nodesBetween(transaction.selection.from, Math.max(transaction.selection.from + 1, transaction.selection.to), (node, position) => {
        if (node.type === nodes.list_item) transaction.setNodeMarkup(position, undefined, { ...node.attrs, checked: false });
      });
      dispatch(transaction);
    });
  }
  tab(state, dispatch, direction) {
    if (this.readOnly) return false;
    if (isInTable(state)) {
      if (goToNextCell(direction)(state, dispatch)) return true;
      if (direction < 0) return false;
      return addRowAfter(state, transaction => {
        goToNextCell(1)(state.apply(transaction), next => transaction.setSelection(next.selection));
        dispatch?.(transaction.setMeta('richUserEvent', 'input.format'));
      });
    }
    if ((direction > 0 ? sinkListItem : liftListItem)(markdownSchema.nodes.list_item)(state, dispatch)) return true;
    if (state.selection.$from.parent.type.spec.code && direction > 0) { dispatch?.(state.tr.insertText('  ')); return true; }
    return false;
  }
  handleShortcut(event) {
    if (event.isComposing || this.composing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    let callback;
    if (key === 'z') callback = event.shiftKey ? this.options.onRedo : this.options.onUndo;
    else if (key === 'y' && !event.shiftKey) callback = this.options.onRedo;
    else if (key === 'f' && !event.shiftKey) callback = this.options.onFind;
    if (!callback) return;
    event.preventDefault(); event.stopPropagation(); callback();
  }
  handlePaste(view, event) {
    if (this.readOnly) return false;
    if (this.options.onPaste?.(event)) return true;
    if (view.state.selection.$from.parent.type.spec.code) return false;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || event.clipboardData?.getData('text/html')) return false;
    event.preventDefault(); return this.insertMarkdown(text);
  }
  handleDrop(view, event, moved) {
    if (this.readOnly) return false;
    if ([...(event.dataTransfer?.types || [])].includes('Files')) {
      const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (position) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position.pos))));
      this.options.onFocus?.();
      return Boolean(this.options.onDrop?.(event));
    }
    if (moved) return false;
    const text = event.dataTransfer?.getData('text/plain');
    if (!text || event.dataTransfer?.getData('text/html')) return false;
    const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (position) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position.pos))));
    event.preventDefault(); return this.insertMarkdown(text);
  }

  createTableTools() {
    const wrapper = element(this.document, 'div', 'rich-table-tools');
    this.tableActions = labelled(element(this.document, 'div', 'rich-table-actions'), '表の行と列'); this.tableActions.setAttribute('role', 'toolbar');
    for (const [command, caption, label] of [
      ['addRowBefore', '↑＋', '上に行を追加'], ['addRowAfter', '↓＋', '下に行を追加'], ['deleteRow', '↔−', '行を削除'],
      ['addColumnBefore', '←＋', '左に列を追加'], ['addColumnAfter', '→＋', '右に列を追加'], ['deleteColumn', '↕−', '列を削除'],
      ['deleteTable', '×', '表を削除'],
    ]) {
      const button = labelled(element(this.document, 'button', 'rich-table-button', caption), label);
      button.type = 'button'; button.title = t(label); button.dataset.i18nTitle = label; button.dataset.richCommand = command;
      button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => this.command(command));
      this.tableActions.append(button);
    }
    wrapper.append(this.tableActions); return wrapper;
  }
  updateTableTools() {
    if (!this.view) return;
    this.tableActions.hidden = !isInTable(this.view.state);
    for (const button of this.tableActions.querySelectorAll('button')) button.disabled = this.readOnly || !tableCommands[button.dataset.richCommand](this.view.state);
  }
  prepareLink(link, reference) {
    link.dataset.richLink = reference;
    const resolved = resolveMarkdownReference(reference, this.path);
    if (resolved?.kind === 'external') { link.href = resolved.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else if (resolved) link.href = '#';
    else link.removeAttribute('href');
    link.title = t('Ctrl または ⌘ を押しながらクリックしてリンクを開く');
  }
  handleLink(event) {
    const link = event.target.closest?.('a[data-rich-link]');
    if (!link || !this.host.contains(link)) return false;
    event.preventDefault();
    if (!(event.ctrlKey || event.metaKey)) return true;
    const resolved = resolveMarkdownReference(link.dataset.richLink, this.path);
    if (resolved?.kind === 'external') this.window.open(resolved.href, '_blank', 'noopener,noreferrer');
    else if (resolved) Promise.resolve(this.options.onOpenFile?.(resolved.kind === 'anchor' ? this.path : resolved.path, { fragment: resolved.fragment || '' })).catch(error => this.reportError(error));
    return true;
  }
  refreshImages(path, { caseInsensitive = false } = {}) {
    if (this.destroyed) return false;
    const pathKey = value => caseInsensitive ? value.toLowerCase() : value;
    const images = [...this.imageViews].filter(image => {
      const resolved = resolveMarkdownReference(image.node.attrs.src, this.path);
      return resolved?.kind === 'local' && pathKey(resolved.path) === pathKey(path) && imageExtensions.test(resolved.path);
    });
    if (!images.length) return false;
    for (const image of images) {
      const asset = image.asset;
      if (asset && this.assets.get(asset.key) === asset) this.assets.delete(asset.key);
    }
    for (const image of images) image.refreshSource({ force: true });
    return true;
  }
  acquireImage(path) {
    const key = `${this.projectRoot}\n${path}`;
    let asset = this.assets.get(key);
    if (asset) { asset.references++; return asset; }
    asset = { key, references: 1, url: null, controller: new AbortController() }; this.assets.set(key, asset);
    const projectRoot = this.projectRoot;
    asset.promise = (async () => {
      const response = await this.window.fetch(`/api/asset?path=${encodeURIComponent(path)}`, {
        headers: { 'X-Local-Token': this.token, 'X-Project-Root': encodeURIComponent(projectRoot), 'Accept-Language': getLanguage() },
        signal: asset.controller.signal, cache: 'no-store',
      });
      if (!response.ok) throw new Error(t('画像を取得できませんでした (HTTP {value0})．', { value0: response.status }));
      const blob = await response.blob();
      if (!asset.references || this.destroyed) return null;
      if (!blob.type.startsWith('image/')) throw new Error(t('このファイルは画像として表示できません．'));
      return (asset.url = this.window.URL.createObjectURL(blob));
    })();
    return asset;
  }
  releaseImage(asset) {
    if (!asset || --asset.references > 0) return;
    asset.controller.abort(); if (asset.url) this.window.URL.revokeObjectURL(asset.url);
    if (this.assets.get(asset.key) === asset) this.assets.delete(asset.key);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.window.clearTimeout(this.compositionTimer); this.stopLanguage(); this.stopZoom?.();
    this.host.removeEventListener('focusin', this.focusListener); this.host.removeEventListener('keydown', this.keyListener, true);
    this.view.destroy();
    for (const asset of this.assets.values()) { asset.controller.abort(); if (asset.url) this.window.URL.revokeObjectURL(asset.url); }
    this.assets.clear(); this.host.replaceChildren(); this.host.classList.remove('markdown-rich-editor', 'is-readonly');
  }
}
