import { t, getLanguage, setLanguage } from './i18n.js';
import { EditorState, Compartment, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, keymap, Decoration, scrollPastEnd } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab, isolateHistory, undo, redo } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { autocompletion, closeCompletion } from '@codemirror/autocomplete';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdown } from '@codemirror/lang-markdown';
import { PDFViewer } from './pdf-viewer.js';
import { MarkdownPreview, extractMarkdownOutline } from './markdown-preview.js';
import { AssetPreview } from './asset-preview.js';
import { sourceSearch, openSourceSearchPanel } from './source-search.js';
import { attachEditorZoom, prepareEditorResize } from './editor-zoom.js';
import { createPanelLayout, normalizePanelLayout } from './panel-layout.js';
import { normalizeAppearance, normalizeHexColor, resolveAppearance } from './appearance.js';
import { createHelp } from './help.js';
import { stateForOtherView, restoredTabPaths } from './shared-editor.js';
import { NavigationHistory, afterNavigationFrame } from './navigation-history.js';
import { createProjectSearch, replaceProjectDocuments } from './project-search.js';
import { createEditHistory } from './edit-history.js';
import { createReferenceTools } from './reference-tools.js';
import { createInsertTools } from './insert-tools.js';
import { createEditorContextMenu } from './editor-context-menu.js';
import { createDocumentTools } from './document-tools.js';
import { createTemplateManager } from './template-manager.js';
import { createLogIssues } from './log-issues.js';
import { createMarkdownEditing } from './markdown-editing.js';
import { MarkdownRichEditor } from './markdown-rich-editor.js';
import { createProjectHome } from './project-home.js';
import { createFileImporter } from './file-import.js';
import { buildFileTree, fileModificationTime, normalizeFileSort, projectListingSignature } from './file-sorting.js';
import { completionPresentation } from './completion-ui.js';
import { createTeXCompletionSource } from './tex-completion.js';
import { sourceFolding, revealSourceRange } from './source-folding.js';
import { createOutlineTree } from './outline-tree.js';
import { programLanguage } from './program-language.js';
import { createFileActions, fileActionText, fileDestinationConflict, entryContains, mapEntryPath } from './file-actions.js';
import { tags } from '@lezer/highlight';
import { SessionStore } from './session-store.js';
import { BrowserSession } from './browser-session.js';
import { isMac, shortcutModifier } from './platform-keys.js';
import { renderTeXPackagesHelp } from './tex-packages.js';
import { extractTexMetadata, extractCitations, compileTarget } from './tex-tools.js';

const $ = id => document.getElementById(id);
const TOKEN_KEY = 'local-tex-editor-token';
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || '';
try {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else token = sessionStorage.getItem(TOKEN_KEY) || '';
} catch { /* The current tab can work even when browser storage is disabled. */ }
if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);

const state = {
  meta: null,
  documents: new Map(),
  assets: new Map(),
  tabOrder: [],
  directoryState: new Map(),
  folderPicker: null,
  pendingFiles: new Map(),
  treeButtons: new Map(),
  tabElements: new Map(),
  editor: null,
  editorZoomCleanup: null,
  activePane: 'primary',
  splitEditors: false,
  sourceRatio: 1,
  lastSurface: 'source',
  synchronizingEditors: false,
  activePath: '',
  projectGeneration: 0,
  projectEntriesVersion: 0,
  toolsGeneration: 0,
  texPackages: null,
  openSequence: 0,
  operation: '',
  build: null,
  fullLog: '',
  pollTimer: null,
  polling: false,
  heartbeat: null,
  heartbeatPending: false,
  closed: false,
  connected: false,
  connectionError: false,
  externalProjectChanged: false,
  reportedBuild: '',
  preferences: { autoSave: true, theme: null, appearance: normalizeAppearance(), editorFontSize: 14, language: getLanguage(), panelLayout: normalizePanelLayout(), fileSort: 'name-asc', markdownEditorModes: { primary: 'rich', secondary: 'rich' }, previewVisibility: { rich: false, markdown: true, source: true }, markdownScrollSync: true, texCompletion: true, automaticCompletion: true, pdfDarkMode: false },
  previewContext: '',
  homeVisible: false,
  theme: 'light',
  saveQueue: Promise.resolve(),
  autoSaveTimer: null,
  draftTimer: null,
  sessionTimer: null,
  outlineTimer: null,
  persistenceReady: false,
  initialFilePending: false,
  session: null,
  drafts: { entries: [] },
  recoverySelection: null,
  sidebar: 'files',
  texIndex: new Map(),
  completionItems: { citations: [], labels: [] },
  indexing: false,
  syncing: false,
  previewMode: 'pdf',
  previewChoice: 'auto',
  lastMarkdownPath: '',
};
const readOnly = new Compartment();
const systemColorScheme = matchMedia('(prefers-color-scheme: dark)');
let appearanceDraft = null;
let help = null;
let navigationHistory = null;
let insertTools = null;
let documentTools = null;
let referenceTools = null;
let projectSearch = null;
let documentHistory = null;
let templateManager = null;
let logIssues = null;
let markdownEditing = null;
let editorContextMenu = null;
let projectHome = null;
let outlineTree = null;
const editorSlots = {
  primary: { host: $('editor'), richHost: $('markdown-rich-primary'), element: $('source-pane-primary'), select: $('primary-document'), view: null, rich: null, path: '', cleanup: null },
  secondary: { host: $('editor-secondary'), richHost: $('markdown-rich-secondary'), element: $('source-pane-secondary'), select: $('secondary-document'), view: null, rich: null, path: '', cleanup: null },
};
const editorTheme = new Compartment();
const editorLanguage = new Compartment();
const editorCompletion = new Compartment();
const editorDocumentPath = new Compartment();
const modeLabels = { project: 'latexmkrc', pdflatex: 'pdfLaTeX', uplatex: 'upLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' };
let toastTimer = null;
let lineFlashTimer = null;
let markdownScrollFrame = 0;
let markdownScrollPauseSequence = 0;
let markdownScrollPaused = false;
let draggedTabPath = '';
const lineFlash = StateEffect.define();
const lineFlashField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(lineFlash)) {
      value = effect.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: 'synctex-line' }).range(transaction.state.doc.line(Math.min(transaction.state.doc.lines, Math.max(1, effect.value))).from)]);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});
const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#c4a7f0' },
  { tag: [tags.name, tags.variableName], color: '#b5d5e7' },
  { tag: [tags.typeName, tags.className, tags.propertyName], color: '#83cbd1' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a4d6a3' },
  { tag: [tags.number, tags.bool, tags.atom], color: '#efbd8b' },
  { tag: tags.comment, color: '#8a9eae' },
  { tag: [tags.operator, tags.punctuation], color: '#a8bbca' },
  { tag: tags.meta, color: '#dcaa82' },
  { tag: tags.invalid, color: '#ff9aa5' },
]);

class APIError extends Error {
  constructor(message, status = 0, data = null) { super(message); this.name = 'APIError'; this.status = status; this.data = data; }
}

function setConnected(connected) {
  state.connected = connected;
  if (connected && state.connectionError) clearError();
  const label = $('connection-status');
  label.classList.toggle('connected', connected);
  label.classList.toggle('disconnected', !connected);
  label.textContent = state.closed ? t("アプリを終了しました") : connected ? t("この PC に接続済み") : t("接続を確認してください");
}

async function api(path, { method = 'GET', body, binary = false, headers: additionalHeaders = {}, timeout = 15000, projectRoot = state.meta?.project?.root, signal, keepalive = false } = {}) {
  if (state.closed) throw new Error(t("アプリは終了しています．実行ファイルから開き直してください．"));
  if (!token) throw new APIError(t("接続に必要な情報が見つかりません．アプリの実行ファイルを起動して開いたページを使用してください．"), 401);
  const headers = { ...additionalHeaders, 'X-Local-Token': token, Accept: 'application/json', 'Accept-Language': getLanguage() };
  if (projectRoot && !/^\/api\/(state|project\/(open|pick)|shutdown)(\?|$)/.test(path)) headers['X-Project-Root'] = encodeURIComponent(projectRoot);
  if (body !== undefined) headers['Content-Type'] = binary ? 'application/octet-stream' : 'application/json';
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), cache: 'no-store', signal: controller.signal, keepalive });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw new APIError(t("応答を読み取れませんでした (HTTP {value0})．{value1}", { value0: response.status, value1: text.slice(0, 500) }), response.status); }
    if (!response.ok) throw new APIError(data?.error || t("処理に失敗しました (HTTP {value0})．", { value0: response.status }), response.status, data);
    setConnected(true);
    return data;
  } catch (error) {
    if (signal?.aborted) throw new DOMException(t("操作を取り消しました．"), 'AbortError');
    if (error instanceof APIError) {
      if (error.status === 401 || error.status === 403) setConnected(false);
      throw error;
    }
    setConnected(false);
    if (error.name === 'AbortError') throw new APIError(t("PC 上のアプリから応答がありません．処理が続いている場合は，少し待ってから再接続してください．"));
    throw new APIError(t("PC 上のアプリに接続できません．{value0}", { value0: error.message || error }));
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

function showError(error, action = null) {
  if (state.closed) return;
  state.connectionError = error instanceof APIError && error.status === 0 && !state.connected;
  const message = error?.message || String(error);
  $('error-text').textContent = message;
  $('app-error').hidden = false;
  const fallback = !state.connected && token && !state.closed ? { label: t("再接続"), run: reconnect } : null;
  const buttonAction = action || fallback;
  $('error-action').hidden = !buttonAction;
  $('error-action').textContent = buttonAction?.label || t("再接続");
  $('error-action').onclick = buttonAction ? () => runTask(buttonAction.run) : null;
  if (error && typeof error === 'object') error.shown = true;
}

function clearError() { state.connectionError = false; $('app-error').hidden = true; $('error-action').onclick = null; }
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}
function navigate(action) { return navigationHistory ? navigationHistory.navigate(action) : action(); }
function runTask(fn) { Promise.resolve().then(fn).catch(error => { if (!error?.shown) showError(error); }); }
function onClick(id, fn) { $(id).addEventListener('click', () => runTask(fn)); }
function normalise(text) { return (text || '').replace(/\r\n?/g, '\n'); }
function basename(path) { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path; }
function isDirty(doc) { return !!doc && !doc.state.doc.eq(doc.savedDoc); }
function dirtyDocuments() { return [...state.documents.values()].filter(isDirty); }
function activeDocument() { return state.documents.get(state.activePath); }
function documentText(doc) {
  if (doc.textSnapshotDoc !== doc.state.doc) { doc.textSnapshotDoc = doc.state.doc; doc.textSnapshot = doc.state.doc.toString(); }
  return doc.textSnapshot;
}
function isMarkdown(path) { return /\.(md|markdown)$/i.test(path || ''); }
function sourceAffectsPDF(path) {
  if (!isMarkdown(path)) return true;
  const inputs = state.build?.pdfMarkdownInputs;
  if (!Array.isArray(inputs)) return true;
  const normalisePath = value => state.meta?.platform === 'windows' ? value.toLowerCase() : value;
  return inputs.some(input => normalisePath(input) === normalisePath(path));
}
function currentCompileTarget() {
  const doc = activeDocument();
  const fallback = state.meta?.project?.main || '';
  if (!doc) return fallback;
  if (doc.compileDoc !== doc.state.doc || doc.compileFallback !== fallback) {
    doc.compileDoc = doc.state.doc; doc.compileFallback = fallback;
    doc.compileMain = compileTarget(doc.path, doc.state.doc.toString(), fallback);
  }
  return doc.compileMain;
}
function updateDocumentPreview({ immediate = false } = {}) {
  const doc = activeDocument();
  const editingMarkdown = !!doc && isMarkdown(doc.path);
  if (editingMarkdown) state.lastMarkdownPath = doc.path;
  const markdownDocument = (editingMarkdown ? doc : state.documents.get(state.lastMarkdownPath)) || [...state.documents.values()].find(item => isMarkdown(item.path));
  state.lastMarkdownPath = markdownDocument?.path || '';
  const useMarkdown = state.previewChoice === 'markdown' || (state.previewChoice === 'auto' && editingMarkdown);
  const changed = state.previewMode !== (useMarkdown ? 'markdown' : 'pdf');
  state.previewMode = useMarkdown ? 'markdown' : 'pdf';
  $('pdf-preview').hidden = useMarkdown;
  for (const select of document.querySelectorAll('[data-preview-choice]')) select.value = state.previewChoice;
  $('pdf-pane').setAttribute('aria-label', useMarkdown ? t("Markdown のプレビュー") : t("PDF のプレビュー"));
  $('show-preview').textContent = useMarkdown ? t("プレビュー") : 'PDF';
  $('splitter').setAttribute('aria-label', t("編集画面とプレビューの幅を変更"));
  if (useMarkdown) {
    $('markdown-preview-panel').hidden = false;
    if (changed) viewer.search.close(false);
    const path = markdownDocument?.path || '';
    $('markdown-document-name').textContent = path || t("Markdown ファイルを開いてください");
    $('markdown-document-name').title = path;
    markdownPreview.update(markdownDocument ? documentText(markdownDocument) : '', { path, projectRoot: state.meta?.project?.root, immediate });
    if (changed) markdownPreview.show();
  } else {
    if (changed) { markdownPreview.hide(); requestAnimationFrame(() => viewer.refreshLayout()); }
    $('markdown-preview-panel').hidden = true;
  }
}
function setPreviewChoice(value) {
  state.previewChoice = ['auto', 'pdf', 'markdown'].includes(value) ? value : 'auto';
  updateDocumentPreview({ immediate: true });
  renderControls(); scheduleSession();
}
function pauseMarkdownScrollSync() {
  markdownScrollPaused = true;
  const sequence = ++markdownScrollPauseSequence;
  cancelAnimationFrame(markdownScrollFrame); markdownScrollFrame = 0;
  // Let CodeMirror finish restoring the document or moving its cursor before
  // following later scrolls made by the user.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (sequence === markdownScrollPauseSequence) markdownScrollPaused = false;
  }));
}
function scheduleMarkdownScrollSync() {
  if (markdownScrollFrame || markdownScrollPaused || !state.preferences.markdownScrollSync) return;
  markdownScrollFrame = requestAnimationFrame(() => {
    markdownScrollFrame = 0;
    const view = state.editor;
    const doc = activeDocument();
    if (markdownScrollPaused || state.closed || !view || !doc || !isMarkdown(doc.path) ||
        !state.preferences.markdownScrollSync || state.previewMode !== 'markdown' ||
        !view.scrollDOM.clientHeight || editorSlots[state.activePane].host.hidden) return;
    const height = Math.max(0, view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.clientTop - view.documentTop);
    const block = view.lineBlockAtHeight(height);
    const first = view.state.doc.lineAt(block.from).number;
    const last = view.state.doc.lineAt(block.to).number;
    const fraction = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
    markdownPreview.syncSourceLine(first + fraction * (last - first + 1), {
      path: doc.path, projectRoot: state.meta?.project?.root,
      atStart: view.scrollDOM.scrollTop <= 2,
      atEnd: view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight - view.scrollDOM.scrollTop <= 2,
    });
  });
}
function applyMarkdownScrollSync(enabled) {
  state.preferences.markdownScrollSync = enabled;
  $('markdown-scroll-sync').checked = enabled;
  markdownPreview.setScrollSync(enabled);
  if (!enabled) { cancelAnimationFrame(markdownScrollFrame); markdownScrollFrame = 0; }
}
function scrollSourceWithMarkdown(position) {
  if (!state.preferences.markdownScrollSync || state.closed || state.operation || position.projectRoot !== state.meta?.project?.root) return;
  const candidates = visibleEditorSlots(position.path);
  const slot = candidates.find(([name]) => name === state.activePane)?.[1] || candidates[0]?.[1];
  if (!slot?.view || (slot.rich && !slot.richHost.hidden)) return;
  const view = slot.view;
  const sourceLine = Math.max(1, Math.min(view.state.doc.lines, position.sourceLine));
  const line = view.state.doc.line(Math.floor(sourceLine));
  const block = view.lineBlockAt(line.from);
  const firstLine = view.state.doc.lineAt(block.from).number;
  const lastLine = view.state.doc.lineAt(block.to).number;
  pauseMarkdownScrollSync();
  const offset = view.documentTop - view.scrollDOM.getBoundingClientRect().top - view.scrollDOM.clientTop;
  const target = view.scrollDOM.scrollTop + offset + block.top + (sourceLine - firstLine) / (lastLine - firstLine + 1) * block.height;
  view.scrollDOM.scrollTop = position.atStart ? 0 : position.atEnd ? view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight : Math.max(0, target);
  state.lastSurface = 'markdown'; scheduleSession();
}
function fileKind(file) { return file?.kind || 'text'; }
function rememberTab(path) { if (!state.tabOrder.includes(path)) state.tabOrder.push(path); }
function rememberEditorPosition() {
  if (state.homeVisible) return;
  for (const [, slot] of visibleEditorSlots()) {
    const doc = state.documents.get(slot.path);
    if (doc) { doc.scrollTop = slot.view.scrollDOM.scrollTop; if (slot.rich) doc.richScrollTop = slot.richHost.scrollTop; }
  }
}
function updateTreeSelection() {
  for (const [path, button] of state.treeButtons) {
    const selected = path === state.activePath;
    button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'true' : 'false');
    if (selected) for (let folder = button.closest('details'); folder; folder = folder.parentElement?.closest('details')) folder.open = true;
  }
}
function isRunning() { return state.build?.status === 'running'; }

function setOperation(operation) {
  state.operation = operation;
  if (operation) editorContextMenu?.close();
  for (const doc of state.documents.values()) applyDocumentTransaction(doc, doc.state.update({ effects: readOnly.reconfigure([EditorState.readOnly.of(!!operation), EditorView.editable.of(!operation)]) }));
  renderControls();
  if (!operation) {
    scheduleAutoSave();
    if (state.heartbeatPending) runTask(heartbeat);
  }
}

function updateCursor() {
  markdownEditing?.update();
  const view = state.editor;
  if (!view || !activeDocument()) { $('cursor-status').textContent = ''; $('document-encoding').textContent = ''; delete $('editor').dataset.path; delete $('editor').dataset.line; delete $('editor').dataset.column; return; }
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  $('cursor-status').textContent = t("{value0} 行，{value1} 列", { value0: line.number, value1: head - line.from + 1 });
  const host = editorSlots[state.activePane].host;
  host.dataset.path = state.activePath; host.dataset.line = String(line.number); host.dataset.column = String(head - line.from + 1);
  const doc = activeDocument();
  $('document-encoding').textContent = `UTF-8 · ${doc?.lineEnding === 'crlf' ? 'CRLF' : 'LF'}`;
  updateOutlinePosition(); scheduleSession();
}

function completionExtension(path) {
  const enabled = state.preferences.texCompletion && /\.(tex|sty|cls|ltx)$/i.test(path);
  return autocompletion({
    override: enabled ? [createTeXCompletionSource(() => state.completionItems)] : [],
    activateOnTyping: !!enabled && state.preferences.automaticCompletion,
  });
}
function applyCompletionSettings() {
  for (const [, slot] of visibleEditorSlots()) closeCompletion(slot.view);
  for (const doc of state.documents.values()) applyDocumentTransaction(doc, doc.state.update({ effects: editorCompletion.reconfigure(completionExtension(doc.path)) }));
}

const bibLanguage = StreamLanguage.define({
  startState: () => ({ quoted: false }),
  token(stream, parserState) {
    if (stream.eatSpace()) return null;
    if (parserState.quoted) {
      while (!stream.eol()) { const c = stream.next(); if (c === '\\') stream.next(); else if (c === '"') { parserState.quoted = false; break; } }
      return 'string';
    }
    if (stream.match(/^@[A-Za-z]+/)) return 'keyword';
    if (stream.match(/^%.*/)) return 'comment';
    if (stream.match(/^[A-Za-z][A-Za-z0-9_-]*(?=\s*=)/)) return 'propertyName';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.eat('"')) { parserState.quoted = true; return 'string'; }
    if (stream.match(/^[{}(),=]/)) return 'punctuation';
    stream.next();
    return null;
  },
});

