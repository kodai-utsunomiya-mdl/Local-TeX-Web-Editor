import { Transaction as SourceTransaction } from '@codemirror/state';
import { NodeSelection, Selection } from 'prosemirror-state';
import { t, onLanguageChange } from './i18n.js';
import { isMac } from './platform-keys.js';

const commonItems = [
  { action: 'image', label: '画像を挿入' },
  { action: 'table', label: '表を挿入' },
];
const markdownItems = [
  ...commonItems,
  { action: 'page', label: '新しい Markdown ページ' },
  { action: 'link', label: 'リンクを挿入' },
  { action: 'math', label: '数式を挿入' },
  { action: 'code', label: 'コードブロック' },
];

export function editorInsertionItems(path) {
  return /\.(md|markdown)$/i.test(path || '') ? markdownItems : /\.tex$/i.test(path || '') ? commonItems : [];
}

function containsPosition(from, to, position) { return from < to && position >= from && position <= to; }
function selectionContains(selection, position) {
  return selection.ranges.some(range => containsPosition(range.from ?? range.$from.pos, range.to ?? range.$to.pos, position));
}

// The host intercepts secondary-button mousedown before the browser or editor
// moves the caret. Resolve the clicked position before activating another pane,
// since switching its preview can change the editor's width.
export function prepareEditorContext(editor, { x, y, keyboard = false }) {
  const { view, kind } = editor;
  if (view.composing || (kind === 'source' && view.state.readOnly)) return null;
  const hit = keyboard ? null : kind === 'source'
    ? view.posAtCoords({ x, y }) : view.posAtCoords({ left: x, top: y });
  if (!keyboard && hit == null) return null;
  editor.activate();
  if (!keyboard) {
    if (kind === 'source') {
      const selected = view.state.selection.ranges.find(range => containsPosition(range.from, range.to, hit));
      if (!selected || selected !== view.state.selection.main) {
        view.dispatch({ selection: selected ? { anchor: selected.anchor, head: selected.head } : { anchor: hit }, annotations: SourceTransaction.addToHistory.of(false) });
      }
    } else if (!selectionContains(view.state.selection, hit.pos)) {
      const node = hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
      const selection = node?.isAtom && NodeSelection.isSelectable(node)
        ? NodeSelection.create(view.state.doc, hit.inside) : Selection.near(view.state.doc.resolve(hit.pos));
      view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
    }
  }
  const selection = view.state.selection;
  const position = kind === 'source' ? selection.main.head : selection.head;
  const caret = keyboard ? view.coordsAtPos(position) : null;
  const bounds = view.dom.getBoundingClientRect();
  return { ...editor, document: view.state.doc, selection,
    x: keyboard ? caret?.left ?? bounds.left + 12 : x,
    y: keyboard ? caret?.bottom ?? bounds.top + 20 : y };
}

export function editorContextIsCurrent(context) {
  return Boolean(context && context.isCurrent() && context.view.state.doc === context.document && context.view.state.selection.eq(context.selection));
}

export function createEditorContextMenu({ root, getEditor, actions, isBlocked = () => false, onError = () => {} }) {
  const document = root.ownerDocument, window = document.defaultView;
  const menu = document.createElement('div');
  menu.id = 'editor-context-menu'; menu.className = 'editor-context-menu'; menu.role = 'menu'; menu.hidden = true;
  menu.setAttribute('aria-label', t('原稿への挿入'));
  document.body.append(menu);
  let context = null;
  const listeners = [];
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options); listeners.push(() => target.removeEventListener(name, callback, options));
  };
  function close(restore = false) {
    const previous = context;
    menu.hidden = true; context = null;
    if (restore && previous?.isCurrent()) { previous.activate(); previous.view.focus(); }
  }
  function available(target) {
    if (isBlocked()) return null;
    const editor = getEditor(target);
    return editor && editorInsertionItems(editor.path).length && !editor.view.composing ? editor : null;
  }
  function open(editor, event, keyboard) {
    close();
    const prepared = prepareEditorContext(editor, { x: event.clientX, y: event.clientY, keyboard });
    if (!prepared) return false;
    context = prepared;
    menu.replaceChildren(); menu.setAttribute('aria-label', t('原稿への挿入'));
    for (const { action, label } of editorInsertionItems(editor.path)) {
      const button = document.createElement('button');
      button.type = 'button'; button.role = 'menuitem'; button.tabIndex = -1; button.dataset.action = action; button.textContent = t(label);
      button.addEventListener('click', () => {
        const target = context;
        if (isBlocked() || !editorContextIsCurrent(target)) { close(true); return; }
        close(); target.activate();
        Promise.resolve().then(() => actions[action]?.()).catch(error => { target.view.focus(); onError(error); });
      });
      menu.append(button);
    }
    const hint = document.createElement('p');
    hint.className = 'editor-context-menu-hint'; hint.id = 'editor-context-menu-hint'; hint.setAttribute('role', 'presentation');
    hint.textContent = t('コピー・貼り付けなどは Shift + 右クリックで開けます．');
    menu.setAttribute('aria-describedby', hint.id); menu.append(hint);
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(prepared.x, window.innerWidth - bounds.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(prepared.y, window.innerHeight - bounds.height - 6))}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
    return true;
  }
  listen(root, 'mousedown', event => {
    if ((event.button !== 2 && !(isMac && event.button === 0 && event.ctrlKey)) || event.shiftKey || !available(event.target)) return;
    event.preventDefault(); event.stopPropagation();
  }, true);
  listen(root, 'contextmenu', event => {
    if (event.shiftKey) { close(); return; }
    const editor = available(event.target);
    if (editor && open(editor, event, event.button !== 2 && !event.ctrlKey)) {
      event.preventDefault(); event.stopPropagation();
    }
  }, true);
  listen(root, 'keydown', event => {
    if (event.isComposing || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) || event.ctrlKey || event.metaKey || event.altKey) return;
    const editor = available(event.target);
    if (editor && open(editor, event, true)) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  listen(menu, 'keydown', event => {
    const buttons = [...menu.querySelectorAll('button')], current = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  listen(document, 'pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) close(); }, true);
  listen(document, 'scroll', event => {
    if (!menu.hidden && (event.target === document || event.target === context?.scrollRoot || context?.scrollRoot?.contains(event.target))) close();
  }, { passive: true, capture: true });
  listen(window, 'resize', () => close()); listen(window, 'blur', () => close());
  const stopLanguage = onLanguageChange(() => close(true));
  return { close, get open() { return !menu.hidden; }, destroy() { close(); stopLanguage(); for (const remove of listeners) remove(); menu.remove(); } };
}
