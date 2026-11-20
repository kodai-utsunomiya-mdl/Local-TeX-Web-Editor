import { getLanguage, onLanguageChange, t } from './i18n.js';
import { fileModificationTime, normalizeFileSort } from './file-sorting.js';

export function compiledPDFName(entry) {
  return typeof entry.name === 'string' && entry.name.trim()
    ? entry.name : t('{main} の PDF', { main: entry.main });
}

const entryKey = entry => JSON.stringify([entry.buildId, entry.main]);
const fractionalNanoseconds = value => Number((value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] || '').padEnd(9, '0').slice(0, 9));

export function visibleCompiledPDFs(entries, { filter = '', sort = 'name-asc', locale = getLanguage() } = {}) {
  sort = normalizeFileSort(sort);
  const query = String(filter).trim().toLocaleLowerCase(locale);
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const compareText = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  const compareNames = (a, b) => compareText(compiledPDFName(a), compiledPDFName(b)) || compareText(a.main, b.main) || compareText(a.buildId, b.buildId);
  const direction = sort.endsWith('-desc') ? -1 : 1;
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    if (!entry || typeof entry.main !== 'string' || !entry.main || typeof entry.buildId !== 'string' || !entry.buildId) return false;
    return !query || [compiledPDFName(entry), entry.main].some(value => value.toLocaleLowerCase(locale).includes(query));
  }).sort((a, b) => {
    if (sort === 'manual' || sort.startsWith('name-')) return direction * compareNames(a, b);
    const aTime = fileModificationTime(a.modifiedAt), bTime = fileModificationTime(b.modifiedAt);
    if (aTime === null || bTime === null) {
      if (aTime !== bTime) return aTime === null ? 1 : -1;
    } else {
      const difference = aTime - bTime || fractionalNanoseconds(a.modifiedAt) - fractionalNanoseconds(b.modifiedAt);
      if (difference) return direction * difference;
    }
    return compareNames(a, b);
  });
}