function documentPathExtension(path) {
  const extension = path.split('.').pop().toLowerCase();
  const language = isMarkdown(path) ? markdown() : extension === 'bib' ? bibLanguage : /^(tex|sty|cls|ltx|def|bst)$/.test(extension) ? StreamLanguage.define(stex) : programLanguage(path);
  return [sourceFolding(path), language, EditorView.updateListener.of(update => receiveEditorUpdate(update, path))];
}
function makeEditorState(path, content) {
  return EditorState.create({ doc: normalise(content), extensions: [
    basicSetup,
    editorDocumentPath.of(documentPathExtension(path)),
    sourceSearch(),
    editorTheme.of(themeExtension()),
    lineFlashField,
    EditorView.lineWrapping,
    scrollPastEnd(),
    readOnly.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    editorLanguage.of(editorLanguageExtension()),
    completionPresentation(),
    editorCompletion.of(completionExtension(path)),
    EditorView.domEventHandlers({ mousedown(event, view) {
      if (!(event.ctrlKey || event.metaKey) || event.button !== 0 || view.composing) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position == null) return false;
      activateEditorPane(slotForView(view)); event.preventDefault(); view.dispatch({ selection: { anchor: position } }); runTask(() => navigate(() => syncForward(position))); return true;
    }, paste(event, view) {
      activateEditorPane(slotForView(view)); return insertTools?.handlePaste(event) || false;
    }, drop(event, view) {
      activateEditorPane(slotForView(view)); return insertTools?.handleDrop(event) || false;
    }, dragover(event) {
      if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); return true; } return false;
    } }),
    keymap.of([indentWithTab]),
    Prec.highest(keymap.of([
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      { key: 'Mod-Shift-f', run: () => { projectSearch?.open(); return true; } },
      { key: 'Mod-s', run: view => { if (view.composing) return false; runTask(saveCurrent); return true; } },
      { key: 'Mod-Shift-s', run: view => { if (view.composing) return false; runTask(saveEveryDocument); return true; } },
      { key: 'Mod-Enter', run: view => { if (view.composing) return false; runTask(startBuild); return true; } },
    ])),
  ] });
}

function makeDocument(file) {
  const editorState = makeEditorState(file.path, file.content);
  return { path: file.path, revision: file.revision, lineEnding: file.lineEnding || 'lf', state: editorState, savedDoc: editorState.doc, saving: null, conflict: null, draftId: crypto.randomUUID(), visited: false };
}

function slotForView(view) { return Object.entries(editorSlots).find(([, slot]) => slot.view === view)?.[0]; }
function visibleEditorSlots(path = null) { return Object.entries(editorSlots).filter(([name, slot]) => slot.view && (!path || slot.path === path) && (name === 'primary' || state.splitEditors)); }
function editorMode(name = state.activePane) {
  return isMarkdown(editorSlots[name]?.path) && state.preferences.markdownEditorModes[name] !== 'source' ? 'rich' : 'source';
}
function activeRichEditor() { return editorMode() === 'rich' ? editorSlots[state.activePane].rich : null; }
function focusEditorSlot(name = state.activePane) {
  const slot = editorSlots[name];
  if (editorMode(name) === 'rich' && slot.rich) slot.rich.focus(); else slot?.view?.focus();
}
function previewContext() { return isMarkdown(state.activePath) ? editorMode() === 'rich' ? 'rich' : 'markdown' : 'source'; }
function updatePreviewVisibilityControls() {
  const visible = state.preferences.panelLayout.previewVisible;
  const button = $('toggle-preview');
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', t(visible ? 'プレビューを閉じる' : 'プレビューを表示'));
  button.title = t(visible ? 'プレビューを閉じる' : 'プレビューを表示');
}
function applyPreviewVisibility() {
  const context = previewContext();
  if (state.previewContext !== context) {
    state.previewContext = context;
    panelLayout.setPreviewVisible(state.preferences.previewVisibility[context]);
    if (!state.preferences.panelLayout.previewVisible) switchView(false);
  }
  updatePreviewVisibilityControls();
}
function setPreviewVisible(visible) {
  state.preferences.previewVisibility[previewContext()] = !!visible;
  panelLayout.setPreviewVisible(visible);
  if (!visible) switchView(false);
  else if (matchMedia('(max-width: 900px)').matches) switchView(true);
  else requestAnimationFrame(() => viewer.refreshLayout());
  updatePreviewVisibilityControls(); savePreferences(150);
}
function updateEditorModeControls() {
  const available = !!activeDocument() && isMarkdown(state.activePath);
  $('markdown-editor-mode-label').hidden = !available;
  $('markdown-editor-mode').value = editorMode();
  $('markdown-editor-mode').disabled = !!state.operation || state.closed;
  $('markdown-scroll-sync').closest('label').hidden = editorMode() === 'rich';
  for (const [name, slot] of Object.entries(editorSlots)) {
    const rich = editorMode(name) === 'rich' && !!slot.rich;
    slot.richHost.hidden = !rich;
    if (slot.view) slot.host.hidden = rich;
    slot.element.dataset.editorMode = rich ? 'rich' : 'source';
    slot.rich?.setReadOnly(!!state.operation || state.closed);
  }
}
function synchronizeRichSelection(name, selection) {
  const slot = editorSlots[name];
  if (state.synchronizingEditors || !slot?.view || editorMode(name) !== 'rich' || !selection) return;
  const current = slot.view.state.selection.main;
  const length = slot.view.state.doc.length;
  const anchor = Math.max(0, Math.min(length, selection.anchor));
  const head = Math.max(0, Math.min(length, selection.head));
  if (current.anchor !== anchor || current.head !== head) slot.view.dispatch({ selection: { anchor, head }, annotations: Transaction.addToHistory.of(false) });
  if (name === state.activePane) updateCursor();
}
function ensureRichEditor(slot, name) {
  if (!slot.view || !isMarkdown(slot.path) || editorMode(name) !== 'rich') return;
  const properties = { text: slot.view.state.doc.toString(), path: slot.path, projectRoot: state.meta?.project?.root };
  if (slot.rich) { slot.rich.setDocument(properties); return; }
  slot.rich = new MarkdownRichEditor({ host: slot.richHost, ...properties, token,
    onFocus: () => { state.lastSurface = 'source'; activateEditorPane(name); },
    onChange: ({ text, changes, beforeText, userEvent, selection }) => {
      const doc = state.documents.get(slot.path);
      if (!doc || !slot.view || state.closed || state.operation) return;
      if (slot.view.state.doc.toString() !== beforeText) { slot.rich.setText(slot.view.state.doc.toString()); return; }
      const event = userEvent || 'input.type';
      applyDocumentTransaction(doc, slot.view.state.update({ changes, selection, userEvent: event,
        annotations: ['input.format', 'input.insert', 'input.paste'].includes(event) ? isolateHistory.of('full') : undefined }));
      if (slot.view.state.doc.toString() !== text) slot.rich.setText(slot.view.state.doc.toString());
    },
    onSelectionChange: selection => synchronizeRichSelection(name, selection),
    onStateChange: () => { if (name === state.activePane && editorMode(name) === 'rich') markdownEditing?.update(); },
    onUndo: () => applyRichHistory(slot, undo), onRedo: () => applyRichHistory(slot, redo),
    onFind: () => { activateEditorPane(name); setMarkdownEditorMode('source'); openSourceSearchPanel(slot.view); },
    onPaste: event => { activateEditorPane(name); return insertTools?.handlePaste(event) || false; },
    onDrop: event => { activateEditorPane(name); return insertTools?.handleDrop(event) || false; },
    onOpenFile: (path, options = {}) => openMarkdownLink(path, options, name),
    onError: showError,
  });
  const selection = slot.view.state.selection.main;
  slot.rich.selectSource(selection.anchor, selection.head);
}
function applyRichHistory(slot, command) {
  const changed = command(slot.view);
  if (changed) {
    const { anchor, head } = slot.view.state.selection.main;
    slot.rich?.focus();
    slot.rich?.selectSource(anchor, head, { scrollIntoView: true });
  }
  return changed;
}
function setMarkdownEditorMode(mode, name = state.activePane, { focus = true, persist = true } = {}) {
  const slot = editorSlots[name];
  if (!slot?.view || !isMarkdown(slot.path)) return;
  if (focus) slot.restoreSequence = (slot.restoreSequence || 0) + 1;
  const next = mode === 'source' ? 'source' : 'rich';
  if (editorMode(name) === 'rich' && slot.rich) synchronizeRichSelection(name, slot.rich.sourceSelection());
  state.preferences.markdownEditorModes[name] = next;
  ensureRichEditor(slot, name);
  updateEditorModeControls(); markdownEditing?.update();
  if (name === state.activePane) applyPreviewVisibility();
  panelLayout.refresh();
  const selection = slot.view.state.selection.main;
  if (focus) focusEditorSlot(name);
  if (next === 'rich') slot.rich.selectSource(selection.anchor, selection.head, { scrollIntoView: focus });
  else if (focus) slot.view.dispatch({ effects: EditorView.scrollIntoView(selection.head, { y: 'nearest' }) });
  if (persist) { savePreferences(150); scheduleSession(); }
}
async function openMarkdownLink(path, { fragment } = {}, pane = state.activePane) {
  return runTask(() => navigate(async () => {
    await openFile(path, { pane });
    const doc = activeDocument();
    if (doc?.path === path && isMarkdown(path) && fragment) {
      const counts = new Map();
      const heading = extractMarkdownOutline(documentText(doc)).find(item => {
        const slug = item.title.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-') || 'section';
        const count = counts.get(slug) || 0; counts.set(slug, count + 1);
        return (count ? `${slug}-${count}` : slug) === fragment;
      });
      if (heading) await goToSource(path, heading.line);
    }
    await afterNavigationFrame();
  }));
}

function activateEditorPane(name, focus = false) {
  const slot = editorSlots[name];
  if (!slot?.view || !state.documents.has(slot.path) || (name === 'secondary' && !state.splitEditors)) return;
  state.activePane = name; state.editor = slot.view; state.activePath = slot.path;
  const doc = state.documents.get(slot.path); doc.state = slot.view.state;
  for (const [key, item] of Object.entries(editorSlots)) item.element.classList.toggle('active', key === name);
  $('active-filename').textContent = doc.path; $('active-filename').title = doc.path;
  renderTabs(); updateTreeSelection(); updateDocumentIndicators(doc); updateCursor(); renderOutline();
  updateDocumentPreview(); renderControls(); applyPreviewVisibility();
  if (focus) focusEditorSlot(name);
  if (!state.homeVisible) document.title = `${isDirty(doc) ? '● ' : ''}${basename(doc.path)} — Local TeX Web Editor`;
}

function synchronizeEditorViews(doc, origin, changes = null) {
  if (state.synchronizingEditors) return;
  state.synchronizingEditors = true;
  try {
    for (const [, slot] of visibleEditorSlots(doc.path)) {
      slot.rich?.setText(doc.state.doc.toString(), changes);
      if (slot.view === origin) continue;
      const view = slot.view;
      const top = view.scrollDOM.scrollTop, left = view.scrollDOM.scrollLeft;
      const next = stateForOtherView(doc.state, view.state.selection, changes);
      view.setState(next);
      view.scrollDOM.scrollTop = top; view.scrollDOM.scrollLeft = left;
      view.requestMeasure({ read: () => ({ top, left }), write: position => {
        if (slot.view === view && slot.path === doc.path) { view.scrollDOM.scrollTop = position.top; view.scrollDOM.scrollLeft = position.left; }
      } });
    }
  } finally { state.synchronizingEditors = false; }
}

function applyDocumentTransaction(doc, transaction) {
  const current = visibleEditorSlots(doc.path).find(([, slot]) => slot.view.state === transaction.startState);
  if (current) current[1].view.update([transaction]);
  else {
    doc.state = transaction.state;
    synchronizeEditorViews(doc, null, transaction.changes);
    if (transaction.docChanged) { mapSourcePositions(doc.path, transaction.changes); updateDocumentIndicators(doc); updatePreviewNote(); updateDocumentPreview(); queueDrafts(); scheduleAutoSave(); scheduleIndex(doc); }
  }
}

function mapSourcePositions(path, changes) {
  const mapPosition = value => changes.mapPos(Math.max(0, Math.min(changes.length, Number(value) || 0)));
  navigationHistory?.mapEntries?.(entry => entry.source?.path === path ? { ...entry, source: { ...entry.source, anchor: mapPosition(entry.source.anchor), head: mapPosition(entry.source.head) } } : entry);
}

function receiveEditorUpdate(update, path) {
  if (state.synchronizingEditors) return;
  const doc = state.documents.get(path);
  if (!doc) return;
  if (update.docChanged || update.selectionSet || update.view === state.editor || update.transactions.length) doc.state = update.state;
  if (update.docChanged || update.transactions.some(transaction => transaction.effects.length)) synchronizeEditorViews(doc, update.view, update.changes);
  if (update.docChanged) {
    mapSourcePositions(path, update.changes);
    updateDocumentIndicators(doc); updatePreviewNote(); updateDocumentPreview(); queueDrafts(); scheduleAutoSave(); scheduleIndex(doc); }
  if ((update.selectionSet || update.docChanged) && update.view === state.editor) updateCursor();
  if ((update.docChanged || update.geometryChanged) && update.view === state.editor) scheduleMarkdownScrollSync();
}

function destroyEditorSlot(name) {
  const slot = editorSlots[name];
  slot.openSequence = (slot.openSequence || 0) + 1; slot.pendingPath = '';
  if (slot.view && state.documents.has(slot.path)) state.documents.get(slot.path).scrollTop = slot.view.scrollDOM.scrollTop;
  slot.cleanup?.(); slot.cleanup = null; slot.rich?.destroy(); slot.rich = null; slot.richHost.hidden = true;
  slot.view?.destroy(); slot.view = null; slot.path = ''; slot.host.replaceChildren();
}
function destroyEditors() {
  destroyEditorSlot('primary'); destroyEditorSlot('secondary');
  state.editor = null; state.editorZoomCleanup = null; state.activePane = 'primary'; state.splitEditors = false;
  updateSourceLayout();
}

function createEditorView(slot, name, editorState) {
  const view = new EditorView({ state: editorState, parent: slot.host });
  slot.view = view;
  view.dom.addEventListener('focusin', () => { if (slot.view === view) { state.lastSurface = 'source'; activateEditorPane(name); } });
  view.scrollDOM.addEventListener('scroll', () => {
    if (slot.view !== view) return;
    scheduleSession(); if (view === state.editor) scheduleMarkdownScrollSync();
  }, { passive: true });
  slot.cleanup = attachEditorZoom(view, {
    getSize: () => state.preferences.editorFontSize,
    isActive: () => slot.view === view && !!state.documents.get(slot.path) && !state.closed,
    onSize: (size, origin) => { activateEditorPane(name); if (applyEditorFontSize(size, origin)) savePreferences(650); },
  });
  return view;
}

function renderPaneSelectors() {
  const files = (state.meta?.project?.files || []).filter(file => fileKind(file) === 'text');
  const choices = [...new Set([...files.map(file => file.path), ...state.documents.keys()])];
  const signature = JSON.stringify(choices);
  for (const slot of Object.values(editorSlots)) {
    if (slot.choices !== signature) {
      slot.select.replaceChildren();
      for (const path of choices) { const option = document.createElement('option'); option.value = path; option.textContent = path; slot.select.append(option); }
      slot.choices = signature;
    }
    slot.select.value = slot.path;
  }
}

function updateSourceLayout() {
  const container = $('source-workspace');
  container.classList.toggle('split', state.splitEditors);
  container.classList.toggle('stacked', state.splitEditors && container.clientWidth < 600);
  container.style.setProperty('--source-ratio', String(state.sourceRatio));
  editorSlots.primary.element.querySelector('.source-pane-heading').hidden = !state.splitEditors;
  editorSlots.secondary.element.hidden = !state.splitEditors;
  $('source-splitter').hidden = !state.splitEditors;
  $('source-splitter').setAttribute('aria-orientation', container.classList.contains('stacked') ? 'horizontal' : 'vertical');
  $('source-splitter').setAttribute('aria-valuemin', '20'); $('source-splitter').setAttribute('aria-valuemax', '80');
  $('source-splitter').setAttribute('aria-valuenow', String(Math.round(100 * state.sourceRatio / (1 + state.sourceRatio))));
  $('split-editors').setAttribute('aria-pressed', String(state.splitEditors));
  renderPaneSelectors();
}

async function toggleSplitEditors(enabled = !state.splitEditors) {
  if (state.operation || state.closed || !state.meta?.project) return;
  if (enabled) {
    if (!activeDocument()) return;
    const first = activeDocument();
    if (state.activePane !== 'primary') selectDocument(first, { pane: 'primary' });
    state.splitEditors = true; updateSourceLayout();
    const other = state.tabOrder.find(path => path !== first.path && state.documents.has(path)) || first.path;
    await openFile(other, { pane: 'secondary' });
  } else {
    rememberEditorPosition();
    destroyEditorSlot('secondary'); state.splitEditors = false;
    if (editorSlots.primary.view && state.documents.has(editorSlots.primary.path)) activateEditorPane('primary', true);
    else { state.activePane = 'primary'; state.editor = null; state.activePath = editorSlots.primary.path; }
    updateSourceLayout();
  }
  scheduleSession(); panelLayout.refresh();
}

function selectDocument(doc, { pane = state.activePane, focus = true, activate = true, position: requestedPosition = null } = {}) {
  if (pane === 'secondary' && !state.splitEditors) pane = 'primary';
  pauseMarkdownScrollSync(); rememberEditorPosition(); rememberTab(doc.path);
  const slot = editorSlots[pane];
  const sameDocument = slot.path === doc.path && slot.view;
  if (!sameDocument && slot.rich) { slot.rich.destroy(); slot.rich = null; slot.richHost.hidden = true; }
  const position = requestedPosition || (sameDocument ? { scrollTop: slot.view.scrollDOM.scrollTop, richScrollTop: slot.richHost.scrollTop, anchor: slot.view.state.selection.main.anchor, head: slot.view.state.selection.main.head }
    : (!doc.visited ? state.session?.positions?.[doc.path] : { scrollTop: doc.scrollTop || 0, richScrollTop: doc.richScrollTop || 0 }) || { scrollTop: 0 });
  doc.state = doc.state.update({ effects: readOnly.reconfigure([EditorState.readOnly.of(!!state.operation), EditorView.editable.of(!state.operation)]) }).state;
  let editorState = doc.state;
  if (position?.anchor != null) editorState = editorState.update({ selection: { anchor: Math.min(editorState.doc.length, Math.max(0, Number(position.anchor) || 0)), head: Math.min(editorState.doc.length, Math.max(0, Number(position.head) || 0)) } }).state;
  doc.visited = true; slot.path = doc.path;
  if (pane === 'primary') { assetPreview.hide(); $('editor').hidden = false; $('editor-empty').hidden = true; }
  if (slot.view) slot.view.setState(editorState); else createEditorView(slot, pane, editorState);
  doc.state = slot.view.state;
  ensureRichEditor(slot, pane);
  synchronizeEditorViews(doc, slot.view);
  if (requestedPosition && slot.rich && editorMode(pane) === 'rich') {
    const { anchor, head } = slot.view.state.selection.main;
    slot.rich.selectSource(anchor, head);
  }
  if (activate) activateEditorPane(pane, focus);
  else { renderTabs(); updateTreeSelection(); renderControls(); }
  const view = slot.view, restoreSequence = slot.restoreSequence = (slot.restoreSequence || 0) + 1;
  requestAnimationFrame(() => { if (slot.view === view && slot.path === doc.path && slot.restoreSequence === restoreSequence) {
    view.scrollDOM.scrollTop = Math.max(0, Number(position?.scrollTop) || 0);
    if (editorMode(pane) === 'rich' && slot.rich) slot.richHost.scrollTop = Math.max(0, Number(position?.richScrollTop) || 0);
  } });
  if ((/\.(tex|bib)$/i.test(doc.path) || isMarkdown(doc.path)) && doc.indexedDoc !== doc.state.doc) updateIndex(doc.path, doc.state.doc.toString());
  renderRecovery(); renderPaneSelectors(); scheduleSession(); updateDocumentPreview({ immediate: true });
}

async function openFile(path, { pane = state.activePane, focus = true } = {}) {
  if (state.operation || state.closed) return;
  const sequence = ++state.openSequence;
  const generation = state.projectGeneration;
  const file = state.meta?.project?.files?.find(item => item.path === path);
  if ((file && fileKind(file) !== 'text') || (pane === 'secondary' && !state.splitEditors)) pane = 'primary';
  const slot = editorSlots[pane];
  const paneSequence = slot.openSequence = (slot.openSequence || 0) + 1;
  slot.pendingPath = path;
  if (file && fileKind(file) !== 'text') { await selectAsset(file); return; }
  let doc = state.documents.get(path);
  if (!doc) {
    let promise = state.pendingFiles.get(path);
    if (!promise) {
      promise = api(`/api/file?path=${encodeURIComponent(path)}`).then(file => {
        if (generation !== state.projectGeneration || state.pendingFiles.get(path) !== promise) return null;
        const loaded = makeDocument(file);
        state.documents.set(path, loaded);
        return loaded;
      }).finally(() => { if (state.pendingFiles.get(path) === promise) state.pendingFiles.delete(path); });
      state.pendingFiles.set(path, promise);
    }
    try { doc = await promise; }
    catch (error) { if (generation !== state.projectGeneration) return; throw error; }
  }
  if (doc && generation === state.projectGeneration && paneSequence === slot.openSequence && !state.operation && !state.closed) {
    slot.pendingPath = '';
    selectDocument(doc, { pane, focus: focus && sequence === state.openSequence, activate: state.activePane === pane || sequence === state.openSequence });
  }
}

