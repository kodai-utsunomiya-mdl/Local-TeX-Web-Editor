import { onLanguageChange, t } from './i18n.js';

const transferType = 'application/x-local-tex-editor-file-tree';
const rowSelector = '.file-button[data-path], .tree-directory > summary';
const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fileName = path => path.slice(path.lastIndexOf('/') + 1);

export function fileTreeDropPlacement(bounds, clientY, directory = false) {
  if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.height) || bounds.height <= 0 || !Number.isFinite(clientY)) return null;
  const offset = clientY - bounds.top;
  if (offset < 0 || offset > bounds.height) return null;
  if (!directory) return offset < bounds.height / 2 ? 'before' : 'after';
  const edge = Math.min(8, bounds.height / 4);
  return offset < edge ? 'before' : offset > bounds.height - edge ? 'after' : 'inside';
}

export function fileTreeDropDestination({ source, target, placement } = {}) {
  if (!source?.path || !target || !['before', 'after', 'inside', 'root'].includes(placement)) return null;
  const parent = placement === 'root' ? '' : placement === 'inside' ? target.path : parentPath(target.path);
  return parent ? `${parent}/${fileName(source.path)}` : fileName(source.path);
}

export function validFileTreeDrop(request) {
  const { source, target, placement } = request || {};
  if (typeof source?.path !== 'string' || !source.path || typeof target?.path !== 'string') return false;
  if (!['before', 'after', 'inside', 'root'].includes(placement)) return false;
  if (placement === 'root' ? target.path !== '' || !target.directory : !target.path) return false;
  if (placement === 'inside' && !target.directory) return false;
  if (source.path === target.path || source.directory && target.path.startsWith(`${source.path}/`)) return false;
  if (['inside', 'root'].includes(placement) && fileTreeDropDestination(request) === source.path) return false;
  return true;
}

export function fileTreeKeyboardDrop(entries, path, direction) {
  if (!Array.isArray(entries) || typeof path !== 'string' || !path || ![-1, 1].includes(direction)) return null;
  const siblings = entries.filter(entry => typeof entry?.path === 'string' && parentPath(entry.path) === parentPath(path));
  const index = siblings.findIndex(entry => entry.path === path);
  if (index < 0 || !siblings[index + direction]) return null;
  const item = entry => ({ path: entry.path, directory: Boolean(entry.directory) });
  const request = { source: item(siblings[index]), target: item(siblings[index + direction]), placement: direction < 0 ? 'before' : 'after' };
  return validFileTreeDrop(request) ? request : null;
}

export function fileTreeScrollSpeed(bounds, clientY) {
  if (!bounds || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.height) || bounds.height <= 0 || !Number.isFinite(clientY)) return 0;
  const offset = clientY - bounds.top, edge = Math.min(42, bounds.height / 3);
  if (offset < 0 || offset > bounds.height) return 0;
  if (offset < edge) return -480 * ((edge - offset) / edge) ** 2;
  if (offset > bounds.height - edge) return 480 * ((offset - bounds.height + edge) / edge) ** 2;
  return 0;
}