export function createCompiledPDFList({ onOpen, onDownload, onCopy, isBlocked = () => false, onError = () => {} }) {
  const document = globalThis.document, window = document.defaultView;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const element = make('section', 'compiled-pdfs');
  const heading = make('h3', 'compiled-pdfs-heading');
  const list = make('ul', 'compiled-pdf-list');
  element.append(heading, list); element.hidden = true;
  const menu = make('div', 'compiled-pdf-context-menu');
  menu.role = 'menu'; menu.hidden = true; document.body.append(menu);
  const actions = [
    { id: 'open', label: '開く', callback: onOpen },
    { id: 'download', label: 'PDF を保存', callback: onDownload },
    { id: 'copy', label: 'プロジェクトへコピー…', callback: onCopy },
  ];
  const listeners = [];
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  let current = new Map(), buttons = new Map(), context = null, busy = false, destroyed = false, rowSignature = '';
  let lastRender = { entries: [], activeBuildId: '', filter: '', sort: 'name-asc' };
  const blocked = () => destroyed || busy || isBlocked();
  const rowAt = target => target?.closest?.('.compiled-pdf-button');
  function closeMenu(restoreFocus = false) {
    const previous = context;
    context = null; menu.hidden = true;
    previous?.button.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous?.button.isConnected) previous.button.focus({ preventScroll: true });
  }
  function refreshDisabled() {
    const disabled = blocked();
    element.setAttribute('aria-busy', String(busy));
    for (const button of buttons.values()) button.setAttribute('aria-disabled', String(disabled));
  }
  function perform(action, key) {
    const entry = current.get(key);
    if (!entry || blocked() || typeof action !== 'function') { closeMenu(true); return; }
    closeMenu(true);
    busy = true; refreshDisabled();
    Promise.resolve().then(() => action(entry)).catch(error => onError(error)).finally(() => {
      busy = false;
      if (!destroyed) refreshDisabled();
    });
  }
  function openMenu(button, event, keyboard) {
    closeMenu();
    const key = button.dataset.compiledKey, entry = current.get(key);
    if (!entry || blocked()) return;
    context = { key, button };
    button.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-label', compiledPDFName(entry)); menu.replaceChildren();
    for (const { id, label, callback } of actions) {
      const item = make('button', '', t(label));
      item.type = 'button'; item.role = 'menuitem'; item.tabIndex = -1; item.dataset.action = id;
      item.disabled = typeof callback !== 'function';
      item.addEventListener('click', () => perform(callback, key)); menu.append(item);
    }
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect(), row = button.getBoundingClientRect();
    const x = keyboard ? row.left + 12 : event.clientX, y = keyboard ? row.bottom : event.clientY;
    menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - bounds.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - bounds.height - 6))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  function render(options = {}) {
    if (destroyed) return 0;
    lastRender = { entries: [], activeBuildId: '', filter: '', sort: 'name-asc', ...options };
    const entries = visibleCompiledPDFs(lastRender.entries, lastRender);
    current = new Map(entries.map(entry => [entryKey(entry), entry]));
    const signature = JSON.stringify([getLanguage(), lastRender.activeBuildId, entries.map(entry => [entryKey(entry), compiledPDFName(entry)])]);
    if (signature === rowSignature) {
      if (blocked()) closeMenu(true);
      refreshDisabled();
      return entries.length;
    }
    rowSignature = signature;
    const focused = rowAt(document.activeElement)?.dataset.compiledKey || (menu.contains(document.activeElement) ? context?.key : null);
    closeMenu();
    buttons = new Map(); list.replaceChildren();
    heading.textContent = t('コンパイルした PDF'); element.setAttribute('aria-label', heading.textContent);
    for (const entry of entries) {
      const key = entryKey(entry), name = compiledPDFName(entry);
      const item = make('li'), button = make('button', 'compiled-pdf-button');
      buttons.set(key, button);
      button.type = 'button'; button.dataset.compiledMain = entry.main; button.dataset.buildId = entry.buildId; button.dataset.compiledKey = key;
      button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.title = `${name}\n${t('コンパイル元: {main}', { main: entry.main })}`;
      const active = entry.buildId === lastRender.activeBuildId;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'true');
      const icon = make('span', 'compiled-pdf-icon', 'PDF'); icon.setAttribute('aria-hidden', 'true');
      const text = make('span', 'compiled-pdf-text');
      text.append(make('span', 'compiled-pdf-name', name), make('span', 'compiled-pdf-source', entry.main));
      button.append(icon, text); item.append(button); list.append(item);
    }
    element.hidden = entries.length === 0;
    refreshDisabled();
    if (focused && buttons.get(focused)?.isConnected) buttons.get(focused).focus({ preventScroll: true });
    return entries.length;
  }
  listen(element, 'click', event => {
    const button = rowAt(event.target);
    if (!button) return;
    event.stopPropagation(); perform(onOpen, button.dataset.compiledKey);
  });
  listen(element, 'contextmenu', event => {
    event.preventDefault(); event.stopPropagation();
    const button = rowAt(event.target);
    if (button) openMenu(button, event, event.button !== 2 && !event.ctrlKey);
  });
  listen(element, 'keydown', event => {
    if (event.isComposing || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    const button = rowAt(event.target);
    if (button) openMenu(button, event, true);
  });
  listen(menu, 'keydown', event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
  });
  listen(document, 'pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); }, true);
  listen(document, 'focusin', event => { if (!menu.hidden && !menu.contains(event.target) && event.target !== context?.button) closeMenu(); });
  listen(document, 'scroll', event => {
    if (!menu.hidden && (event.target === document || event.target?.contains?.(element))) closeMenu();
  }, { capture: true, passive: true });
  listen(window, 'resize', () => closeMenu()); listen(window, 'blur', () => closeMenu());
  const stopLanguage = onLanguageChange(() => render(lastRender));
  return { element, render, destroy() {
    destroyed = true; closeMenu(); stopLanguage();
    for (const remove of listeners) remove();
    menu.remove(); element.remove(); current.clear(); buttons.clear();
  } };
}