async function selectAsset(file) {
  rememberEditorPosition(); rememberTab(file.path);
  destroyEditorSlot('primary'); editorSlots.primary.path = file.path; state.activePane = 'primary'; state.editor = null;
  for (const [name, slot] of Object.entries(editorSlots)) slot.element.classList.toggle('active', name === 'primary');
  const asset = state.assets.get(file.path) || {};
  Object.assign(asset, file);
  state.assets.set(file.path, asset); state.activePath = file.path;
  $('editor').hidden = true; $('editor-empty').hidden = true; $('conflict-banner').hidden = true;
  $('active-filename').textContent = file.path; $('active-filename').title = file.path;
  $('save-status').textContent = ''; $('save-status').classList.remove('dirty', 'error');
  renderTabs(); updateTreeSelection(); renderControls(); updateCursor(); renderOutline(); scheduleSession();
  if (!state.homeVisible) document.title = `${basename(file.path)} — Local TeX Web Editor`;
  updateDocumentPreview();
  applyPreviewVisibility();
  await assetPreview.show(asset, state.meta.project.root);
}

function renderTabs() {
  const container = $('editor-tabs');
  const scroll = container.scrollLeft;
  container.replaceChildren();
  state.tabElements.clear();
  for (const path of state.tabOrder) {
    const doc = state.documents.get(path);
    const file = doc || state.assets.get(path) || state.meta?.project?.files?.find(file => file.path === path);
    if (!file) continue;
    const tab = document.createElement('div');
    tab.className = `editor-tab${state.activePath === path ? ' active' : ''}`;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'tab-select'; button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.activePath === path));
    button.dataset.path = path; button.title = path; button.disabled = !!state.operation;
    const name = document.createElement('span'); name.textContent = basename(path);
    const dirty = document.createElement('span'); dirty.className = 'tab-dirty'; dirty.hidden = !isDirty(doc); dirty.setAttribute('aria-label', t("未保存"));
    button.append(name, dirty);
    button.addEventListener('click', () => runTask(() => openFile(path)));
    tab.draggable = true;
    tab.addEventListener('dragstart', event => {
      if (state.operation) { event.preventDefault(); return; }
      draggedTabPath = path; tab.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', path);
    });
    tab.addEventListener('dragover', event => { if (draggedTabPath && draggedTabPath !== path) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; tab.classList.add('drop-before'); } });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-before'));
    tab.addEventListener('drop', event => {
      if (!draggedTabPath || draggedTabPath === path) return;
      event.preventDefault();
      const moved = draggedTabPath; draggedTabPath = '';
      state.tabOrder = state.tabOrder.filter(item => item !== moved);
      state.tabOrder.splice(state.tabOrder.indexOf(path), 0, moved);
      renderTabs(); scheduleSession();
    });
    tab.addEventListener('dragend', () => { draggedTabPath = ''; for (const element of container.children) element.classList.remove('dragging', 'drop-before'); });
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'icon-button tab-close'; close.textContent = '×';
    close.setAttribute('aria-label', t("{value0} を閉じる", { value0: path })); close.disabled = !!state.operation;
    close.addEventListener('click', () => runTask(() => doc ? closeDocument(doc) : removeOpenFile(path)));
    tab.append(button, close); container.append(tab);
    state.tabElements.set(path, { tab, button, dirty, close });
  }
  container.scrollLeft = scroll;
}

function renderTree() {
  const project = state.meta?.project;
  const filter = $('file-filter').value.trim().toLocaleLowerCase();
  const tree = buildFileTree(project, { sort: state.preferences.fileSort, filter, locale: getLanguage() });
  $('file-sort').value = state.preferences.fileSort;
  const treeElement = $('file-tree'); const scroll = treeElement.scrollTop;
  const focused = treeElement.contains(document.activeElement) ? document.activeElement.closest('[data-path]') : null;
  const focusedPath = focused?.dataset.path;
  const focusedFolder = focused?.classList.contains('tree-directory');
  const dateFormat = new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'medium' });
  const entryTitle = entry => {
    const time = fileModificationTime(entry.modifiedAt);
    return time === null ? entry.path : `${entry.path}\n${t('更新日時: {value0}', { value0: dateFormat.format(time) })}`;
  };
  $('file-count').textContent = String(project?.files?.length || 0);
  treeElement.replaceChildren(); state.treeButtons.clear();
  if (!tree.files.length && !tree.directories.length) {
    const empty = document.createElement('p'); empty.className = 'tree-empty';
    empty.textContent = filter ? t("一致するファイルやフォルダーがありません．") : t("ファイルがありません．＋ からテキストファイルを作成できます．");
    treeElement.append(empty); if (focusedPath) treeElement.focus({ preventScroll: true }); return;
  }
  function appendNode(node, parent) {
    const list = document.createElement('ul'); list.className = 'tree-list'; parent.append(list);
    for (const child of node.directories) {
      const item = document.createElement('li'); const details = document.createElement('details'); details.className = 'tree-directory';
      const { path, name } = child;
      details.dataset.testid = 'tree-folder'; details.dataset.path = path;
      details.open = !!filter || (state.directoryState.has(path) ? state.directoryState.get(path) : state.activePath.startsWith(path + '/'));
      const summary = document.createElement('summary'); summary.setAttribute('aria-label', t("{value0} フォルダー", { value0: path }));
      summary.title = entryTitle(child); summary.dataset.modifiedAt = child.modifiedAt || '';
      summary.setAttribute('aria-haspopup', 'menu'); summary.setAttribute('aria-keyshortcuts', 'Shift+F10 F2 Delete');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('button-icon', 'folder-icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
      const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path'); outline.setAttribute('d', 'M2 6h7l2 2h11v12H2ZM2 6V4h7l2 2h9v2'); icon.append(outline);
      const label = document.createElement('span'); label.className = 'folder-name'; label.textContent = name;
      summary.append(icon, label); details.append(summary);
      appendNode(child, details);
      if (!child.files.length && !child.directories.length) { const empty = document.createElement('p'); empty.className = 'folder-empty'; empty.textContent = t("空のフォルダー"); details.append(empty); }
      details.addEventListener('toggle', () => { if (!filter && details.isConnected) { state.directoryState.set(path, details.open); scheduleSession(); } });
      item.append(details); list.append(item);
    }
    for (const file of node.files) {
      const item = document.createElement('li'); const button = document.createElement('button');
      button.type = 'button'; button.className = `file-button${file.path === state.activePath ? ' active' : ''}`;
      button.dataset.testid = `file-${file.path}`; button.dataset.path = file.path; button.dataset.kind = fileKind(file); button.dataset.modifiedAt = file.modifiedAt || ''; button.title = entryTitle(file); button.disabled = !!state.operation;
      button.setAttribute('aria-current', String(file.path === state.activePath));
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-keyshortcuts', 'Shift+F10 F2 Delete');
      const type = document.createElement('span'); type.className = 'file-type'; type.setAttribute('aria-hidden', 'true');
      type.textContent = basename(file.path).includes('.') ? file.path.split('.').pop().slice(0, 4) : fileKind(file) === 'text' ? 'txt' : 'file';
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = basename(file.path);
      const dirty = document.createElement('span'); dirty.className = 'file-unsaved'; dirty.hidden = !isDirty(state.documents.get(file.path));
      button.append(type, name, dirty); button.addEventListener('click', () => runTask(() => openFile(file.path)));
      item.append(button); list.append(item); state.treeButtons.set(file.path, button);
    }
  }
  appendNode(tree, treeElement); treeElement.scrollTop = scroll;
  if (focusedPath) {
    const target = focusedFolder ? treeElement.querySelector(`.tree-directory[data-path="${CSS.escape(focusedPath)}"] > summary`) : state.treeButtons.get(focusedPath);
    (target || treeElement).focus({ preventScroll: true });
  }
}

function applyProjectListing(project) {
  const current = state.meta?.project;
  if (!current || project?.root !== current.root || projectListingSignature(current) === projectListingSignature(project)) return;
  current.files = project.files || []; current.directories = project.directories || [];
  current.directoryModifiedAt = project.directoryModifiedAt || {};
  state.projectEntriesVersion++;
  renderTree(); renderPaneSelectors();
}

function updateDocumentIndicators(doc) {
  const dirty = isDirty(doc);
  const tab = state.tabElements.get(doc.path);
  if (tab) { tab.dirty.hidden = !dirty; tab.button.setAttribute('aria-label', `${doc.path}${dirty ? t("，未保存") : ''}`); }
  const treeButton = state.treeButtons.get(doc.path);
  if (treeButton) treeButton.querySelector('.file-unsaved').hidden = !dirty;
  if (state.activePath === doc.path) {
    $('save-status').textContent = doc.saving ? t("保存しています…") : doc.conflict ? t("保存の確認が必要") : dirty ? t("未保存") : t("保存済み");
    $('save-status').classList.toggle('dirty', dirty && !doc.conflict);
    $('save-status').classList.toggle('error', !!doc.conflict);
    $('conflict-banner').hidden = !doc.conflict;
    document.title = `${dirty ? '● ' : ''}${basename(doc.path)} — Local TeX Web Editor`;
  }
  renderControls();
}

async function saveDocument(doc) {
  if (doc.saving) return doc.saving;
  if (!isDirty(doc)) return true;
  const snapshot = doc.state.doc;
  const generation = state.projectGeneration;
  const preceding = state.saveQueue;
  const promise = (async () => {
    try {
      await preceding;
      if (generation !== state.projectGeneration) return false;
      const result = await api('/api/file', { method: 'PUT', body: { path: doc.path, content: snapshot.toString(), revision: doc.revision } });
      if (generation !== state.projectGeneration) return false;
      doc.revision = result.revision;
      doc.lineEnding = result.lineEnding || doc.lineEnding;
      doc.savedDoc = snapshot;
      doc.conflict = null;
      state.projectEntriesVersion++;
      if (result.entry && state.meta?.project) {
        const project = state.meta.project;
        const files = project.files.some(file => file.path === result.entry.path)
          ? project.files.map(file => file.path === result.entry.path ? result.entry : file)
          : [...project.files, result.entry];
        applyProjectListing({ ...project, files, directoryModifiedAt: result.directoryModifiedAt || project.directoryModifiedAt });
      }
      if (result.historyWarning) toast(result.historyWarning);
      if (state.build) {
        if (!isMarkdown(doc.path)) state.build.sourceChanged = true;
        if (state.build.pdfReady && sourceAffectsPDF(doc.path)) state.build.pdfSourceChanged = true;
      }
      updatePreviewNote();
      syncDrafts();
      return true;
    } catch (error) {
      if (error.status === 409) doc.conflict = error;
      const wrapped = new APIError(t("{value0} を保存できませんでした．{value1}", { value0: doc.path, value1: error.message || error }), error.status);
      showError(wrapped, error.status === 409 ? { label: t("内容を確認"), run: () => resolveConflict(doc) } : null);
      throw wrapped;
    } finally {
      doc.saving = null;
      if (generation === state.projectGeneration) { updateDocumentIndicators(doc); updateCursor(); }
    }
  })();
  doc.saving = promise;
  state.saveQueue = promise.catch(() => {});
  updateDocumentIndicators(doc);
  return promise;
}

async function saveAll() {
  for (const doc of state.documents.values()) {
    if (doc.saving) await doc.saving;
    if (isDirty(doc)) await saveDocument(doc);
  }
}

async function saveCurrent() {
  if (state.operation || !activeDocument()) return;
  const doc = activeDocument();
  if (doc.conflict) { await resolveConflict(doc); return; }
  if (doc.saving) await doc.saving;
  if (!isDirty(doc)) { toast(t("保存済みです．")); return; }
  await saveDocument(doc);
  clearError();
  toast(isDirty(doc) ? t("保存しました．その後の編集は未保存です．") : t("保存しました．"));
}

async function saveEveryDocument() {
  if (state.operation || !state.meta?.project) return;
  setOperation('saving');
  try { await saveAll(); clearError(); toast(t("開いているファイルを保存しました．")); }
  finally { setOperation(''); }
}

function choose({ title, description, primary = t('保存して続ける'), secondary = t('保存せずに続ける'), cancel = t('キャンセル') }) {
  const dialog = $('decision-dialog');
  $('decision-title').textContent = title; $('decision-description').textContent = description;
  $('decision-primary').textContent = primary; $('decision-secondary').textContent = secondary; $('decision-secondary').hidden = !secondary;
  $('decision-cancel').textContent = cancel;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; dialog.removeEventListener('cancel', cancelHandler); dialog.removeEventListener('close', closeHandler); if (dialog.open) dialog.close(); resolve(value); };
    const cancelHandler = event => { event.preventDefault(); finish('cancel'); };
    const closeHandler = () => finish('cancel');
    $('decision-primary').onclick = () => finish('primary');
    $('decision-secondary').onclick = () => finish('secondary');
    $('decision-cancel').onclick = () => finish('cancel');
    dialog.addEventListener('cancel', cancelHandler); dialog.addEventListener('close', closeHandler);
    dialog.showModal();
  });
}

async function confirmUnsaved(description) {
  const pending = [...state.documents.values()].map(doc => doc.saving).filter(Boolean);
  await Promise.allSettled(pending);
  syncDrafts(); persistSession(); await sessionStore.flush();
  const dirty = dirtyDocuments();
  if (!dirty.length) return true;
  const answer = await choose({ title: t("未保存の変更があります"), description: `${dirty.map(doc => doc.path).join('\n')}\n\n${description}`, secondary: t("草稿に残して続ける") });
  if (answer === 'cancel') return false;
  if (answer === 'primary') await saveAll();
  return true;
}

async function closeDocument(doc) {
  if (state.operation) return;
  if (doc.saving) await doc.saving;
  if (isDirty(doc)) {
    const answer = await choose({ title: t("未保存のファイルを閉じますか？"), description: doc.path, primary: t("保存して閉じる"), secondary: t("保存せずに閉じる") });
    if (answer === 'cancel') return;
    if (answer === 'primary') { await saveDocument(doc); if (isDirty(doc)) return; }
    else removeDraft(doc.draftId);
  }
  await removeOpenFile(doc.path);
}

async function closeAllDocuments() {
  if (state.operation || state.closed || !state.tabOrder.length) return;
  setOperation('closing');
  try {
    await Promise.allSettled([...state.documents.values()].map(doc => doc.saving).filter(Boolean));
    const dirty = dirtyDocuments();
    if (dirty.length) {
      const answer = await choose({
        title: t('すべてのタブを閉じますか？'),
        description: dirty.map(doc => doc.path).join('\n') + '\n\n' + t('未保存の変更があります．保存してからすべてのタブを閉じますか？'),
        primary: t('保存して閉じる'), secondary: t('保存せずに閉じる'),
      });
      if (answer === 'cancel') return;
      if (answer === 'primary') {
        await saveAll();
        if (dirtyDocuments().length) return;
      } else {
        for (const doc of dirty) {
          removeDraft(doc.draftId);
          updateIndex(doc.path, doc.savedDoc.toString(), false);
        }
        rebuildIndex();
      }
    }
    rememberEditorPosition();
    ++state.openSequence;
    state.pendingFiles.clear();
    destroyEditors();
    state.documents.clear(); state.assets.clear(); state.tabOrder = [];
    state.activePath = ''; state.lastMarkdownPath = '';
    assetPreview.hide(); markdownPreview.reset();
    $('editor').hidden = true; $('editor-empty').hidden = false;
    $('active-filename').textContent = t('原稿');
    $('active-filename').removeAttribute('title');
    $('save-status').textContent = ''; $('conflict-banner').hidden = true;
    document.title = 'Local TeX Web Editor';
    updateSourceLayout(); renderTabs(); renderTree(); renderOutline(); renderRecovery();
    updateCursor(); updatePreviewNote(); updateDocumentPreview();
    persistSession(); await sessionStore.flush();
    clearError();
  } finally { setOperation(''); }
}

async function removeOpenFile(path) {
  for (const slot of Object.values(editorSlots)) if (slot.pendingPath === path) { slot.openSequence = (slot.openSequence || 0) + 1; slot.pendingPath = ''; }
  if (state.operation) return;
  rememberEditorPosition();
  const generation = state.projectGeneration;
  const previousPane = state.activePane;
  const paths = [...state.tabOrder], index = paths.indexOf(path);
  state.documents.delete(path); state.assets.delete(path); state.tabOrder = paths.filter(item => item !== path);
  const following = [...state.tabOrder.slice(index), ...state.tabOrder.slice(0, index).reverse()];
  const next = following.find(item => state.documents.has(item) || state.meta?.project?.files?.some(file => file.path === item && fileKind(file) === 'text'));
  for (const [name, slot] of Object.entries(editorSlots)) {
    if (slot.path !== path) continue;
    destroyEditorSlot(name);
    if (next) await openFile(next, { pane: name, focus: false });
    if (generation !== state.projectGeneration || state.closed) return;
  }
  if (!editorSlots.secondary.view) state.splitEditors = false;
  if (state.activePath === path || !state.documents.has(state.activePath)) {
    const slot = editorSlots[previousPane].view ? previousPane : editorSlots.primary.view ? 'primary' : editorSlots.secondary.view ? 'secondary' : null;
    if (slot) activateEditorPane(slot, true);
    else {
      state.activePath = ''; state.editor = null; state.activePane = 'primary'; assetPreview.hide();
      $('editor').hidden = true; $('editor-empty').hidden = false; $('active-filename').textContent = t('原稿');
      $('save-status').textContent = ''; $('conflict-banner').hidden = true; updateCursor(); document.title = 'Local TeX Web Editor';
      const remaining = state.tabOrder[Math.min(index, state.tabOrder.length - 1)];
      if (remaining) runTask(() => openFile(remaining, { pane: 'primary' }));
    }
  } else if (editorSlots[previousPane].view) activateEditorPane(previousPane);
  updateSourceLayout(); renderTabs(); renderTree(); renderOutline(); renderControls(); updatePreviewNote(); updateDocumentPreview(); persistSession();
}

async function resolveConflict(doc) {
  if (!doc || state.operation) return;
  const remote = await api(`/api/file?path=${encodeURIComponent(doc.path)}`);
  $('conflict-description').textContent = t("{value0} は，読み込んだ後にディスクの内容が変更されました．保存する内容を選んでください．", { value0: doc.path });
  $('disk-content').value = remote.content;
  $('editing-content').value = doc.state.doc.toString();
  const dialog = $('conflict-dialog');
  const choice = await new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; dialog.removeEventListener('close', close); if (dialog.open) dialog.close(); resolve(value); };
    const close = () => finish('cancel');
    $('conflict-cancel').onclick = () => finish('cancel');
    $('conflict-use-disk').onclick = () => finish('disk');
    $('conflict-overwrite').onclick = () => finish('overwrite');
    dialog.addEventListener('close', close); dialog.showModal();
  });
  if (choice === 'cancel') return;
  if (choice === 'disk') {
    const content = normalise(remote.content);
    doc.revision = remote.revision; doc.lineEnding = remote.lineEnding || 'lf'; doc.conflict = null;
    const transaction = doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: content } });
    doc.savedDoc = transaction.state.doc;
    applyDocumentTransaction(doc, transaction);
    clearError(); updateDocumentIndicators(doc); updatePreviewNote(); syncDrafts(); toast(t("ディスクの内容を読み込みました．"));
  } else {
    doc.revision = remote.revision;
    doc.savedDoc = EditorState.create({ doc: normalise(remote.content) }).doc;
    await saveDocument(doc);
    doc.conflict = null;
    clearError(); updateDocumentIndicators(doc); toast(t("編集中の内容を保存しました．"));
  }
}

function recentPaths() {
  return (state.meta?.recentProjects || []).map(item => typeof item === 'string' ? item : item.root || item.path || '').filter(Boolean).slice(0, 12);
}
function renderRecent() {
  const paths = recentPaths();
  $('welcome-recent').hidden = paths.length === 0 && !state.meta?.project;
  $('project-recent').hidden = paths.length === 0;
  for (const id of ['project-recent-list']) {
    $(id).replaceChildren();
    for (const path of paths.slice(0, 6)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-project'; button.title = path;
      const name = document.createElement('strong'); name.textContent = basename(path);
      const detail = document.createElement('span'); detail.textContent = path; button.append(name, detail);
      button.addEventListener('click', () => { showProjectDialog(); $('project-path').value = path; });
      $(id).append(button);
    }
  }
  projectHome?.refresh();
}
function renderWorkspaceView() {
  const project = state.meta?.project;
  const home = state.homeVisible || !project;
  $('app-shell').classList.toggle('home-mode', home);
  if (!state.closed) { $('welcome').hidden = !home; $('workbench').hidden = home; }
  $('go-home').setAttribute('aria-current', home ? 'page' : 'false');
  $('project-name').textContent = home ? t('プロジェクト') : basename(project.root);
  $('project-name').title = home ? '' : project.root;
  if (!state.closed) document.title = home ? `${t('プロジェクト')} — Local TeX Web Editor`
    : state.activePath ? `${isDirty(activeDocument()) ? '● ' : ''}${basename(state.activePath)} — Local TeX Web Editor` : 'Local TeX Web Editor';
}
function showHome() {
  if (state.operation || state.closed) return;
  if (state.homeVisible) { $('home-title').focus(); return; }
  rememberEditorPosition(); syncDrafts(); persistSession();
  state.homeVisible = true;
  renderRecent(); renderWorkspaceView();
  document.title = `${t('プロジェクト')} — Local TeX Web Editor`;
  $('home-title').focus();
}
function resumeProject() {
  if (state.operation || state.closed || !state.meta?.project) return;
  state.homeVisible = false; renderWorkspaceView(); renderControls(); panelLayout.refresh();
  if (state.editor && activeDocument()) activateEditorPane(state.activePane, true);
  requestAnimationFrame(() => { viewer.refreshLayout(); assetPreview.refreshLayout?.(); });
}
async function beginProjectDeletion() {
  if (state.operation || state.closed || isRunning()) return false;
  try {
    await beginFileAction();
    await sessionStore.settle();
    return true;
  } catch (error) { setOperation(''); throw error; }
}
async function completeProjectDeletion(result) {
  const roots = new Set([result.path, ...(result.removedProjects || [])].filter(Boolean));
  const reset = state.meta?.project?.root !== result.state?.project?.root;
  if (reset) {
    state.persistenceReady = false;
    clearTimeout(state.autoSaveTimer); clearTimeout(state.draftTimer); clearTimeout(state.sessionTimer);
    if (state.meta?.project?.root) roots.add(state.meta.project.root);
  }
  for (const root of roots) { sessionStore.forget(`session:${root}`); sessionStore.forget(`drafts:${root}`); }
  await applyMeta(result.state, reset);
  state.homeVisible = true; renderRecent(); renderWorkspaceView(); clearError();
}