export function createFileTreeDrag({ tree, isBlocked = () => false, getProjectRoot, onDrop, onError = () => {} }) {
  const document = tree.ownerDocument, view = document.defaultView;
  const live = document.createElement('div');
  live.className = 'sr-only file-tree-drag-status'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  tree.after(live);
  let drag = null, target = null, hoverTimer = null, frame = null, pointer = null, frameTime = 0, pending = false, disposed = false, message = null;

  function announce(key, values = {}) {
    message = { key, values };
    const text = t(key, values);
    if (live.textContent !== text) live.textContent = text;
  }

  function rowEntry(row) {
    if (!row || !tree.contains(row)) return null;
    const directory = row.matches('.tree-directory > summary');
    const path = directory ? row.parentElement.dataset.path : row.dataset.path;
    return path ? { path, directory } : null;
  }

  function findRow(path, directory) {
    return [...tree.querySelectorAll(rowSelector)].find(row => {
      const entry = rowEntry(row);
      return entry?.path === path && entry.directory === directory;
    });
  }

  function clearTarget() {
    if (hoverTimer !== null) { view.clearTimeout(hoverTimer); hoverTimer = null; }
    if (target?.row) target.row.classList.remove('file-tree-drop-before', 'file-tree-drop-after', 'file-tree-drop-inside');
    tree.classList.remove('file-tree-drop-root');
    tree.removeAttribute('data-drop-label');
    target = null;
  }

  function finishDrag() {
    clearTarget();
    drag?.row.classList.remove('file-tree-dragging');
    tree.classList.remove('file-tree-drag-active');
    drag = null; pointer = null; frameTime = 0;
    if (frame !== null) { view.cancelAnimationFrame(frame); frame = null; }
  }

  function activeDrag() {
    return drag && !pending && !isBlocked() && drag.root === getProjectRoot() && drag.row.isConnected && tree.contains(drag.row);
  }

  function accepts(event, dropping = false) {
    if (!activeDrag()) return false;
    const types = Array.from(event.dataTransfer?.types || []);
    if (types.includes('Files') || !types.includes(transferType)) return false;
    return !dropping || event.dataTransfer.getData(transferType) === drag.token;
  }

  function targetAt(element, clientY) {
    if (!element || !tree.contains(element)) return null;
    if (element.closest?.('.compiled-pdfs')) return null;
    const row = element.closest?.(rowSelector);
    if (row && tree.contains(row)) {
      const entry = rowEntry(row);
      return { row, entry, placement: fileTreeDropPlacement(row.getBoundingClientRect(), clientY, entry?.directory) };
    }
    const directory = element.closest?.('.tree-directory');
    if (directory && tree.contains(directory)) {
      const summary = directory.querySelector(':scope > summary');
      return { row: summary, entry: rowEntry(summary), placement: 'inside' };
    }
    return { row: null, entry: { path: '', directory: true }, placement: 'root' };
  }

  function describe(request, complete = false) {
    const values = { source: request.source.path, target: request.target.path };
    if (request.placement === 'root') return [complete ? '{source} をプロジェクトの最上位へ移動しました．' : '{source} をプロジェクトの最上位へ移動', values];
    if (request.placement === 'inside') return [complete ? '{source} を {target} の中へ移動しました．' : '{source} を {target} の中へ移動', values];
    if (request.placement === 'before') return [complete ? '{source} を {target} の前へ移動しました．' : '{source} を {target} の前へ移動', values];
    return [complete ? '{source} を {target} の後へ移動しました．' : '{source} を {target} の後へ移動', values];
  }

  function updateTarget(element, clientY) {
    const next = targetAt(element, clientY);
    if (!next || !validFileTreeDrop({ source: drag?.entry, target: next.entry, placement: next.placement })) { clearTarget(); return false; }
    if (target?.row === next.row && target?.placement === next.placement && target?.entry.path === next.entry.path) return true;
    clearTarget(); target = next;
    if (next.row) next.row.classList.add(`file-tree-drop-${next.placement}`);
    else { tree.classList.add('file-tree-drop-root'); tree.dataset.dropLabel = t('プロジェクトの最上位へ移動'); }
    announce(...describe({ source: drag.entry, target: next.entry, placement: next.placement }));
    if (next.placement === 'inside' && next.row && !next.row.parentElement.open) {
      hoverTimer = view.setTimeout(() => {
        hoverTimer = null;
        if (activeDrag() && target === next && next.row.isConnected) next.row.parentElement.open = true;
      }, 650);
    }
    return true;
  }

  function scrollFrame(time) {
    frame = null;
    if (!activeDrag()) { finishDrag(); return; }
    const elapsed = frameTime ? Math.min(40, time - frameTime) : 16;
    frameTime = time;
    if (pointer) {
      const bounds = tree.getBoundingClientRect();
      if (pointer.x >= bounds.left && pointer.x <= bounds.right) {
        const speed = fileTreeScrollSpeed(bounds, pointer.y), before = tree.scrollTop;
        if (speed) tree.scrollTop += speed * elapsed / 1000;
        if (tree.scrollTop !== before) updateTarget(document.elementFromPoint(pointer.x, pointer.y), pointer.y);
      }
    }
    frame = view.requestAnimationFrame(scrollFrame);
  }

  function start(event) {
    const row = event.target.closest?.(rowSelector), entry = rowEntry(row);
    if (!entry) return;
    finishDrag();
    const root = getProjectRoot();
    if (!root || pending || isBlocked() || !row.draggable || row.disabled || !event.dataTransfer) { event.preventDefault(); return; }
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    try {
      event.dataTransfer.setData(transferType, token);
      event.dataTransfer.effectAllowed = 'move';
    } catch (error) { event.preventDefault(); onError(error); return; }
    drag = { row, entry, root, token };
    row.focus({ preventScroll: true });
    row.classList.add('file-tree-dragging'); tree.classList.add('file-tree-drag-active');
    announce('{source} の移動先を選んでください．', { source: entry.path });
    frame = view.requestAnimationFrame(scrollFrame);
  }

  function over(event) {
    if (!accepts(event)) {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; }
      if (drag) finishDrag();
      return;
    }
    pointer = { x: event.clientX, y: event.clientY };
    const allowed = updateTarget(event.target, event.clientY);
    event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    if (allowed) event.preventDefault();
  }

  function leave(event) {
    if (event.relatedTarget && tree.contains(event.relatedTarget)) return;
    const bounds = tree.getBoundingClientRect();
    if (!event.relatedTarget && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
    pointer = null; clearTarget();
  }

  async function apply(request, root) {
    if (disposed || pending || isBlocked() || getProjectRoot() !== root || !validFileTreeDrop(request)) return;
    pending = true;
    try {
      const result = await onDrop(request);
      if (disposed || getProjectRoot() !== root) return;
      if (result === false) { announce('移動を取り消しました．'); return; }
      const path = typeof result?.path === 'string' ? result.path : fileTreeDropDestination(request);
      const row = findRow(path, request.source.directory);
      row?.focus({ preventScroll: true }); row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      announce(...describe(request, true));
    } catch (error) {
      if (!disposed && getProjectRoot() === root) { announce('移動できませんでした．'); onError(error); }
    } finally { pending = false; }
  }

  function drop(event) {
    if (!accepts(event, true)) {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
      if (drag) finishDrag();
      return;
    }
    const valid = updateTarget(event.target, event.clientY);
    event.preventDefault(); event.stopPropagation();
    if (!valid) { finishDrag(); return; }
    const request = { source: { ...drag.entry }, target: { ...target.entry }, placement: target.placement }, root = drag.root;
    finishDrag();
    void apply(request, root);
  }

  function keyboard(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const row = event.target.closest?.(rowSelector), source = rowEntry(row);
    if (!source || row.disabled || isBlocked() || pending || !getProjectRoot()) return;
    event.preventDefault(); event.stopPropagation();
    const list = row.closest('li')?.parentElement;
    const entries = [...(list?.children || [])].map(item => rowEntry(item.querySelector(':scope > .file-button, :scope > .tree-directory > summary'))).filter(Boolean);
    const request = fileTreeKeyboardDrop(entries, source.path, event.key === 'ArrowUp' ? -1 : 1);
    if (!request) { announce(event.key === 'ArrowUp' ? '{source} はこの階層の先頭です．' : '{source} はこの階層の最後です．', { source: source.path }); return; }
    finishDrag();
    void apply(request, getProjectRoot());
  }

  function refresh() {
    if (disposed) return;
    for (const row of tree.querySelectorAll(rowSelector)) {
      const keys = new Set((row.getAttribute('aria-keyshortcuts') || '').split(/\s+/).filter(Boolean));
      keys.add('Alt+ArrowUp'); keys.add('Alt+ArrowDown');
      row.setAttribute('aria-keyshortcuts', [...keys].join(' '));
    }
    if (drag && !activeDrag()) finishDrag();
  }

  const outsideDrop = event => { if (!tree.contains(event.target)) finishDrag(); };
  const escape = event => { if (drag && event.key === 'Escape') { finishDrag(); announce('移動を取り消しました．'); } };
  const observer = new view.MutationObserver(refresh);
  observer.observe(tree, { childList: true, subtree: true });
  const removeLanguageListener = onLanguageChange(() => {
    if (message) live.textContent = t(message.key, message.values);
    if (target?.placement === 'root') tree.dataset.dropLabel = t('プロジェクトの最上位へ移動');
  });
  tree.addEventListener('dragstart', start); tree.addEventListener('dragover', over); tree.addEventListener('dragleave', leave); tree.addEventListener('drop', drop); tree.addEventListener('keydown', keyboard);
  document.addEventListener('dragend', finishDrag, true); document.addEventListener('drop', outsideDrop); document.addEventListener('keydown', escape, true);
  refresh();
  return {
    cancel: finishDrag, refresh,
    destroy() {
      if (disposed) return;
      disposed = true; finishDrag(); observer.disconnect(); removeLanguageListener(); live.remove();
      tree.removeEventListener('dragstart', start); tree.removeEventListener('dragover', over); tree.removeEventListener('dragleave', leave); tree.removeEventListener('drop', drop); tree.removeEventListener('keydown', keyboard);
      document.removeEventListener('dragend', finishDrag, true); document.removeEventListener('drop', outsideDrop); document.removeEventListener('keydown', escape, true);
    },
  };
}