async function applyMeta(meta, resetProject = false) {
  if (state.closed) return;
  if (!resetProject && state.meta?.project && meta.project?.root !== state.meta.project.root) {
    handleExternalProjectChange();
    return;
  }
  if (resetProject && state.persistenceReady) { syncDrafts(); persistSession(); }
  const generation = resetProject ? ++state.projectGeneration : state.projectGeneration;
  state.meta = meta;
  state.projectEntriesVersion++;
  state.texPackages = meta.texPackages || null;
  state.externalProjectChanged = false;
  if (resetProject) {
    state.homeVisible = !meta.project;
    projectSearch?.close(); documentHistory?.close();
    clearTimeout(state.autoSaveTimer); clearTimeout(state.draftTimer); clearTimeout(state.sessionTimer); clearTimeout(state.outlineTimer);
    state.persistenceReady = false; state.initialFilePending = !!meta.project; state.session = null; state.drafts = { entries: [] }; state.recoverySelection = null;
    state.texIndex.clear(); state.completionItems = { citations: [], labels: [] }; state.indexError = ''; state.indexing = false;
    clearTimeout(state.pollTimer); state.pollTimer = null;
    state.documents.clear(); state.assets.clear(); state.tabOrder = []; state.directoryState.clear(); state.pendingFiles.clear(); state.activePath = ''; ++state.openSequence;
    assetPreview.hide(); markdownPreview.reset();
    state.previewMode = 'pdf'; state.previewChoice = 'auto'; state.lastMarkdownPath = '';
    $('pdf-preview').hidden = false; $('markdown-preview-panel').hidden = true;
    destroyEditors(); $('editor').hidden = true; $('editor-empty').hidden = false;
    $('conflict-banner').hidden = true; $('file-filter').value = ''; $('save-status').textContent = ''; $('active-filename').textContent = t("原稿");
    navigationHistory?.clear(); state.build = null; state.reportedBuild = ''; await viewer.reset();
  }
  if (generation !== state.projectGeneration) return;
  const project = meta.project;
  if (project && resetProject) await loadProjectSession(project.root, generation);
  if (generation !== state.projectGeneration) return;
  renderWorkspaceView();
  $('project-root').textContent = project?.root || ''; $('project-root').title = project?.root || '';
  updateApplicationDetails(meta);
  renderRecent(); renderTree(); renderTabs(); renderControls(); updateCursor(); renderOutline(); renderRecovery();
  applyBuild(meta.build);
  if (project && resetProject) runTask(() => indexProject());
  await openInitialFile();
}

function showProjectDialog() {
  if (state.operation || state.closed) return;
  if (isRunning()) { showError(new Error(t("コンパイルが終了してからプロジェクトを切り替えてください．"))); return; }
  $('project-path').value = state.meta?.project?.root || '';
  $('project-tex-bin').value = state.meta?.texBin || '';
  $('project-tex-help').textContent = state.meta?.latexmk ? `latexmk: ${state.meta.latexmk}` : isMac ? t("例: /Library/TeX/texbin") : t("例: C:\\texlive\\2025\\bin\\windows");
  $('project-error').hidden = true; renderRecent();
  if (!$('project-dialog').open) $('project-dialog').showModal();
  $('project-path').focus();
}

function setDialogBusy(dialog, busy) {
  dialog.dataset.busy = String(busy);
  for (const element of dialog.querySelectorAll('button, input, select')) element.disabled = busy;
}

async function openProject(event) {
  event.preventDefault();
  if (state.operation || state.folderPicker) return;
  const path = $('project-path').value.trim(); const texBin = $('project-tex-bin').value.trim();
  if (!path) return;
  const dialog = $('project-dialog'); $('project-error').hidden = true;
  setOperation('opening'); setDialogBusy(dialog, true);
  try {
    if (!await confirmUnsaved(t("プロジェクトを切り替える前に，変更を保存しますか？"))) return;
    if (texBin !== (state.meta?.texBin || '')) await api('/api/settings', { method: 'PUT', body: { texBin } });
    const meta = await api('/api/project/open', { method: 'POST', body: { path } });
    await applyMeta(meta, true);
    dialog.close(); clearError();
  } catch (error) { $('project-error').textContent = error.message || String(error); $('project-error').hidden = false; }
  finally {
    setDialogBusy(dialog, false); setOperation('');
    runTask(openInitialFile);
  }
}

async function pickProject() {
  if (state.operation || !$('project-dialog').open) return;
  const request = state.folderPicker || { controller: new AbortController(), selected: false }; state.folderPicker = request;
  $('project-error').hidden = true; renderPickerState();
  try {
    const result = await api('/api/project/pick', { method: 'POST', body: {}, timeout: 0, signal: request.controller.signal });
    if (state.folderPicker === request && $('project-dialog').open && result.path) { $('project-path').value = result.path; request.selected = true; }
  } catch (error) {
    if (error.name !== 'AbortError' && state.folderPicker === request && $('project-dialog').open) { $('project-error').textContent = error.message || String(error); $('project-error').hidden = false; }
  } finally { if (state.folderPicker === request) { state.folderPicker = null; request.controller.abort(); renderPickerState(); if (request.selected) $('project-path').focus(); } }
}
function renderPickerState() {
  const pending = !!state.folderPicker;
  $('project-picker-status').hidden = !pending;
  $('pick-project').textContent = pending ? t("選択画面を表示") : t("参照…");
  for (const id of ['project-path', 'project-tex-bin', 'open-project']) $(id).disabled = pending;
  $('pick-project').disabled = false;
  for (const button of $('project-recent-list').querySelectorAll('button')) button.disabled = pending;
}
function cancelPicker() {
  if (!state.folderPicker) return;
  state.folderPicker.controller.abort(); state.folderPicker = null; renderPickerState();
}

function renderToolStatus() {
  $('tex-tool-status').textContent = state.meta?.latexmk ? `latexmk: ${state.meta.latexmk}` : state.meta?.toolError || t("例: C:\\texlive\\2025\\bin\\windows．空欄の場合は自動で検索します．");
  $('synctex-tool-status').textContent = state.meta?.synctex ? `synctex: ${state.meta.synctex}` : state.meta?.synctexError || t("SyncTeX で，原稿と PDF の対応する位置へ移動できます．");
  const synctexCommands = state.meta?.synctexInstallCommands || [];
  $('synctex-setup').hidden = !synctexCommands.length;
  $('synctex-setup-help').textContent = t('次のコマンドを {value0} で実行し，設定を開き直して SyncTeX のパスを確認してください．', { value0: isMac ? t('ターミナル') : 'PowerShell' });
  $('synctex-install-commands').textContent = synctexCommands.join('\n');
  renderTeXPackagesHelp($('tex-packages-help'), state.texPackages);
}
function updateApplicationDetails(meta) {
  $('app-version').textContent = meta.version ? `v${meta.version}` : '';
  $('application-version').textContent = meta.version ? `v${meta.version}` : '';
  $('application-executable').textContent = meta.executablePath || '';
}
function updateTools(meta) {
  if (!state.meta) return;
  for (const key of ['texBin', 'latexmk', 'toolError', 'synctex', 'synctexError']) state.meta[key] = meta[key] || '';
  state.meta.synctexInstallCommands = meta.synctexInstallCommands || [];
  state.meta.texPackages = meta.texPackages || null;
  state.texPackages = state.meta.texPackages;
  updateApplicationDetails(meta);
  if ($('settings-dialog').open) renderToolStatus();
  renderControls();
}

async function showSettings() {
  if (state.operation || state.closed) return;
  if (isRunning()) { showError(new Error(t("コンパイルが終了してから設定を変更してください．"))); return; }
  const project = state.meta?.project;
  const generation = state.projectGeneration;
  const toolsGeneration = state.toolsGeneration;
  const previousTexBin = state.meta?.texBin || '';
  $('tex-bin').value = previousTexBin;
  renderToolStatus();
  $('main-file').replaceChildren();
  for (const file of project?.files || []) if (/\.tex$/i.test(file.path)) { const option = document.createElement('option'); option.value = file.path; option.textContent = file.path; $('main-file').append(option); }
  if (project?.main && ![...$('main-file').options].some(option => option.value === project.main)) { const option = document.createElement('option'); option.value = project.main; option.textContent = project.main; $('main-file').append(option); }
  $('main-file').value = project?.main || '';
  $('compile-mode').value = project?.mode || 'pdflatex';
  $('autosave-setting').checked = state.preferences.autoSave;
  $('tex-completion-setting').checked = state.preferences.texCompletion;
  $('completion-on-type-setting').checked = state.preferences.automaticCompletion;
  $('completion-on-type-setting').disabled = !state.preferences.texCompletion;
  $('language-setting').value = state.preferences.language;
  $('editor-font-size').value = String(state.preferences.editorFontSize);
  $('main-field').hidden = !project; $('mode-field').hidden = !project;
  $('shortcut-settings').hidden = state.meta?.platform !== 'windows' || state.meta?.shortcutsSupported === false;
  $('store-installation-note').hidden = !state.meta?.packageIdentity;
  $('settings-error').hidden = true; $('settings-dialog').showModal();
  try {
    const meta = await api('/api/state');
    if (generation !== state.projectGeneration || toolsGeneration !== state.toolsGeneration) return;
    if (meta.project?.root !== state.meta?.project?.root) { handleExternalProjectChange(); return; }
    updateTools(meta);
    if ($('settings-dialog').open && $('tex-bin').value === previousTexBin) $('tex-bin').value = state.meta.texBin;
  } catch (error) {
    if ($('settings-dialog').open) { $('settings-error').textContent = error.message || String(error); $('settings-error').hidden = false; }
  }
}

async function saveSettings(event) {
  event.preventDefault(); if (state.operation) return;
  const body = {};
  const language = $('language-setting').value;
  const languageChanged = language !== state.preferences.language;
  const texBin = $('tex-bin').value.trim();
  if (texBin !== (state.meta?.texBin || '')) body.texBin = texBin;
  const project = state.meta?.project;
  if (project && $('main-file').value !== project.main) body.main = $('main-file').value;
  if (project && $('compile-mode').value !== project.mode) body.mode = $('compile-mode').value;
  setOperation('settings'); setDialogBusy($('settings-dialog'), true); $('settings-error').hidden = true;
  try {
    if (Object.keys(body).length) { ++state.toolsGeneration; const meta = await api('/api/settings', { method: 'PUT', body }); await applyMeta(meta); }
    state.preferences.autoSave = $('autosave-setting').checked;
    state.preferences.texCompletion = $('tex-completion-setting').checked;
    state.preferences.automaticCompletion = $('completion-on-type-setting').checked;
    applyCompletionSettings();
    state.preferences.language = language;
    applyEditorFontSize($('editor-font-size').valueAsNumber);
    savePreferences(); await sessionStore.flush();
    applyLanguage(language);
    if (languageChanged) {
      const meta = await api('/api/state');
      if (meta.project?.root === state.meta?.project?.root) await applyMeta(meta);
    }
    $('settings-dialog').close(); clearError(); updateAutoSaveStatus(); toast(t("設定を保存して反映しました．"));
  }
  catch (error) { $('settings-error').textContent = error.message || String(error); $('settings-error').hidden = false; }
  finally { setDialogBusy($('settings-dialog'), false); setOperation(''); }
}

async function createShortcut(destination) {
  if (state.operation || state.closed || state.meta?.platform !== 'windows') return;
  const label = destination === 'desktop' ? t("デスクトップのショートカット") : t("スタートメニューのショートカット");
  const resultElement = $('shortcut-result');
  resultElement.hidden = false; resultElement.classList.remove('error'); resultElement.setAttribute('role', 'status');
  resultElement.textContent = t("{value0}を作成しています…", { value0: label }); $('shortcut-paths').hidden = true;
  setOperation('shortcut'); setDialogBusy($('settings-dialog'), true);
  try {
    const result = await api('/api/shortcuts', { method: 'POST', body: { destination }, timeout: 60000, projectRoot: null });
    resultElement.textContent = result.message || t("{value0}を作成しました．", { value0: label });
    $('shortcut-executable').textContent = result.executable || '';
    $('shortcut-path').textContent = result.shortcut || '';
    $('shortcut-paths').hidden = false;
  } catch (error) {
    resultElement.textContent = t("{value0}を作成できませんでした．{value1}", { value0: label, value1: error.message || error });
    resultElement.classList.add('error'); resultElement.setAttribute('role', 'alert');
  } finally { setDialogBusy($('settings-dialog'), false); setOperation(''); }
}

async function refreshFiles() {
  if (state.operation || !state.meta?.project) return;
  const meta = await api('/api/state');
  if (meta.project?.root !== state.meta.project.root) { handleExternalProjectChange(); return; }
  await applyMeta(meta); await indexProject(true); toast(t("ファイル一覧を更新しました．"));
}

function showNewFile(folder = '') {
  if (!state.meta?.project || state.operation || state.closed) return;
  $('new-file-path').value = folder ? `${folder}/` : '';
  $('new-file-error').hidden = true; $('new-file-dialog').showModal(); $('new-file-path').focus();
  $('new-file-path').setSelectionRange($('new-file-path').value.length, $('new-file-path').value.length);
}

async function beginFileAction() {
  setOperation('file-action');
  await state.saveQueue;
  await Promise.allSettled([...state.pendingFiles.values()]);
  setOperation('file-action');
  syncDrafts(); persistSession();
}

function uploadProjectFile(path, file, { projectRoot, revision, signal } = {}) {
  return api(`/api/files/import?path=${encodeURIComponent(path)}`, {
    method: 'POST', body: file, binary: true, projectRoot, signal, timeout: 120000,
    headers: revision ? { 'X-File-Revision': revision } : {},
  });
}

async function applyImportedFile(result) {
  const paths = [...new Set((result.importedPaths || [result.path]).filter(path => typeof path === 'string' && path))];
  for (const path of paths) {
    state.texIndex.delete(path);
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) state.directoryState.set(path.slice(0, end), true);
  }
  await applyMeta(result.state);
  if (state.build && paths.length) {
    state.build.sourceChanged = true;
    if (state.build.pdfReady && paths.some(sourceAffectsPDF)) state.build.pdfSourceChanged = true;
  }
  for (const [, slot] of visibleEditorSlots()) for (const path of paths) slot.rich?.refreshImages(path, { caseInsensitive: state.meta?.platform === 'windows' });
  markdownPreview.refresh();
  await indexProject();
  updatePreviewNote(); persistSession(); clearError();
}

async function inspectOpenDocuments(entry, action) {
  for (const doc of state.documents.values()) {
    if (!entryContains(entry, doc.path)) continue;
    const listed = entry.directory && Array.isArray(entry.entries) ? entry.entries.find(item => item.path === doc.path && !item.directory) : null;
    if (entry.directory && Array.isArray(entry.entries) && !listed && action === 'delete') continue;
    const revision = entry.directory ? listed?.contentRevision ?? (await api(`/api/file?path=${encodeURIComponent(doc.path)}`)).revision : entry.contentRevision;
    if (doc.revision !== revision || doc.conflict) throw new Error(`${doc.path}\n${fileActionText('stale')}`);
  }
}

function assertNewFilePathAvailable(path, sourceEntry = null) {
  const candidates = [...state.documents.keys(), ...state.assets.keys(), ...state.tabOrder, ...state.pendingFiles.keys(), ...(state.drafts.entries || []).map(draft => draft.path)];
  const conflict = fileDestinationConflict(path, candidates, { source: sourceEntry, platform: state.meta?.platform });
  if (conflict) throw new Error(`${conflict}\n${fileActionText('occupied')}`);
}

async function applyEntryChange(result) {
  const { oldPath, path, directory, removed } = result;
  if (!oldPath) { await applyMeta(result.state); persistSession(); return; }
  rememberEditorPosition(); ++state.projectGeneration;
  state.pendingFiles.clear(); clearTimeout(state.outlineTimer);
  const affected = value => !!value && entryContains({ path: oldPath, directory }, value);
  const mapped = value => affected(value) ? (removed ? '' : mapEntryPath(value, oldPath, path, directory)) : value;
  const wasActive = affected(state.activePath), wasMarkdown = affected(state.lastMarkdownPath);
  const previousPane = state.activePane;
  for (const slot of Object.values(editorSlots)) { slot.openSequence = (slot.openSequence || 0) + 1; slot.pendingPath = ''; }
  if (removed) {
    for (const [name, slot] of Object.entries(editorSlots)) if (affected(slot.path)) destroyEditorSlot(name);
    for (const key of state.documents.keys()) if (affected(key)) state.documents.delete(key);
    for (const key of state.assets.keys()) if (affected(key)) state.assets.delete(key);
    if (wasActive) { state.activePath = ''; state.editor = null; assetPreview.hide(); }
    if (!editorSlots.secondary.view) state.splitEditors = false;
  } else {
    for (const slot of Object.values(editorSlots)) slot.path = mapped(slot.path);
    const documents = [...state.documents];
    for (const [key, doc] of documents) if (affected(key)) { state.documents.delete(key); doc.path = mapped(key); state.documents.set(doc.path, doc); }
    for (const [key, asset] of [...state.assets]) if (affected(key)) { state.assets.delete(key); asset.path = mapped(key); state.assets.set(asset.path, asset); }
    state.activePath = mapped(state.activePath);
    for (const [key, doc] of documents) if (affected(key)) {
      applyDocumentTransaction(doc, doc.state.update({ effects: [editorDocumentPath.reconfigure(documentPathExtension(doc.path)), editorCompletion.reconfigure(completionExtension(doc.path))] }));
    }
  }
  state.tabOrder = state.tabOrder.map(mapped).filter(Boolean);
  state.lastMarkdownPath = mapped(state.lastMarkdownPath);
  state.directoryState = new Map([...state.directoryState].map(([key, value]) => [mapped(key), value]).filter(([key]) => key));
  if (state.session) state.session.positions = Object.fromEntries(Object.entries(state.session.positions || {}).map(([key, value]) => [mapped(key), value]).filter(([key]) => key));
  state.drafts = { version: 1, updatedAt: Date.now(), entries: (state.drafts.entries || []).filter(item => !removed || !affected(item.path)).map(item => ({ ...item, path: mapped(item.path) })) };
  sessionStore.write(`drafts:${state.meta.project.root}`, state.drafts, 0);
  navigationHistory?.mapEntries(location => {
    for (const key of ['source', 'asset', 'markdown']) {
      if (!location[key]?.path || !affected(location[key].path)) continue;
      if (removed) return null;
      location[key].path = mapped(location[key].path);
    }
    return location;
  });
  if (wasMarkdown) markdownPreview.reset();
  state.texIndex.clear(); state.indexing = false; state.indexError = ''; rebuildIndex();
  await applyMeta(result.state);
  for (const [name, slot] of visibleEditorSlots()) {
    if (slot.rich) slot.rich.setDocument({ text: slot.view.state.doc.toString(), path: slot.path, projectRoot: state.meta?.project?.root });
    ensureRichEditor(slot, name);
  }
  if (state.build) {
    state.build.sourceChanged = true;
    if (state.build.pdfReady) state.build.pdfSourceChanged = true;
  }
  if (wasActive && removed) {
    const pane = editorSlots[previousPane].view ? previousPane : editorSlots.primary.view ? 'primary' : editorSlots.secondary.view ? 'secondary' : null;
    if (pane) activateEditorPane(pane);
    else {
      state.activePane = 'primary'; $('editor').hidden = true; $('editor-empty').hidden = false;
      $('active-filename').textContent = t('原稿'); $('save-status').textContent = ''; $('conflict-banner').hidden = true;
      document.title = 'Local TeX Web Editor';
    }
  } else if (state.documents.has(state.activePath)) activateEditorPane(state.activePane);
  updateSourceLayout(); renderTree(); renderTabs(); renderPaneSelectors(); renderOutline(); renderRecovery(); renderControls(); updateCursor(); updatePreviewNote(); updateDocumentPreview({ immediate: true });
  syncDrafts(); persistSession();
  return async () => {
    if ((!state.activePath || !editorSlots.primary.path) && state.tabOrder.length) {
      await openFile(state.tabOrder[0], { pane: 'primary', focus: !state.activePath });
      if (previousPane === 'secondary' && editorSlots.secondary.view) activateEditorPane(previousPane);
    }
    else if (wasActive && state.assets.has(state.activePath)) await selectAsset(state.assets.get(state.activePath));
    await indexProject(true); persistSession();
  };
}

async function createFile(event) {
  event.preventDefault(); if (state.operation) return;
  const path = $('new-file-path').value.trim().replace(/\\/g, '/'); if (!path) return;
  setOperation('creating'); setDialogBusy($('new-file-dialog'), true); $('new-file-error').hidden = true;
  let created = null;
  try {
    assertNewFilePathAvailable(path);
    const file = await api('/api/file', { method: 'PUT', body: { path, content: '', revision: '' } });
    created = makeDocument(file); state.documents.set(file.path, created);
    const meta = await api('/api/state'); await applyMeta(meta);
    $('new-file-dialog').close(); clearError();
  } catch (error) { $('new-file-error').textContent = error.message || String(error); $('new-file-error').hidden = false; }
  finally { setDialogBusy($('new-file-dialog'), false); setOperation(''); }
  if (created) selectDocument(created);
}

function setLogVisible(visible) {
  $('log-panel').hidden = !visible;
  $('log-toggle').setAttribute('aria-expanded', String(visible));
  panelLayout.refresh();
}
function formatElapsed(ms) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? t("{value0} 秒", { value0: seconds }) : t("{value0} 分 {value1} 秒", { value0: Math.floor(seconds / 60), value1: seconds % 60 }); }
function updateElapsed() {
  const build = state.build;
  const ms = build?.status === 'running' && build.startedAt ? Date.now() - new Date(build.startedAt).getTime() : build?.elapsedMs;
  $('build-elapsed').textContent = typeof ms === 'number' && Number.isFinite(ms) ? formatElapsed(ms) : '';
}

function updatePreviewNote() {
  const build = state.build;
  updatePDFDetails();
  const note = $('pdf-note'); const label = $('pdf-state');
  note.hidden = true; note.classList.remove('error'); label.classList.remove('stale');
  if (!build?.pdfReady) { label.textContent = t('コンパイル前'); return; }
  if (build.status === 'failed') { note.textContent = t("最新のコンパイルに失敗しました．前回成功した PDF を表示しています．"); note.classList.add('error'); label.textContent = t("前回の PDF"); }
  else if (build.status === 'cancelled') { note.textContent = t("コンパイルを停止しました．前回成功した PDF を表示しています．"); label.textContent = t("前回の PDF"); }
  else if (build.status === 'running') { note.textContent = t("コンパイル中です．完了すると PDF が更新されます．"); label.textContent = t("更新待ち"); }
  else if ((build.pdfSourceChanged ?? build.sourceChanged) || dirtyDocuments().some(doc => sourceAffectsPDF(doc.path))) { note.textContent = t("原稿に変更があります．最新の内容を確認するにはコンパイルしてください．"); label.textContent = t("原稿に変更あり"); }
  else { label.textContent = viewer.hasRendered && viewer.buildId === build.pdfBuildId ? t("更新済み") : t("読み込み中"); return; }
  note.hidden = false; label.classList.add('stale');
}

function updatePDFDetails() {
  const main = viewer.document ? viewer.documentMain : (state.build?.pdfReady ? state.build.pdfMain || state.meta?.project?.main : '') || '';
  $('pdf-name').textContent = main ? basename(main).replace(/\.tex$/i, '') + '.pdf' : '—';
  $('pdf-document').textContent = main || '—';
}

function applyBuild(build) {
  if (state.closed) return;
  if (build && state.build) {
    if (build.id === state.build.id && state.build.status !== 'running' && build.status === 'running') return;
    if (build.id !== state.build.id && Date.parse(build.startedAt) < Date.parse(state.build.startedAt)) return;
    // A response that began before a save must not clear that save's notice.
    if (build.id === state.build.id && state.build.sourceChanged) build = { ...build, sourceChanged: true };
    if (build.pdfBuildId && build.pdfBuildId === state.build.pdfBuildId && state.build.pdfSourceChanged) build = { ...build, pdfSourceChanged: true };
  }
  const previouslyRunning = isRunning();
  state.build = build || null;
  const pdfMain = build?.pdfMain || (build?.pdfReady ? state.meta?.project?.main : '') || '';
  const labels = { running: t("コンパイル中"), success: t("コンパイル完了"), failed: t("コンパイル失敗"), cancelled: t("停止しました") };
  $('build-status').textContent = labels[build?.status] || t("コンパイル前");
  $('build-status').dataset.status = build?.status || 'idle';
  $('log-indicator').hidden = build?.status !== 'failed';
  updateElapsed();
  if (build) {
    const text = [build.command ? `$ ${build.command}` : '', build.log || '', build.error ? `\n${build.error}` : ''].filter(Boolean).join('\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    state.fullLog = text || t("プロセスからの出力を待っています…");
    const output = $('build-log'); const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 55;
    const displayed = state.fullLog.length > 300000 ? t("ログの末尾 300,000 文字を表示しています．「コピー」で受け取ったログ全体を取得できます．\n\n{value0}", { value0: state.fullLog.slice(-300000) }) : state.fullLog;
    if (output.textContent !== displayed) { output.textContent = displayed; if (follow) output.scrollTop = output.scrollHeight; renderLogLocations(); }
    const exit = Number.isInteger(build.exitCode) ? t("終了コード {value0}", { value0: build.exitCode }) : t("実行中");
    $('log-meta').textContent = `${exit}${build.finishedAt ? ` · ${formatElapsed(build.elapsedMs || 0)}` : ''}`;
    if (build.status === 'failed' && state.reportedBuild !== `${build.id}:failed`) {
      state.reportedBuild = `${build.id}:failed`; setLogVisible(true);
      showError(new Error(build.error || t("コンパイルに失敗しました (終了コード {value0})．ログを確認してください．", { value0: build.exitCode ?? t("不明") })));
    }
    if (build.pdfReady && build.pdfBuildId && state.meta?.project) viewer.load(build.pdfBuildId, state.meta.project.root, pdfMain).catch(error => showError(error));
    if (build.status === 'running') schedulePoll(650);
    else { clearTimeout(state.pollTimer); state.pollTimer = null; }
  } else {
    state.fullLog = ''; $('build-log').textContent = t("コンパイルすると，ここにコマンドとログが表示されます．"); $('log-meta').textContent = '';
    renderLogLocations();
    if (viewer.document || viewer.loadingTask) viewer.reset().catch(error => showError(error));
  }
  updatePreviewNote(); renderControls();
  updateAutoSaveStatus();
  if (previouslyRunning && !isRunning()) { scheduleAutoSave(); runTask(heartbeat); }
}

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  if (state.closed) return;
  state.pollTimer = setTimeout(() => runTask(pollBuild), delay);
}
async function pollBuild() {
  if (state.polling || state.closed || !state.meta?.project) return;
  state.polling = true;
  const generation = state.projectGeneration;
  const expectedId = state.build?.id;
  try {
    const build = await api('/api/build');
    if (state.closed || generation !== state.projectGeneration) return;
    if (expectedId && state.build?.id !== expectedId && build?.id !== state.build?.id) return;
    applyBuild(build);
  }
  catch (error) { if (generation === state.projectGeneration) { showError(error); if (isRunning()) schedulePoll(3000); } }
  finally { state.polling = false; }
}

async function startBuild() {
  if (state.operation || isRunning() || !state.meta?.project || state.closed) return;
  if (state.editor?.composing) return;
  const doc = activeDocument();
  const useMarkdown = !!doc && isMarkdown(doc.path);
  const main = currentCompileTarget();
  if (!useMarkdown && !main) { await showSettings(); return; }
  setOperation(useMarkdown ? 'previewing' : 'compiling'); $('build-status').textContent = t("ファイルを保存しています…"); clearError();
  try {
    await saveAll();
    if (useMarkdown) { updateDocumentPreview({ immediate: true }); markdownPreview.refresh(); return; }
    const build = await api('/api/build', { method: 'POST', body: { main } });
    applyBuild(build);
  } catch (error) { if (!error?.shown) showError(error); }
  finally { setOperation(''); if (!isRunning()) { const current = state.build; $('build-status').textContent = current ? ({ success: t("コンパイル完了"), failed: t("コンパイル失敗"), cancelled: t("停止しました") }[current.status] || t("コンパイル前")) : t("コンパイル前"); } }
}

async function stopBuild() {
  if (!isRunning() || state.operation) return;
  $('stop-button').disabled = true;
  try { const build = await api('/api/build/stop', { method: 'POST', body: {}, timeout: 30000 }); applyBuild(build); }
  finally { renderControls(); }
}

function renderControls() {
  const project = state.meta?.project;
  const busy = !!state.operation || state.closed;
  const doc = activeDocument();
  const running = isRunning();
  const useMarkdown = !!doc && isMarkdown(doc.path);
  const main = currentCompileTarget();
  $('compile-button').disabled = busy || running || !project || (!useMarkdown && !main) || state.externalProjectChanged;
  $('compile-label').textContent = ['compiling', 'previewing'].includes(state.operation) ? t("保存しています…") : running ? t("コンパイル中") : useMarkdown ? t("プレビュー") : t("コンパイル");
  $('compile-button').title = useMarkdown ? t("保存して Markdown のプレビューを更新 ({value0}+Enter)", { value0: shortcutModifier }) : t("保存して {value0} をコンパイル ({value1}+Enter)", { value0: main || t("原稿"), value1: shortcutModifier });
  $('main-document-label').textContent = useMarkdown ? `${doc.path} · Markdown` : project ? `${main || t("原稿を選択")} · ${modeLabels[project.mode] || project.mode}` : t("原稿を選択");
  $('main-document').title = useMarkdown ? t("編集とコンパイルの設定を開く") : t("コンパイル対象: {value0}\n既定のメイン文書とコンパイラーの設定を開く", { value0: main || t("未選択") });
  $('compile-icon').classList.toggle('spinning', running || state.operation === 'compiling');
  $('compile-icon').textContent = running || state.operation === 'compiling' ? '' : '▶';
  $('stop-button').hidden = !running; $('stop-button').disabled = busy || !running;
  $('save-button').disabled = busy || !doc || !!doc.saving || !isDirty(doc) || state.externalProjectChanged;
  $('find-button').disabled = !doc || state.closed;
  const missingSynctex = state.meta && typeof state.meta.synctex === 'string' && !state.meta.synctex;
  $('synctex-forward').disabled = busy || state.syncing || !doc || !project || state.externalProjectChanged ||
    (!useMarkdown && (!(viewer.ready || (state.previewMode === 'markdown' && viewer.document)) || !state.build?.synctexReady || missingSynctex));
  $('synctex-forward').title = useMarkdown ? t("カーソル位置を Markdown で表示 ({value0}+クリックでも移動)", { value0: shortcutModifier }) : missingSynctex ? t("SyncTeX が見つかりません．設定に導入の手順があります．") : state.build?.synctexReady ? t("カーソル位置を PDF で表示 ({value0}+クリックでも移動)", { value0: shortcutModifier }) : t("SyncTeX を使うには，このアプリで PDF をコンパイルしてください．");
  $('synctex-forward').setAttribute('aria-label', t(useMarkdown ? 'Markdown のプレビューの位置へ移動' : 'PDF の位置へ移動'));
  $('main-document').disabled = busy || !project || running;
  $('settings-button').disabled = busy || running;
  $('show-project').disabled = busy || running;
  $('welcome-open').disabled = busy;
  $('shutdown-button').disabled = busy;
  $('new-file').disabled = busy || !project;
  $('import-files').disabled = busy || !project || running;
  $('file-sort').disabled = busy || !project;
  $('close-all-tabs').disabled = busy || !state.tabOrder.length;
  $('refresh-files').disabled = busy || !project;
  $('download-pdf').disabled = !state.build?.pdfReady || state.closed;
  $('copy-log').disabled = !state.fullLog;
  $('theme-toggle').disabled = state.closed;
  $('help-button').disabled = state.closed;
  help?.refresh();
  $('project-search-button').disabled = busy || !project;
  $('split-editors').disabled = busy || !doc;
  for (const id of ['reference-tools', 'document-history', 'insert-image', 'insert-table']) $(id).disabled = busy || !doc;
  for (const id of ['markdown-new-page', 'markdown-export-pdf']) $(id).disabled = busy || !useMarkdown;
  $('pdf-export-text').disabled = busy || !project;
  for (const id of ['project-templates', 'welcome-template']) $(id).disabled = busy || running;
  for (const slot of Object.values(editorSlots)) slot.select.disabled = busy;
  for (const control of $('markdown-editing').querySelectorAll('button, select')) control.disabled = busy;
  $('toggle-preview').disabled = state.closed;
  $('go-home').disabled = busy;
  projectHome?.refresh(); renderWorkspaceView();
  updateEditorModeControls(); updatePreviewVisibilityControls();
  updateNavigationControls();
  for (const button of state.treeButtons.values()) button.disabled = busy;
  for (const tab of state.tabElements.values()) { tab.button.disabled = busy; tab.close.disabled = busy; }
}

async function downloadPDF() {
  const build = state.build; if (!build?.pdfReady) return;
  const project = state.meta.project;
  const response = await fetch(`/api/pdf?build=${encodeURIComponent(build.pdfBuildId)}`, { headers: { 'X-Local-Token': token, 'X-Project-Root': encodeURIComponent(project.root), 'Accept-Language': getLanguage() }, cache: 'no-store' });
  if (!response.ok) { const text = await response.text(); let message = text; try { message = JSON.parse(text).error || text; } catch { /* A non-JSON error is still displayed. */ } throw new APIError(t("PDF を取得できませんでした．{value0}", { value0: message }), response.status); }
  const blob = await response.blob(); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = basename(build.pdfMain || project.main).replace(/\.tex$/i, '') + '.pdf'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function copyLog() {
  if (!state.fullLog) return;
  await navigator.clipboard.writeText(state.fullLog);
  toast(t("ログをコピーしました．"));
}

function handleExternalProjectChange() {
  state.externalProjectChanged = true; renderControls();
  showError(new Error(t("別のタブでプロジェクトが切り替わりました．この画面の編集内容は残っています．作業中のフォルダーを開き直してください．")), {
    label: t("元のフォルダーへ戻る"),
    run: async () => { const meta = await api('/api/project/open', { method: 'POST', body: { path: state.meta.project.root } }); await applyMeta(meta); clearError(); },
  });
}

async function reconnect() {
  const meta = await api('/api/state');
  if (state.meta?.project && meta.project?.root !== state.meta.project.root) { handleExternalProjectChange(); return; }
  await applyMeta(meta, !state.meta); clearError();
}

async function heartbeat() {
  if (state.closed) return;
  // Returning to the tab during a save still needs a refresh when that save ends.
  if (state.operation) { state.heartbeatPending = true; return; }
  state.heartbeatPending = false;
  const generation = state.projectGeneration;
  const toolsGeneration = state.toolsGeneration;
  const entriesVersion = state.projectEntriesVersion;
  try {
    const meta = await api('/api/state');
    if (state.closed || generation !== state.projectGeneration) return;
    if (state.meta?.project && meta.project?.root !== state.meta.project.root) { if (!state.externalProjectChanged) handleExternalProjectChange(); return; }
    if (state.operation) state.heartbeatPending = true;
    else if (entriesVersion === state.projectEntriesVersion) applyProjectListing(meta.project);
    if (toolsGeneration === state.toolsGeneration) updateTools(meta);
    if (!isRunning() && meta.build) applyBuild(meta.build);
  } catch (error) { if ($('app-error').hidden) showError(error); }
}

async function shutdown() {
  if (state.operation || state.closed) return;
  setOperation('shutdown');
  try {
    if (!await confirmUnsaved(t("アプリを終了する前に，変更を保存しますか？"))) return;
    if (isRunning()) {
      const answer = await choose({ title: t("コンパイルを停止して終了しますか？"), description: t("実行中の TeX とローカルのアプリを終了します．"), primary: t("停止して終了"), secondary: '' });
      if (answer !== 'primary') return;
    }
    syncDrafts(); persistSession(); await sessionStore.flush();
    await api('/api/shutdown', { method: 'POST', body: {}, timeout: 30000 });
    state.closed = true; ++state.projectGeneration; ++state.openSequence;
    browserSession.stop();
    for (const timer of [state.pollTimer, state.autoSaveTimer, state.draftTimer, state.sessionTimer, state.outlineTimer, toastTimer, lineFlashTimer]) clearTimeout(timer);
    clearInterval(state.heartbeat); state.build = null; setConnected(false);
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* No persistent storage is required. */ }
    destroyEditors();
    state.documents.clear(); state.assets.clear(); assetPreview.hide(); markdownPreview.reset(); viewer.reset().catch(() => {});
    $('app-shell').classList.add('app-closed');
    $('workbench').hidden = true; $('welcome').hidden = true; $('recovery-banner').hidden = true; $('toast').hidden = true;
    $('closed-screen').hidden = false;
    clearError();
    try { window.close(); } catch { /* Some browsers require the user to close an existing tab. */ }
    setTimeout(() => {
      $('closed-message').textContent = t("このタブを閉じてください ({value0}+W)．次回は Local TeX Web Editor を開いてください．", { value0: shortcutModifier });
    }, 600);
  } finally { setOperation(state.closed ? 'closed' : ''); }
}

const sessionStore = new SessionStore(api, (status, key, error) => {
  if (key.startsWith('drafts:') && key === `drafts:${state.meta?.project?.root}`) {
    $('draft-status').dataset.status = status;
    $('draft-status').textContent = status === 'saving' ? t("草稿を保存中…") : status === 'saved' ? t("草稿を PC に記録済み") : t("草稿の記録を確認");
  }
  if (error) {
    const item = key.startsWith('drafts:') ? t("草稿") : key.startsWith('session:') ? t("編集位置") : t("設定");
    showError(new Error(t("{value0}を記録できませんでした．{value1}", { value0: item, value1: error.message || error })), { label: t("再保存"), run: () => sessionStore.flush({ retryConflicts: true }) });
  }
});
const browserSession = new BrowserSession({ token, onConnectionChange: connected => { if (!state.closed) setConnected(connected); } });
const panelLayout = createPanelLayout({
  workbench: $('workbench'), shell: $('app-shell'),
  handles: { sidebar: $('sidebar-splitter'), editor: $('splitter'), log: $('log-splitter') },
  getPreferences: () => state.preferences.panelLayout,
  onChange: (value, persist) => { state.preferences.panelLayout = value; if (persist) savePreferences(150); },
});

function editorLanguageExtension() {
  return [
    EditorView.contentAttributes.of({ 'aria-label': t('原稿エディタ'), spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    EditorState.phrases.of({ 'Find': t('検索'), 'Replace': t('置換'), 'next': t('次'), 'previous': t('前'), 'all': t('すべて'), 'match case': t('大文字と小文字を区別'), 'by word': t('単語単位'), 'regexp': t('正規表現'), 'replace': t('置換'), 'replace all': t('すべて置換'), 'close': t('閉じる'), 'Go to line': t('行へ移動'), 'go': t('移動'), 'Fold line': t('折りたたむ'), 'Unfold line': t('展開') }),
  ];
}
function applyLanguage(language, { preview = false } = {}) {
  const selected = setLanguage(language);
  if (!preview) state.preferences.language = selected;
  $('language-setting').value = selected;
  for (const doc of state.documents.values()) {
    const transaction = doc.state.update({ effects: editorLanguage.reconfigure(editorLanguageExtension()) });
    applyDocumentTransaction(doc, transaction);
  }
  $('find-button').title = t('検索・置換 ({value0}+F)', { value0: shortcutModifier });
  $('save-button').title = t('現在のファイルを保存 ({value0}+S)', { value0: shortcutModifier });
  $('theme-toggle').setAttribute('aria-label', t(state.theme === 'dark' ? 'ライトテーマに切り替える' : 'ダークテーマに切り替える'));
  $('theme-label').textContent = t(state.theme === 'dark' ? 'ダーク' : 'ライト');
  $('project-tex-help').textContent = state.meta?.latexmk ? `latexmk: ${state.meta.latexmk}` : t(isMac ? '例: /Library/TeX/texbin' : '例: C:\\texlive\\2025\\bin\\windows');
  setConnected(state.connected);
  setSidebar(state.sidebar); renderTabs(); renderRecovery(); renderPickerState(); renderToolStatus();
  for (const doc of state.documents.values()) updateDocumentIndicators(doc);
  updateCursor(); updateAutoSaveStatus(); updateDocumentPreview();
  panelLayout.refresh();
  if (state.meta) applyBuild(state.build);
  else renderControls();
  const draftStatus = $('draft-status').dataset.status;
  $('draft-status').textContent = draftStatus === 'saving' ? t('草稿を保存中…') : draftStatus === 'saved' ? t('草稿を PC に記録済み') : draftStatus ? t('草稿の記録を確認') : availableDrafts().length ? t('前回の草稿があります') : '';
}

function themeExtension() {
  const dark = state.theme === 'dark';
  return [EditorView.theme({}, { dark }), syntaxHighlighting(dark ? darkHighlight : defaultHighlightStyle)];
}
function applyTheme(theme) {
  const previous = state.theme;
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  $('theme-toggle').setAttribute('aria-pressed', String(state.theme === 'dark'));
  $('theme-toggle').setAttribute('aria-label', state.theme === 'dark' ? t("ライトテーマに切り替える") : t("ダークテーマに切り替える"));
  $('theme-label').textContent = state.theme === 'dark' ? t("ダーク") : t("ライト");
  if (previous !== state.theme) {
    for (const doc of state.documents.values()) {
      const transaction = doc.state.update({ effects: editorTheme.reconfigure(themeExtension()) });
      applyDocumentTransaction(doc, transaction);
    }
  }
}

function applyAppearance(value, cache = false) {
  const appearance = resolveAppearance(value, systemColorScheme.matches);
  const root = document.documentElement;
  const restore = root.style.getPropertyValue('--editor-font-family') !== appearance.fontFamily ? prepareEditorResize(activeDocument() ? state.editor : null) : () => {};
  root.dataset.palette = appearance.palette;
  root.dataset.accent = appearance.accent;
  for (const [name, color] of Object.entries(appearance.colors)) root.style.setProperty(`--${name}`, color);
  root.style.setProperty('--editor-font-family', appearance.fontFamily);
  applyTheme(appearance.theme);
  restore();
  if (cache) {
    try {
      localStorage.setItem('local-tex-editor-appearance', JSON.stringify(normalizeAppearance(value)));
      localStorage.setItem('local-tex-editor-theme', appearance.theme);
    } catch { /* The PC copy is written through the storage API. */ }
  }
  if (appearanceDraft) renderAppearanceColors();
}

function renderAppearanceColors(refreshInputs = false) {
  const appearance = resolveAppearance(appearanceDraft, systemColorScheme.matches);
  const preset = resolveAppearance({ ...appearanceDraft, customColors: undefined }, systemColorScheme.matches);
  const custom = appearanceDraft.customColors?.[appearance.theme] || {};
  $('appearance-color-mode').textContent = t(appearance.theme === 'dark' ? 'ダークの色' : 'ライトの色');
  for (const [id, key] of [['background', 'surface'], ['foreground', 'text'], ['accent', 'accent']]) {
    const input = $(`appearance-${id}-input`);
    input.placeholder = preset.colors[key].toUpperCase();
    $(`appearance-${id}-swatch`).value = custom[id] || appearance.colors[key];
    if (refreshInputs) {
      input.value = (custom[id] || '').toUpperCase();
      input.setCustomValidity('');
      input.removeAttribute('aria-invalid');
    }
  }
}

function changeAppearanceColor(id, value) {
  if (!appearanceDraft) return;
  const input = $(`appearance-${id}-input`);
  const color = normalizeHexColor(value);
  const invalid = value.trim() !== '' && !color;
  input.setCustomValidity(invalid ? t('色は #RRGGBB または #RGB で入力してください．') : '');
  if (invalid) { input.setAttribute('aria-invalid', 'true'); return; }
  input.removeAttribute('aria-invalid');
  const { theme } = resolveAppearance(appearanceDraft, systemColorScheme.matches);
  const customColors = { ...appearanceDraft.customColors, [theme]: { ...appearanceDraft.customColors?.[theme], [id]: color } };
  appearanceDraft = normalizeAppearance({ ...appearanceDraft, customColors });
  applyAppearance(appearanceDraft);
}

function renderAppearanceForm() {
  for (const [id, key] of [['mode', 'mode'], ['palette', 'palette'], ['accent', 'accent'], ['font', 'editorFont']]) $(`appearance-${id}`).value = appearanceDraft[key];
  applyAppearance(appearanceDraft);
  renderAppearanceColors(true);
}

function showAppearance() {
  appearanceDraft = normalizeAppearance(state.preferences.appearance, state.preferences.theme);
  $('appearance-error').hidden = true;
  renderAppearanceForm();
  $('appearance-dialog').showModal();
}

async function saveAppearance(event) {
  event.preventDefault();
  if (!appearanceDraft || $('appearance-dialog').dataset.busy === 'true') return;
  if (!$('appearance-form').reportValidity()) return;
  const previous = state.preferences.appearance, previousTheme = state.preferences.theme;
  const appearance = normalizeAppearance(appearanceDraft);
  setDialogBusy($('appearance-dialog'), true); $('appearance-error').hidden = true;
  state.preferences.appearance = appearance;
  state.preferences.theme = appearance.mode === 'system' ? null : appearance.mode;
  try {
    savePreferences(); await sessionStore.flush();
    appearanceDraft = null;
    applyAppearance(appearance, true);
    $('appearance-dialog').close();
    toast(t('外観を保存しました．'));
  } catch (error) {
    state.preferences.appearance = previous; state.preferences.theme = previousTheme;
    savePreferences();
    $('appearance-error').textContent = error.message || String(error); $('appearance-error').hidden = false;
  } finally { setDialogBusy($('appearance-dialog'), false); }
}

function savePreferences(delay = 0) { sessionStore.write('preferences', { ...state.preferences, updatedAt: Date.now() }, delay); }
function applyPDFDarkMode(enabled) {
  state.preferences.pdfDarkMode = !!enabled;
  viewer.setDarkMode(state.preferences.pdfDarkMode);
  assetPreview.setDarkMode(state.preferences.pdfDarkMode);
}
function changePDFDarkMode(enabled) {
  applyPDFDarkMode(enabled);
  savePreferences();
}
function applyEditorFontSize(value, origin = null) {
  const size = Number.isFinite(value) ? Math.min(40, Math.max(8, Math.round(value * 10) / 10)) : 14;
  const changed = state.preferences.editorFontSize !== size;
  if (!changed && document.documentElement.style.getPropertyValue('--editor-font-size') === `${size}px`) return false;
  const restore = prepareEditorResize(activeDocument() ? state.editor : null, origin);
  state.preferences.editorFontSize = size;
  document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
  $('editor-font-size').value = String(size);
  restore();
  return changed;
}
async function loadPreferences() {
  const preferences = await sessionStore.read('preferences');
  if (preferences && typeof preferences === 'object') {
    state.preferences.autoSave = preferences.autoSave !== false;
    state.preferences.texCompletion = preferences.texCompletion !== false;
    state.preferences.automaticCompletion = preferences.automaticCompletion !== false;
    state.preferences.theme = ['light', 'dark'].includes(preferences.theme) ? preferences.theme : null;
    state.preferences.appearance = normalizeAppearance(preferences.appearance, preferences.theme);
    state.preferences.theme = state.preferences.appearance.mode === 'system' ? null : state.preferences.appearance.mode;
    state.preferences.editorFontSize = preferences.editorFontSize;
    state.preferences.panelLayout = normalizePanelLayout(preferences.panelLayout);
    state.preferences.fileSort = normalizeFileSort(preferences.fileSort);
    for (const name of ['primary', 'secondary']) state.preferences.markdownEditorModes[name] = preferences.markdownEditorModes?.[name] === 'source' ? 'source' : 'rich';
    for (const name of ['rich', 'markdown', 'source']) if (typeof preferences.previewVisibility?.[name] === 'boolean') state.preferences.previewVisibility[name] = preferences.previewVisibility[name];
    state.previewContext = '';
    state.preferences.markdownScrollSync = preferences.markdownScrollSync !== false;
    state.preferences.pdfDarkMode = preferences.pdfDarkMode === true;
    if (['ja', 'en'].includes(preferences.language)) state.preferences.language = preferences.language;
  }
  applyLanguage(state.preferences.language);
  applyAppearance(state.preferences.appearance, true);
  applyEditorFontSize(state.preferences.editorFontSize);
  applyMarkdownScrollSync(state.preferences.markdownScrollSync);
  applyPDFDarkMode(state.preferences.pdfDarkMode);
  applyCompletionSettings();
  updateAutoSaveStatus();
}
function updateAutoSaveStatus() { $('autosave-status').textContent = state.preferences.autoSave ? (isRunning() ? t("自動保存はコンパイル後") : t("自動保存オン")) : t("手動で保存"); }
function scheduleAutoSave() {
  clearTimeout(state.autoSaveTimer);
  updateAutoSaveStatus();
  if (!state.preferences.autoSave || state.closed || !state.persistenceReady) return;
  state.autoSaveTimer = setTimeout(() => runTask(async () => {
    if (state.operation || isRunning() || state.externalProjectChanged || document.querySelector('dialog[open]')) return;
    const generation = state.projectGeneration;
    for (const doc of state.documents.values()) {
      if (doc.saving) await doc.saving;
      if (generation !== state.projectGeneration || state.documents.get(doc.path) !== doc) break;
      if (state.operation || isRunning() || state.closed) break;
      if (isDirty(doc) && !doc.conflict) await saveDocument(doc);
    }
  }), 1600);
}

function queueDrafts() {
  if (!state.persistenceReady || !state.meta?.project || state.closed) return;
  clearTimeout(state.draftTimer);
  $('draft-status').dataset.status = 'saving'; $('draft-status').textContent = t("草稿を保存中…");
  state.draftTimer = setTimeout(syncDrafts, 450);
}
function syncDrafts() {
  clearTimeout(state.draftTimer); state.draftTimer = null;
  if (!state.persistenceReady || !state.meta?.project || state.closed) return;
  const entries = new Map((state.drafts.entries || []).map(entry => [entry.id, entry]));
  let changed = false;
  for (const doc of state.documents.values()) {
    if (isDirty(doc)) {
      const content = doc.state.doc.toString();
      const previous = entries.get(doc.draftId);
      if (previous?.content === content && previous.baseRevision === doc.revision) continue;
      entries.set(doc.draftId, { id: doc.draftId, path: doc.path, baseRevision: doc.revision, content, updatedAt: Date.now(), selection: { anchor: doc.state.selection.main.anchor, head: doc.state.selection.main.head } });
      changed = true;
    } else if (entries.delete(doc.draftId)) changed = true;
  }
  if (!changed) {
    if (!sessionStore.pending) { $('draft-status').dataset.status = 'saved'; $('draft-status').textContent = t("草稿を PC に記録済み"); }
    return;
  }
  state.drafts = { version: 1, updatedAt: Date.now(), entries: [...entries.values()] };
  sessionStore.write(`drafts:${state.meta.project.root}`, state.drafts, 0);
  renderRecovery();
}
function removeDraft(id) {
  if (!state.meta?.project) return;
  state.drafts = { version: 1, updatedAt: Date.now(), entries: state.drafts.entries.filter(entry => entry.id !== id) };
  sessionStore.write(`drafts:${state.meta.project.root}`, state.drafts, 0);
  renderRecovery();
}
function availableDrafts() {
  const current = new Set([...state.documents.values()].map(doc => doc.draftId));
  return (state.drafts.entries || []).filter(entry => !current.has(entry.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}
function renderRecovery() {
  const count = availableDrafts().length;
  $('recovery-banner').hidden = !count;
  $('recovery-summary').textContent = t("前回保存しなかった草稿が {value0} 件あります．", { value0: count });
}
async function showRecovery() {
  const entries = availableDrafts();
  if (!entries.length) return;
  $('recovery-file').replaceChildren();
  for (const entry of entries) {
    const option = document.createElement('option'); option.value = entry.id;
    option.textContent = `${entry.path} · ${new Date(entry.updatedAt).toLocaleString(getLanguage() === 'ja' ? 'ja-JP' : 'en-US')}`;
    $('recovery-file').append(option);
  }
  $('recovery-error').hidden = true; $('recovery-dialog').showModal();
  await inspectDraft();
}
async function diskForDraft(entry) {
  try { return await api(`/api/file?path=${encodeURIComponent(entry.path)}`); }
  catch (error) { if (error.status === 404) return { path: entry.path, content: '', revision: '', lineEnding: 'lf', missing: true }; throw error; }
}
async function inspectDraft() {
  const entry = state.drafts.entries.find(item => item.id === $('recovery-file').value);
  if (!entry) return;
  const dialog = $('recovery-dialog');
  setDialogBusy(dialog, true); $('recovery-error').hidden = true;
  try {
    const disk = await diskForDraft(entry);
    state.recoverySelection = entry;
    $('recovery-disk').value = disk.content; $('recovery-draft').value = entry.content;
    $('recovery-description').textContent = disk.missing ? t("ディスク上のファイルがありません．草稿を開き，保存するとファイルを作成できます．") : disk.revision === entry.baseRevision ? t("草稿を記録したときから，ディスクの内容は変わっていません．草稿をエディタで開いて作業を再開できます．") : t("草稿を記録した後に，ディスクの内容が変更されています．草稿を開いた後，保存する内容を確認してください．");
  } catch (error) { $('recovery-error').textContent = error.message || String(error); $('recovery-error').hidden = false; }
  finally { setDialogBusy(dialog, false); }
}
async function restoreDraft() {
  const entry = state.recoverySelection;
  if (!entry || state.operation) return;
  const previous = state.documents.get(entry.path);
  if (previous && isDirty(previous) && previous.state.doc.toString() !== entry.content) {
    syncDrafts(); await sessionStore.flush();
    const answer = await choose({ title: t("編集中の内容を草稿に記録しました"), description: t("{value0} の編集内容を残して，選んだ草稿を開きますか？", { value0: entry.path }), primary: t("選んだ草稿を開く"), secondary: '' });
    if (answer !== 'primary') return;
  }
  const remote = await diskForDraft(entry);
  const doc = makeDocument(remote);
  doc.draftId = entry.id; doc.revision = entry.baseRevision || '';
  const content = normalise(entry.content);
  doc.state = doc.state.update({ changes: { from: 0, to: doc.state.doc.length, insert: content }, selection: { anchor: Math.min(content.length, Math.max(0, entry.selection?.anchor || 0)), head: Math.min(content.length, Math.max(0, entry.selection?.head || 0)) } }).state;
  doc.visited = true;
  if (remote.revision !== doc.revision) doc.conflict = new APIError(t("草稿を記録した後にディスクの内容が変更されています．保存する内容を確認してください．"), 409);
  state.documents.set(doc.path, doc);
  const selection = doc.state.selection.main;
  state.homeVisible = false; renderWorkspaceView();
  $('recovery-dialog').close(); switchView(false); selectDocument(doc, { position: { anchor: selection.anchor, head: selection.head } });
  editorSlots[state.activePane].restoreSequence++;
  if (activeRichEditor()) activeRichEditor().selectSource(selection.anchor, selection.head, { scrollIntoView: true });
  else state.editor.dispatch({ effects: EditorView.scrollIntoView(state.editor.state.selection.main.head, { y: 'center' }) });
  updateIndex(doc.path, doc.state.doc.toString());
  syncDrafts(); renderRecovery(); scheduleAutoSave();
  toast(doc.conflict ? t("草稿を開きました．保存の前に，ディスクの内容との比較を確認してください．") : t("草稿を開きました．"));
}
async function deleteSelectedDraft() {
  const id = $('recovery-file').value;
  removeDraft(id); await sessionStore.flush();
  $('recovery-dialog').close();
  if (availableDrafts().length) await showRecovery();
}

function scheduleSession() {
  if (!state.persistenceReady || !state.meta?.project || state.closed) return;
  clearTimeout(state.sessionTimer);
  state.sessionTimer = setTimeout(persistSession, 650);
}
function persistSession() {
  clearTimeout(state.sessionTimer); state.sessionTimer = null;
  if (!state.persistenceReady || state.initialFilePending || !state.meta?.project || state.closed || state.homeVisible) return;
  const positions = { ...state.session?.positions };
  for (const doc of state.documents.values()) {
    const selection = doc.state.selection.main;
    positions[doc.path] = { anchor: selection.anchor, head: selection.head, scrollTop: doc.path === state.activePath && state.editor ? state.editor.scrollDOM.scrollTop : doc.scrollTop ?? positions[doc.path]?.scrollTop ?? 0,
      richScrollTop: doc.path === state.activePath && activeRichEditor() ? editorSlots[state.activePane].richHost.scrollTop : doc.richScrollTop ?? positions[doc.path]?.richScrollTop ?? 0 };
  }
  state.session = { version: 2, updatedAt: Date.now(), activePath: state.activePath, tabs: [...state.tabOrder], workspace: captureSourceWorkspace(), positions, pdf: viewer.getViewState(), pdfPositions: viewer.getPositions(), previewChoice: state.previewChoice, lastMarkdownPath: state.lastMarkdownPath, sidebar: state.sidebar, directories: Object.fromEntries(state.directoryState) };
  sessionStore.write(`session:${state.meta.project.root}`, state.session, 0);
}
async function loadProjectSession(root, generation) {
  const [session, drafts] = await Promise.all([sessionStore.read(`session:${root}`), sessionStore.read(`drafts:${root}`)]);
  if (generation !== state.projectGeneration) return;
  state.session = session && typeof session === 'object' ? session : null;
  state.previewChoice = ['auto', 'pdf', 'markdown'].includes(state.session?.previewChoice) ? state.session.previewChoice : 'auto';
  state.lastMarkdownPath = isMarkdown(state.session?.lastMarkdownPath) ? state.session.lastMarkdownPath : '';
  const markdownFile = state.previewChoice === 'markdown' && state.meta.project.files?.find(file => file.path === state.lastMarkdownPath);
  if (markdownFile && markdownFile.path !== state.session?.activePath) {
    try {
      const file = await api(`/api/file?path=${encodeURIComponent(markdownFile.path)}`);
      if (generation !== state.projectGeneration) return;
      state.documents.set(file.path, makeDocument(file)); rememberTab(file.path);
    } catch (error) { if (generation === state.projectGeneration) showError(error); }
  }
  if (generation !== state.projectGeneration) return;
  state.directoryState = new Map(Object.entries(state.session?.directories || {}).filter(([, value]) => typeof value === 'boolean'));
  state.drafts = { version: 1, entries: Array.isArray(drafts?.entries) ? drafts.entries.filter(entry => typeof entry?.id === 'string' && typeof entry.path === 'string' && typeof entry.content === 'string' && typeof entry.baseRevision === 'string') : [] };
  state.persistenceReady = true;
  viewer.restorePosition(state.session?.pdf, state.session?.pdfPositions);
  setSidebar(state.session?.sidebar === 'outline' ? 'outline' : 'files');
  renderRecovery();
  $('draft-status').textContent = availableDrafts().length ? t("前回の草稿があります") : '';
}
async function openInitialFile() {
  const project = state.meta?.project;
  if (!project || state.operation) return;
  if (state.activePath) { state.initialFilePending = false; return; }
  const generation = state.projectGeneration;
  const workspace = state.session?.workspace;
  state.tabOrder = restoredTabPaths(state.session, project.files || []);
  const noOpenTabs = Array.isArray(state.session?.tabs) && !state.session.tabs.length && !state.session.activePath && !workspace?.primary?.path && !workspace?.secondary?.path;
  const file = !noOpenTabs && (project.files?.find(item => item.path === (workspace?.primary?.path || state.session?.activePath)) || project.files?.find(item => item.path === project.main) || project.files?.find(item => /\.tex$/i.test(item.path)) || project.files?.[0]);
  try {
    if (file) await openFile(file.path, { pane: 'primary', focus: false });
    if (generation !== state.projectGeneration) return;
    const second = workspace?.split && project.files?.find(item => item.path === workspace.secondary?.path && fileKind(item) === 'text');
    if (second) {
      state.splitEditors = true; state.sourceRatio = Math.max(.25, Math.min(4, Number(workspace.ratio) || 1)); updateSourceLayout();
      await openFile(second.path, { pane: 'secondary', focus: false });
    }
    if (generation !== state.projectGeneration) return;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const name of ['primary', 'secondary']) if (workspace?.[name]) restoreSourcePosition(name, workspace[name]);
    const active = workspace?.activePane === 'secondary' && second ? 'secondary' : 'primary';
    if (editorSlots[active].view) activateEditorPane(active, false);
    updateSourceLayout(); renderTabs();
  } finally { if (generation === state.projectGeneration) { state.initialFilePending = false; scheduleSession(); } }
}

function sourcePosition(name = state.activePane) {
  const slot = editorSlots[name];
  if (!slot?.view || !state.documents.has(slot.path)) return slot?.path ? { path: slot.path, pane: name } : null;
  const selection = slot.view.state.selection.main;
  return { path: slot.path, pane: name, anchor: selection.anchor, head: selection.head, scrollTop: slot.view.scrollDOM.scrollTop, scrollLeft: slot.view.scrollDOM.scrollLeft,
    markdownMode: editorMode(name), richScrollTop: slot.richHost.scrollTop };
}
function captureSourceWorkspace() {
  return { split: state.splitEditors, ratio: state.sourceRatio, activePane: state.activePane, primary: sourcePosition('primary'), secondary: state.splitEditors ? sourcePosition('secondary') : null };
}
function restoreSourcePosition(name, position) {
  const slot = editorSlots[name];
  if (!slot?.view || slot.path !== position?.path) return;
  if (isMarkdown(slot.path) && ['source', 'rich'].includes(position.markdownMode)) setMarkdownEditorMode(position.markdownMode, name, { focus: false, persist: false });
  const view = slot.view;
  const anchor = Math.min(view.state.doc.length, Math.max(0, Number(position.anchor) || 0));
  const head = Math.min(view.state.doc.length, Math.max(0, Number(position.head ?? position.anchor) || 0));
  view.dispatch({ selection: { anchor, head }, effects: revealSourceRange(view.state, anchor, head), annotations: Transaction.addToHistory.of(false) });
  view.scrollDOM.scrollTop = Math.max(0, Number(position.scrollTop) || 0); view.scrollDOM.scrollLeft = Math.max(0, Number(position.scrollLeft) || 0);
  if (editorMode(name) === 'rich' && slot.rich) { slot.rich.selectSource(anchor, head); slot.richHost.scrollTop = Math.max(0, Number(position.richScrollTop) || 0); }
}
function captureNavigationLocation() {
  if (!state.meta?.project) return null;
  return { projectRoot: state.meta.project.root, source: sourcePosition(), pdf: viewer.document ? viewer.getViewState() : null, asset: assetPreview.getViewState?.(), markdown: markdownPreview.getViewState?.(), previewChoice: state.previewChoice, previewVisible: $('app-shell').classList.contains('preview-mode'), previewOpen: state.preferences.panelLayout.previewVisible, surface: state.lastSurface };
}
async function restoreNavigationLocation(location) {
  if (!location || state.closed || state.operation || location.projectRoot !== state.meta?.project?.root) return false;
  const generation = state.projectGeneration;
  pauseMarkdownScrollSync();
  const source = location.source;
  if (location.surface === 'asset' && location.asset?.path) {
    if (source?.pane === 'secondary' && !state.splitEditors) { state.splitEditors = true; updateSourceLayout(); }
    await openFile(location.asset.path, { pane: 'primary', focus: false });
    if (generation !== state.projectGeneration) return false;
  }
  if (source?.path) {
    const pane = source.pane === 'secondary' && state.splitEditors ? 'secondary' : 'primary';
    await openFile(source.path, { pane, focus: false });
    if (generation !== state.projectGeneration || state.activePath !== source.path) return false;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (generation !== state.projectGeneration) return false;
    restoreSourcePosition(pane, source);
  }
  if (location.markdown?.path) {
    let doc = state.documents.get(location.markdown.path);
    if (!doc && state.meta?.project?.files?.some(file => file.path === location.markdown.path)) {
      const file = await api(`/api/file?path=${encodeURIComponent(location.markdown.path)}`, { projectRoot: location.projectRoot });
      if (generation !== state.projectGeneration) return false;
      doc = makeDocument(file); state.documents.set(file.path, doc); rememberTab(file.path); renderTabs();
    }
    if (doc) state.lastMarkdownPath = doc.path;
  }
  if (location.previewChoice) setPreviewChoice(location.previewChoice);
  if (typeof location.previewOpen === 'boolean') setPreviewVisible(location.previewOpen);
  switchView(!!location.previewVisible);
  if (location.pdf?.main && viewer.documentMain !== location.pdf.main && location.pdf.buildId) await viewer.load(location.pdf.buildId, state.meta.project.root, location.pdf.main);
  if (generation !== state.projectGeneration) return false;
  const restoredPDF = location.pdf ? await viewer.applyViewState(location.pdf) : false;
  if (generation !== state.projectGeneration) return false;
  const restoredAsset = location.asset ? await assetPreview.applyViewState(location.asset) : false;
  if (generation !== state.projectGeneration) return false;
  const restoredMarkdown = location.markdown ? await markdownPreview.applyViewState(location.markdown) : false;
  if (generation !== state.projectGeneration) return false;
  if ((location.surface === 'pdf' && !restoredPDF) || (location.surface === 'asset' && !restoredAsset) || (location.surface === 'markdown' && !restoredMarkdown)) return false;
  state.lastSurface = location.surface || 'source';
  if (state.lastSurface === 'pdf') $('pdf-scroll').focus({ preventScroll: true });
  else if (state.lastSurface === 'markdown') $('markdown-preview-container').focus({ preventScroll: true });
  else if (state.lastSurface === 'asset') $('asset-scroll').focus({ preventScroll: true });
  else focusEditorSlot();
  pauseMarkdownScrollSync(); scheduleSession();
  return true;
}
function updateNavigationControls() {
  for (const button of document.querySelectorAll('[data-navigation-back]')) button.disabled = !!state.operation || state.closed || !navigationHistory?.canBack;
  for (const button of document.querySelectorAll('[data-navigation-forward]')) button.disabled = !!state.operation || state.closed || !navigationHistory?.canForward;
}

function openDocumentSnapshots() {
  return [...state.documents.values()].map(doc => ({ path: doc.path, content: doc.state.doc.toString(), revision: doc.revision, dirty: isDirty(doc) }));
}
function currentDocumentSnapshot() {
  const doc = activeDocument();
  if (!doc || !state.editor) return null;
  return { path: doc.path, content: documentText(doc), revision: doc.revision, projectRoot: state.meta?.project?.root, position: state.editor.state.selection.main.head, ...sourcePosition(),
    ...(activeRichEditor()?.selectionSnapshot() || {}) };
}
function changedText(before, after) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}
function replaceEditorText(path, content, expectedContent, edits = null) {
  const doc = state.documents.get(path);
  if (state.operation || state.closed || !doc || doc.state.doc.toString() !== expectedContent) throw new Error(t('原稿が変更されています．内容を開き直してから操作してください．'));
  const next = normalise(content);
  if (next === expectedContent) return;
  applyDocumentTransaction(doc, doc.state.update({ changes: edits || changedText(expectedContent, next), userEvent: 'input', annotations: isolateHistory.of('full') }));
  syncDrafts();
}
async function applyProjectReplacements(changes) {
  if (state.operation || state.closed || state.externalProjectChanged || !state.meta?.project) throw new Error(t('処理が終わってから操作してください．'));
  if (isRunning()) throw new Error(t('コンパイルが終わってから置換してください．'));
  setOperation('replacing');
  try {
    await state.saveQueue;
    return await replaceProjectDocuments(api, changes, openDocumentSnapshots(), (documents, plans) => {
      const planned = new Map(plans.map(change => [change.path, change]));
      for (const result of documents) {
        const doc = state.documents.get(result.path), plan = planned.get(result.path);
        if (doc) {
          const content = normalise(result.content);
          const transaction = doc.state.update({ changes: plan?.edits || changedText(doc.state.doc.toString(), content), userEvent: 'input', annotations: isolateHistory.of('full') });
          doc.revision = result.revision; doc.lineEnding = result.lineEnding || doc.lineEnding; doc.savedDoc = transaction.state.doc; doc.conflict = null;
          applyDocumentTransaction(doc, transaction); updateDocumentIndicators(doc);
        }
        updateIndex(result.path, result.content, false);
        if (result.historyWarning) toast(result.historyWarning);
        if (state.build) {
          if (!isMarkdown(result.path)) state.build.sourceChanged = true;
          if (state.build.pdfReady && sourceAffectsPDF(result.path)) state.build.pdfSourceChanged = true;
        }
      }
      rebuildIndex(); updatePreviewNote(); syncDrafts();
    });
  } finally { setOperation(''); }
}
function focusSourceDocument(snapshot) {
  requestAnimationFrame(() => {
    if (!snapshot || state.closed || state.operation || snapshot.projectRoot !== state.meta?.project?.root || document.querySelector('dialog[open]')) return;
    const slot = editorSlots[snapshot.pane];
    if (slot?.view && slot.path === snapshot.path && (snapshot.pane === 'primary' || state.splitEditors)) focusEditorSlot(snapshot.pane);
  });
}
async function insertSourceText(text, snapshot = {}) {
  const { path, projectRoot, pane, anchor, head, content } = snapshot;
  if (state.operation || state.closed || projectRoot !== state.meta?.project?.root) throw new Error(t('プロジェクトが切り替わりました．原稿を開き直してから挿入してください．'));
  const doc = state.documents.get(path);
  const slot = editorSlots[pane];
  if (!doc || !slot?.view || slot.path !== path || (pane === 'secondary' && !state.splitEditors)) throw new Error(t('挿入先の原稿を開き直してください．'));
  const view = slot.view, selection = view.state.selection.main;
  if (view.state.doc.toString() !== content || selection.anchor !== anchor || selection.head !== head) throw new Error(t('原稿が変更されています．内容を開き直してから操作してください．'));
  if (snapshot.richAnchor != null) {
    const current = slot.rich?.selectionSnapshot();
    if (editorMode(pane) !== 'rich' || current?.richAnchor !== snapshot.richAnchor || current?.richHead !== snapshot.richHead) throw new Error(t('原稿や選択範囲が変わりました．挿入先を選び直して，もう一度開いてください．'));
    slot.rich.insertMarkdown(text); activateEditorPane(pane); focusSourceDocument(snapshot); syncDrafts(); return;
  }
  const from = Math.min(anchor, head), to = Math.max(anchor, head);
  applyDocumentTransaction(doc, view.state.update({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true }));
  activateEditorPane(pane); focusSourceDocument(snapshot);
  syncDrafts();
}
function applyMarkdownEdit(edit, snapshot) {
  const current = currentDocumentSnapshot();
  if (state.operation || state.closed || !current || current.projectRoot !== snapshot.projectRoot || current.path !== snapshot.path || current.pane !== snapshot.pane || current.content !== snapshot.content || current.anchor !== snapshot.anchor || current.head !== snapshot.head) throw new Error(t('原稿が変更されています．内容を開き直してから操作してください．'));
  const doc = activeDocument(), view = state.editor;
  applyDocumentTransaction(doc, view.state.update({ ...edit, userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true }));
  focusSourceDocument(snapshot);
}
async function openCreatedProject(path) {
  if (state.operation || state.closed || isRunning()) throw new Error(t('コンパイルが終了してからプロジェクトを切り替えてください．'));
  setOperation('opening');
  try {
    if (!await confirmUnsaved(t('プロジェクトを切り替える前に，変更を保存しますか？'))) return;
    const meta = await api('/api/project/open', { method: 'POST', body: { path } });
    await applyMeta(meta, true); clearError();
  } finally { setOperation(''); await openInitialFile(); }
}

function updateIndex(path, content, rebuild = true) {
  const metadata = /\.tex$/i.test(path) ? extractTexMetadata(content, path) : { outline: isMarkdown(path) ? extractMarkdownOutline(content) : [], labels: [] };
  state.texIndex.set(path, { path, ...metadata, citations: /\.bib$/i.test(path) ? extractCitations(content, path) : [] });
  const doc = state.documents.get(path);
  if (doc && doc.state.doc.toString() === content) doc.indexedDoc = doc.state.doc;
  if (rebuild) rebuildIndex();
}
function rebuildIndex() {
  const values = [...state.texIndex.values()];
  state.completionItems = { citations: values.flatMap(item => item.citations), labels: values.flatMap(item => item.labels) };
  viewer.citationTitles.refresh();
  assetPreview.citationTitles?.refresh();
  renderOutline();
}
function scheduleIndex(doc) {
  clearTimeout(state.outlineTimer);
  state.outlineTimer = setTimeout(() => {
    const current = state.documents.get(doc.path);
    if (state.editor?.composing) { scheduleIndex(doc); return; }
    if (current) updateIndex(current.path, current.state.doc.toString());
  }, 400);
}
async function indexProject(force = false) {
  const project = state.meta?.project;
  if (!project) return;
  const generation = state.projectGeneration;
  if (force) state.texIndex.clear();
  const files = (project.files || []).filter(file => fileKind(file) === 'text' && /\.(tex|bib)$/i.test(file.path) && !state.texIndex.has(file.path));
  state.indexing = true; renderOutline();
  let next = 0;
  await Promise.all([0, 1, 2].map(async () => {
    while (next < files.length && generation === state.projectGeneration) {
      const file = files[next++];
      try {
        const open = state.documents.get(file.path);
        const content = open ? open.state.doc.toString() : (await api(`/api/file?path=${encodeURIComponent(file.path)}`)).content;
        if (generation !== state.projectGeneration) return;
        updateIndex(file.path, state.documents.get(file.path)?.state.doc.toString() ?? content, false);
      } catch (error) {
        if (generation === state.projectGeneration) state.indexError = error.message || String(error);
      }
    }
  }));
  if (generation === state.projectGeneration) { state.indexing = false; rebuildIndex(); }
}
function setSidebar(mode) {
  state.sidebar = mode;
  const outline = mode === 'outline';
  $('file-tree').hidden = outline; $('outline-tree').hidden = !outline;
  $('file-sort').hidden = outline;
  $('files-tab').classList.toggle('selected', !outline); $('outline-tab').classList.toggle('selected', outline);
  $('files-tab').setAttribute('aria-selected', String(!outline)); $('outline-tab').setAttribute('aria-selected', String(outline));
  $('file-filter').placeholder = outline ? t("見出しを検索") : t("ファイルを検索");
  $('file-filter').setAttribute('aria-label', outline ? t("見出しを検索") : t("ファイルを検索"));
  renderTree(); renderOutline(); scheduleSession();
}
function renderOutline() {
  if (!outlineTree) return;
  const query = $('file-filter').value.trim().toLowerCase();
  const doc = activeDocument();
  const supported = !!doc && (/\.tex$/i.test(doc.path) || isMarkdown(doc.path));
  if (supported && !state.texIndex.has(doc.path)) updateIndex(doc.path, doc.state.doc.toString(), false);
  const file = supported ? state.texIndex.get(doc.path) : null;
  const outline = file?.outline || [];
  outlineTree.render({ projectRoot: state.meta?.project?.root || '', path: state.activePath, supported, outline, query });
  updateOutlinePosition();
}
function updateOutlinePosition() {
  const line = state.editor ? state.editor.state.doc.lineAt(state.editor.state.selection.main.head).number : 0;
  outlineTree?.setActive({ path: state.activePath, line });
}
function renderLogLocations() {
  logIssues?.update(state.fullLog, state.meta?.project?.files || [], state.meta?.project?.root, { running: isRunning(), main: state.build?.main || state.meta?.project?.main });
}

async function goToSource(path, lineNumber, column = 1, { align = 'start', from = null, to = null } = {}) {
  if (state.operation || state.closed) return false;
  const generation = state.projectGeneration;
  await openFile(path);
  if (generation !== state.projectGeneration || state.activePath !== path || !state.editor || !activeDocument()) return false;
  editorSlots[state.activePane].restoreSequence = (editorSlots[state.activePane].restoreSequence || 0) + 1;
  switchView(false);
  const number = Math.min(state.editor.state.doc.lines, Math.max(1, Number(lineNumber) || 1));
  const line = state.editor.state.doc.line(number);
  const position = from == null ? Math.min(line.to, line.from + Math.max(0, Number(column) - 1 || 0)) : Math.max(0, Math.min(state.editor.state.doc.length, from));
  const end = to == null ? position : Math.max(position, Math.min(state.editor.state.doc.length, to));
  const margin = align === 'start' ? Math.max(24, Math.min(96, state.editor.scrollDOM.clientHeight * .12)) : 12;
  pauseMarkdownScrollSync();
  state.editor.dispatch({ selection: { anchor: position, head: end }, effects: [...revealSourceRange(state.editor.state, position, end), EditorView.scrollIntoView(position, { y: align, yMargin: margin }), lineFlash.of(number)] });
  focusEditorSlot();
  activeRichEditor()?.selectSource(position, end, { scrollIntoView: true });
  state.lastSurface = 'source';
  clearTimeout(lineFlashTimer);
  const target = activeDocument();
  lineFlashTimer = setTimeout(() => {
    if (!target || !state.documents.has(target.path)) return;
    const transaction = target.state.update({ effects: lineFlash.of(null) });
    applyDocumentTransaction(target, transaction);
  }, 2600);
  await afterNavigationFrame();
  return true;
}
function noteSourceChanged(result) {
  if (result.sourceChanged || dirtyDocuments().some(doc => sourceAffectsPDF(doc.path))) toast(t("この PDF を作成した後に原稿が変更されています．行の位置がずれる場合があります．"));
}
async function syncForward(position = null) {
  if (state.syncing || state.operation || state.closed || state.externalProjectChanged || !state.editor || !activeDocument() || !state.meta?.project) return;
  if (isMarkdown(state.activePath)) {
    const doc = activeDocument();
    const generation = state.projectGeneration;
    const offset = position == null ? state.editor.state.selection.main.head : Math.max(0, Math.min(state.editor.state.doc.length, position));
    const line = state.editor.state.doc.lineAt(offset).number;
    pauseMarkdownScrollSync();
    if (state.previewMode !== 'markdown') setPreviewChoice('markdown');
    else updateDocumentPreview({ immediate: true });
    switchView(true);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (state.closed || generation !== state.projectGeneration || doc !== activeDocument()) return;
    pauseMarkdownScrollSync();
    markdownPreview.revealSourceLine(line, { path: doc.path, projectRoot: state.meta.project.root });
    state.lastSurface = 'markdown';
    await afterNavigationFrame();
    return;
  }
  if (!viewer.document || !viewer.buildId) throw new Error(t("PDF をコンパイルしてから，原稿と PDF の位置を対応させてください．"));
  const generation = state.projectGeneration;
  const path = state.activePath;
  const view = state.editor;
  const offset = position == null ? view.state.selection.main.head : Math.max(0, Math.min(view.state.doc.length, position));
  const line = view.state.doc.lineAt(offset);
  const buildId = viewer.buildId;
  state.syncing = true; renderControls();
  try {
    if (state.previewMode === 'markdown') setPreviewChoice('pdf');
    switchView(true);
    await new Promise(resolve => requestAnimationFrame(resolve));
    await viewer.initialisePages();
    if (generation !== state.projectGeneration || buildId !== viewer.buildId) return;
    const result = await api('/api/synctex/forward', { method: 'POST', body: { buildId, path, line: line.number, column: 0 } });
    if (generation !== state.projectGeneration || buildId !== viewer.buildId) return;
    if (!result.locations?.length) throw new Error(t("{value0} の {value1} 行に対応する PDF の位置が見つかりませんでした．文章や数式の行で試してください．", { value0: path, value1: line.number }));
    const target = result.locations.find(location => location.page === viewer.pageNumber) || result.locations[0];
    switchView(true);
    await new Promise(resolve => requestAnimationFrame(resolve));
    viewer.refreshLayout();
    await viewer.showLocation(target, buildId);
    state.lastSurface = 'pdf';
    await afterNavigationFrame();
    clearError(); noteSourceChanged(result);
  } catch (error) {
    if (error.status === 503) showError(error, { label: t("設定を開く"), run: showSettings });
    throw error;
  } finally { state.syncing = false; renderControls(); }
}
async function syncInverse(position) {
  if (state.syncing || state.operation || !state.meta?.project) return;
  const generation = state.projectGeneration;
  state.syncing = true; renderControls();
  try {
    const result = await api('/api/synctex/inverse', { method: 'POST', body: position });
    if (generation !== state.projectGeneration || position.buildId !== viewer.buildId) return;
    await goToSource(result.path, result.line, result.column);
    clearError(); noteSourceChanged(result);
  } catch (error) {
    if (error.status === 503) showError(error, { label: t("設定を開く"), run: showSettings });
    throw error;
  } finally { state.syncing = false; renderControls(); }
}

const viewer = new PDFViewer({
  token,
  getCitations: () => state.completionItems.citations,
  onError: error => showError(error, { label: t("PDF を再表示"), run: async () => { clearError(); await viewer.retry(); } }),
  onReady: () => { updatePreviewNote(); renderControls(); },
  onPositionChange: () => scheduleSession(),
  onInverse: position => runTask(() => navigate(() => syncInverse(position))),
  onNavigate: action => navigate(action),
  onDarkModeChange: changePDFDarkMode,
});
const assetPreview = new AssetPreview({ token, onNavigate: action => navigate(action), onDarkModeChange: changePDFDarkMode, getCitations: () => state.completionItems.citations });
const markdownPreview = new MarkdownPreview({
  container: $('markdown-preview-container'), token,
  onUserScroll: scrollSourceWithMarkdown,
  onNavigate: action => navigate(action),
  onError: error => showError(error),
  onOpenFile: (path, { fragment } = {}) => runTask(() => navigate(async () => {
    await openFile(path);
    const doc = activeDocument();
    if (doc?.path === path && isMarkdown(path) && fragment) markdownPreview.update(doc.state.doc.toString(), { path, projectRoot: state.meta.project.root, immediate: true, fragment });
    await afterNavigationFrame();
  })),
  onSourceLine: (line, path) => runTask(() => navigate(async () => {
    pauseMarkdownScrollSync();
    await goToSource(path, line);
    pauseMarkdownScrollSync();
  })),
});

navigationHistory = new NavigationHistory({ capture: captureNavigationLocation, restore: restoreNavigationLocation, onChange: updateNavigationControls });
outlineTree = createOutlineTree({ container: $('outline-tree'), onJump: (path, line) => runTask(() => navigate(() => goToSource(path, line, 1, { align: 'start' }))) });
projectSearch = createProjectSearch({
  api, getOpenDocuments: openDocumentSnapshots,
  onError: showError,
  openSource: (path, line, column, from, to) => navigate(() => goToSource(path, line, column, { from, to })),
  replaceDocuments: applyProjectReplacements,
});
documentHistory = createEditHistory({ api, getActiveDocument: currentDocumentSnapshot, replaceEditorText });
referenceTools = createReferenceTools({
  getFiles: () => state.meta?.project?.files || [],
  readFile: async path => {
    const doc = state.documents.get(path);
    if (doc) return { content: doc.state.doc.toString(), revision: doc.revision };
    const file = await api(`/api/file?path=${encodeURIComponent(path)}`);
    return { ...file, content: normalise(file.content) };
  },
  getCurrent: currentDocumentSnapshot,
  onOpen: (path, line, column, from) => navigate(() => goToSource(path, line, column, { from })),
  onApply: plans => applyProjectReplacements(plans.map(plan => ({ ...plan, expectedContent: plan.before, edits: plan.changes.map(({ from, to, insert }) => ({ from, to, insert })) }))),
  onError: showError,
});
insertTools = createInsertTools({ api, getDocument: currentDocumentSnapshot, getProject: () => state.meta?.project, insertText: insertSourceText, refreshProject: refreshFiles, focusDocument: focusSourceDocument, onError: showError });
documentTools = createDocumentTools({
  api, token, getDocument: currentDocumentSnapshot, getProject: () => state.meta?.project,
  assertNewPath: assertNewFilePathAvailable,
  getPDF: () => {
    if (!assetPreview.root.hidden && assetPreview.document && assetPreview.ready) return { document: assetPreview.document, path: assetPreview.file.path };
    if (!$('pdf-preview').hidden && viewer.document && viewer.ready) return { document: viewer.document, path: viewer.documentMain || 'document.pdf' };
    return null;
  },
  insertText: insertSourceText, refreshProject: refreshFiles, openFile, focusDocument: focusSourceDocument, onError: showError,
});
templateManager = createTemplateManager({ api, getProject: () => state.meta?.project, saveAll, openProject: openCreatedProject, onError: showError });
logIssues = createLogIssues({ container: $('log-locations'), onOpen: (path, line) => runTask(() => navigate(() => goToSource(path, line))) });
markdownEditing = createMarkdownEditing({
  container: $('markdown-editing'), getDocument: currentDocumentSnapshot, applyEdit: applyMarkdownEdit, focusDocument: focusSourceDocument,
  getRichEditor: activeRichEditor,
  onImage: () => openWritingTool(() => insertTools.openImage()),
  onTable: () => openWritingTool(() => insertTools.openTable()),
  onNewPage: () => openWritingTool(() => documentTools.openMarkdownPage()),
  onError: showError,
});
editorContextMenu = createEditorContextMenu({
  root: $('editor-pane'),
  isBlocked: () => !!state.operation || state.closed || state.homeVisible || state.externalProjectChanged || !!document.querySelector('dialog[open]'),
  getEditor: target => {
    if (!(target instanceof Element) || target.closest('input, textarea, select, .rich-code-heading, .rich-table-tools, .rich-math-editor')) return null;
    for (const [pane, slot] of visibleEditorSlots()) {
      const kind = editorMode(pane), rich = kind === 'rich' ? slot.rich : null;
      if (kind === 'rich' && !rich) continue;
      const view = rich?.view || slot.view, content = rich ? view.dom : view.contentDOM;
      if (!content.contains(target) || rich?.readOnly || rich?.composing || view.state.readOnly) continue;
      const path = slot.path, projectRoot = state.meta?.project?.root;
      return { kind, view, path, pane, scrollRoot: rich ? slot.richHost : view.scrollDOM,
        activate: () => { state.lastSurface = 'source'; activateEditorPane(pane); },
        isCurrent: () => slot.path === path && state.meta?.project?.root === projectRoot && editorMode(pane) === kind &&
          (pane === 'primary' || state.splitEditors) && (kind === 'rich' ? slot.rich?.view === view : slot.view === view),
      };
    }
    return null;
  },
  actions: {
    image: () => openWritingTool(() => insertTools.openImage()),
    table: () => openWritingTool(() => insertTools.openTable()),
    page: () => openWritingTool(() => documentTools.openMarkdownPage()),
    link: () => markdownEditing.openLink(),
    math: () => markdownEditing.openMath(),
    code: () => markdownEditing.openCode(),
  },
  onError: showError,
});
const fileImporter = createFileImporter({
  api, uploadFile: uploadProjectFile, getProject: () => state.meta?.project,
  isBlocked: () => !!state.operation || state.closed || state.externalProjectChanged || isRunning() || !!document.querySelector('dialog[open]'),
  begin: beginFileAction, end: () => setOperation(''), checkDestination: assertNewFilePathAvailable,
  onImported: applyImportedFile, onError: showError, onNotice: toast,
});
createFileActions({
  tree: $('file-tree'), getProject: () => state.meta?.project,
  isBlocked: () => !!state.operation || state.closed || state.externalProjectChanged || isRunning() || !!document.querySelector('dialog[open]'),
  begin: beginFileAction, end: () => setOperation(''), inspectOpenDocuments, checkDestination: assertNewFilePathAvailable, api,
  getUnsavedPaths: entry => [...new Set([...state.documents.values()].filter(doc => isDirty(doc) && entryContains(entry, doc.path)).map(doc => doc.path).concat((state.drafts.entries || []).filter(draft => entryContains(entry, draft.path)).map(draft => draft.path)))],
  onChanged: applyEntryChange, onNewFile: showNewFile, onImportFiles: folder => fileImporter.open(folder), onError: showError, onNotice: toast,
});
projectHome = createProjectHome({
  list: $('welcome-recent-list'), api,
  getMeta: () => state.meta ? { ...state.meta, build: state.build } : null,
  getUnsavedPaths: root => root === state.meta?.project?.root ? [...new Set([
    ...dirtyDocuments().map(doc => doc.path), ...(state.drafts.entries || []).map(draft => draft.path),
  ])] : [],
  beginAction: beginProjectDeletion, endAction: () => setOperation(''),
  onOpen: path => runTask(() => path === state.meta?.project?.root ? resumeProject() : openCreatedProject(path)),
  onResume: resumeProject, onDeleted: completeProjectDeletion,
  onError: showError, onNotice: toast, isBlocked: () => !!state.operation || state.closed,
});

help = createHelp({
  button: $('help-button'), dialog: $('help-dialog'), getMeta: () => state.meta, isClosed: () => state.closed,
  getActions: () => {
    const otherDialogs = [...document.querySelectorAll('dialog[open]')].filter(dialog => dialog.id !== 'help-dialog');
    const returnToSettings = otherDialogs.length === 1 && otherDialogs[0].id === 'settings-dialog';
    return {
      log: !otherDialogs.length && !!state.meta?.project && !state.closed,
      settings: returnToSettings || (!otherDialogs.length && !state.operation && !isRunning() && !state.closed),
      returnToSettings, blockedByDialog: otherDialogs.length > 0,
    };
  },
  onOpenLog: () => { setLogVisible(true); $('build-log').focus(); },
  onOpenSettings: () => { if (!$('settings-dialog').open) runTask(showSettings); },
});
applyLanguage(state.preferences.language);
$('find-button').title = t("検索・置換 ({value0}+F)", { value0: shortcutModifier });
$('save-button').title = t("現在のファイルを保存 ({value0}+S)", { value0: shortcutModifier });
if (isMac) {
  $('project-path').placeholder = '/Users/…/Documents/paper';
  $('project-tex-help').textContent = t("例: /Library/TeX/texbin");
}
let cachedAppearance = state.preferences.appearance;
try { cachedAppearance = normalizeAppearance(JSON.parse(localStorage.getItem('local-tex-editor-appearance') || 'null'), localStorage.getItem('local-tex-editor-theme')); } catch { /* Use the system preference on the first visit. */ }
applyAppearance(cachedAppearance);
onClick('theme-toggle', () => {
  state.preferences.appearance = { ...state.preferences.appearance, mode: state.theme === 'dark' ? 'light' : 'dark' };
  state.preferences.theme = state.preferences.appearance.mode;
  applyAppearance(state.preferences.appearance, true); savePreferences();
});
systemColorScheme.addEventListener('change', () => {
  const appearance = appearanceDraft || state.preferences.appearance;
  if (appearance.mode === 'system') {
    if (appearanceDraft) renderAppearanceForm();
    else applyAppearance(appearance, true);
  }
});

onClick('show-project', showProjectDialog); onClick('welcome-open', showProjectDialog);
onClick('go-home', showHome);
onClick('settings-button', showSettings); onClick('main-document', showSettings);
$('language-setting').addEventListener('change', event => {
  if ($('settings-dialog').open) applyLanguage(event.target.value, { preview: true });
});
$('settings-dialog').addEventListener('close', () => {
  if (getLanguage() !== state.preferences.language) applyLanguage(state.preferences.language);
});
onClick('close-all-tabs', closeAllDocuments);
$('editor-tabs').addEventListener('wheel', event => {
  const tabs = $('editor-tabs');
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || tabs.scrollWidth <= tabs.clientWidth) return;
  const before = tabs.scrollLeft;
  tabs.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabs.clientWidth : 1);
  if (tabs.scrollLeft !== before) event.preventDefault();
}, { passive: false });
$('tex-completion-setting').addEventListener('change', () => { $('completion-on-type-setting').disabled = !$('tex-completion-setting').checked; });
onClick('open-appearance', showAppearance);
onClick('appearance-reset', () => { appearanceDraft = normalizeAppearance(); renderAppearanceForm(); });
for (const [id, key] of [['mode', 'mode'], ['palette', 'palette'], ['accent', 'accent'], ['font', 'editorFont']]) $(`appearance-${id}`).addEventListener('change', event => {
  if (!appearanceDraft) return;
  appearanceDraft[key] = event.target.value;
  renderAppearanceForm();
});
for (const id of ['background', 'foreground', 'accent']) {
  $(`appearance-${id}-input`).addEventListener('input', event => changeAppearanceColor(id, event.target.value));
  $(`appearance-${id}-swatch`).addEventListener('input', event => {
    $(`appearance-${id}-input`).value = event.target.value.toUpperCase();
    changeAppearanceColor(id, event.target.value);
  });
}
onClick('appearance-colors-reset', () => {
  if (!appearanceDraft) return;
  const { theme } = resolveAppearance(appearanceDraft, systemColorScheme.matches);
  const customColors = { ...appearanceDraft.customColors };
  delete customColors[theme];
  appearanceDraft = normalizeAppearance({ ...appearanceDraft, customColors });
  renderAppearanceForm();
});
$('appearance-form').addEventListener('submit', event => { runTask(() => saveAppearance(event)); event.preventDefault(); });
$('appearance-dialog').addEventListener('close', () => {
  if (!appearanceDraft) return;
  appearanceDraft = null;
  applyAppearance(state.preferences.appearance);
});
onClick('shortcut-start-menu', () => createShortcut('start-menu')); onClick('shortcut-desktop', () => createShortcut('desktop'));
onClick('copy-synctex-setup', async () => { await navigator.clipboard.writeText($('synctex-install-commands').textContent); toast(t("コマンドをコピーしました．")); });
onClick('pick-project', pickProject); onClick('cancel-picker', cancelPicker); onClick('shutdown-button', shutdown);
onClick('save-button', saveCurrent); onClick('compile-button', startBuild); onClick('stop-button', stopBuild);
onClick('project-search-button', () => projectSearch.open());
onClick('split-editors', () => toggleSplitEditors());
onClick('close-second-editor', () => toggleSplitEditors(false));
function openWritingTool(action) { $('writing-menu').open = false; return action(); }
onClick('reference-tools', () => openWritingTool(() => referenceTools.open()));
onClick('document-history', () => openWritingTool(() => documentHistory.open()));
onClick('insert-image', () => openWritingTool(() => insertTools.openImage()));
onClick('insert-table', () => openWritingTool(() => insertTools.openTable()));
onClick('markdown-new-page', () => openWritingTool(() => documentTools.openMarkdownPage()));
onClick('markdown-export-pdf', () => openWritingTool(() => documentTools.openMarkdownPDF()));
onClick('pdf-export-text', () => openWritingTool(() => documentTools.openPDFText()));
onClick('project-templates', () => openWritingTool(() => templateManager.open()));
onClick('welcome-template', () => templateManager.open());
for (const [name, slot] of Object.entries(editorSlots)) slot.select.addEventListener('change', () => runTask(() => openFile(slot.select.value, { pane: name })));
for (const button of document.querySelectorAll('[data-navigation-back]')) button.addEventListener('click', () => runTask(() => navigationHistory.back()));
for (const button of document.querySelectorAll('[data-navigation-forward]')) button.addEventListener('click', () => runTask(() => navigationHistory.forward()));
for (const [id, surface] of [['pdf-scroll', 'pdf'], ['markdown-preview-container', 'markdown'], ['asset-scroll', 'asset']]) {
  $(id).addEventListener('pointerdown', () => { state.lastSurface = surface; }, { passive: true });
  $(id).addEventListener('focusin', () => { state.lastSurface = surface; });
}
function positionWritingMenu() {
  if (!$('writing-menu').open) return;
  const menu = $('writing-menu').querySelector('.writing-menu-items');
  const anchor = $('writing-menu').getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(80, innerHeight - anchor.bottom - 16)}px`;
  menu.style.top = `${anchor.bottom + 5}px`;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, anchor.right - menu.offsetWidth))}px`;
}
$('writing-menu').addEventListener('toggle', positionWritingMenu);
document.addEventListener('pointerdown', event => { if (!$('writing-menu').contains(event.target)) $('writing-menu').open = false; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('writing-menu').open) { $('writing-menu').open = false; $('writing-menu').querySelector('summary').focus(); }
});
window.addEventListener('resize', positionWritingMenu);

const sourceDivider = $('source-splitter');
let sourceDrag = null;
function resizeSourcePanes(fraction) {
  fraction = Math.max(.2, Math.min(.8, fraction));
  const restores = visibleEditorSlots().map(([, slot]) => prepareEditorResize(slot.view));
  state.sourceRatio = fraction / (1 - fraction); updateSourceLayout();
  for (const restore of restores) restore();
  scheduleSession();
}
sourceDivider.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !state.splitEditors) return;
  event.preventDefault(); sourceDivider.focus(); sourceDivider.setPointerCapture(event.pointerId);
  sourceDrag = { pointer: event.pointerId, stacked: $('source-workspace').classList.contains('stacked'), bounds: $('source-workspace').getBoundingClientRect() };
});
sourceDivider.addEventListener('pointermove', event => {
  if (!sourceDrag || sourceDrag.pointer !== event.pointerId) return;
  const { stacked, bounds } = sourceDrag;
  resizeSourcePanes(stacked ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width);
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) sourceDivider.addEventListener(event, () => { sourceDrag = null; });
sourceDivider.addEventListener('dblclick', () => resizeSourcePanes(.5));
sourceDivider.addEventListener('keydown', event => {
  const step = event.shiftKey ? .1 : .025;
  const current = state.sourceRatio / (1 + state.sourceRatio);
  const values = { ArrowLeft: current - step, ArrowUp: current - step, ArrowRight: current + step, ArrowDown: current + step, Home: .2, End: .8, Enter: .5 };
  if (Object.hasOwn(values, event.key)) { event.preventDefault(); resizeSourcePanes(values[event.key]); }
});
new ResizeObserver(updateSourceLayout).observe($('source-workspace'));
for (const select of document.querySelectorAll('[data-preview-choice]')) select.addEventListener('change', () => setPreviewChoice(select.value));
$('markdown-editor-mode').addEventListener('change', () => setMarkdownEditorMode($('markdown-editor-mode').value));
onClick('toggle-preview', () => setPreviewVisible(!state.preferences.panelLayout.previewVisible));
$('markdown-scroll-sync').addEventListener('change', () => {
  applyMarkdownScrollSync($('markdown-scroll-sync').checked);
  savePreferences();
  if (state.preferences.markdownScrollSync) scheduleMarkdownScrollSync();
});
onClick('refresh-files', refreshFiles); onClick('download-pdf', downloadPDF); onClick('copy-log', copyLog);
onClick('synctex-forward', () => navigate(() => syncForward()));
onClick('files-tab', () => { $('file-filter').value = ''; setSidebar('files'); });
onClick('outline-tab', () => { $('file-filter').value = ''; setSidebar('outline'); });
onClick('review-drafts', showRecovery); onClick('dismiss-recovery', () => { $('recovery-banner').hidden = true; });
onClick('restore-draft', restoreDraft); onClick('delete-draft', deleteSelectedDraft);
$('recovery-file').addEventListener('change', () => runTask(inspectDraft));
onClick('find-button', () => { if (state.editor && activeDocument()) { if (activeRichEditor()) setMarkdownEditorMode('source'); openSourceSearchPanel(state.editor); } });
onClick('dismiss-error', clearError); onClick('review-conflict', () => resolveConflict(activeDocument()));
onClick('log-toggle', () => setLogVisible($('log-panel').hidden)); onClick('close-log', () => setLogVisible(false));
onClick('new-file', () => showNewFile());
$('import-files').addEventListener('click', () => fileImporter.open());
$('project-form').addEventListener('submit', event => { runTask(() => openProject(event)); event.preventDefault(); });
$('settings-form').addEventListener('submit', event => { runTask(() => saveSettings(event)); event.preventDefault(); });
$('new-file-form').addEventListener('submit', event => { runTask(() => createFile(event)); event.preventDefault(); });
$('file-filter').addEventListener('input', () => { renderTree(); renderOutline(); });
$('file-sort').addEventListener('change', () => {
  state.preferences.fileSort = normalizeFileSort($('file-sort').value);
  renderTree(); savePreferences();
});
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => {
  const dialog = $(button.dataset.closeDialog); if (dialog.dataset.busy !== 'true') dialog.close();
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('cancel', event => { if (dialog.dataset.busy === 'true') event.preventDefault(); });
  dialog.addEventListener('close', scheduleAutoSave);
}
$('project-dialog').addEventListener('close', cancelPicker);

onClick('sidebar-toggle', () => {
  const collapsed = $('app-shell').classList.toggle('sidebar-collapsed');
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  panelLayout.refresh();
});
if (matchMedia('(max-width: 640px)').matches) { $('app-shell').classList.add('sidebar-collapsed'); $('sidebar-toggle').setAttribute('aria-expanded', 'false'); }
function switchView(preview) {
  if (preview) {
    panelLayout.setPreviewVisible(true);
    if (!state.preferences.previewVisibility[previewContext()]) { state.preferences.previewVisibility[previewContext()] = true; savePreferences(150); }
  }
  $('app-shell').classList.toggle('preview-mode', preview);
  $('show-preview').classList.toggle('selected', preview); $('show-editor').classList.toggle('selected', !preview);
  $('show-preview').setAttribute('aria-pressed', String(preview)); $('show-editor').setAttribute('aria-pressed', String(!preview));
  panelLayout.refresh();
  updatePreviewVisibilityControls();
  if (preview) requestAnimationFrame(() => viewer.refreshLayout());
}
onClick('show-editor', () => switchView(false)); onClick('show-preview', () => switchView(true));

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
  if (state.homeVisible || !state.meta?.project) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault(); runTask(() => event.key === 'ArrowLeft' ? navigationHistory.back() : navigationHistory.forward()); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); if (!state.operation && state.meta?.project) projectSearch.open(); return; }
  if (!event.ctrlKey && !event.metaKey) return;
  if (event.isComposing || state.editor?.composing || document.querySelector('dialog[open]')) return;
  if (event.target.closest('.cm-editor')) return;
  if (event.key.toLowerCase() === 's') { event.preventDefault(); runTask(event.shiftKey ? saveEveryDocument : saveCurrent); }
  else if (event.key === 'Enter') { event.preventDefault(); runTask(startBuild); }
});
window.addEventListener('beforeunload', event => {
  if (state.closed) return;
  syncDrafts(); persistSession(); sessionStore.flush().catch(() => {});
  if (dirtyDocuments().length || [...state.documents.values()].some(doc => doc.saving)) { event.preventDefault(); event.returnValue = ''; }
});
function pauseBrowserSession() {
  if (state.closed) return;
  syncDrafts(); persistSession(); sessionStore.flushOnHide();
  browserSession.stop();
}
function resumeBrowserSession(replaceConnection = false) {
  if (state.closed) return;
  if (replaceConnection) browserSession.resume();
  else browserSession.start();
  runTask(() => sessionStore.resume());
  runTask(heartbeat); scheduleAutoSave();
}
window.addEventListener('pagehide', pauseBrowserSession);
window.addEventListener('pageshow', () => resumeBrowserSession());
document.addEventListener('freeze', pauseBrowserSession);
document.addEventListener('resume', () => resumeBrowserSession(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeBrowserSession(true);
  else { syncDrafts(); persistSession(); sessionStore.flush().catch(() => {}); }
});
setInterval(() => { if (isRunning()) updateElapsed(); }, 1000);

async function initialise() {
  setOperation('initialising');
  try {
    await loadPreferences();
    const meta = await api('/api/state');
    await applyMeta(meta, true);
    if (meta.installationError) showError(new Error(meta.installationError));
    state.heartbeat = setInterval(() => runTask(heartbeat), 30000);
  } catch (error) { showError(error); }
  finally { setOperation(''); runTask(openInitialFile); }
}
browserSession.start();
initialise();
