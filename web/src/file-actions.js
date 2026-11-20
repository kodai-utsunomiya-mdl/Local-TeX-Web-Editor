import { getLanguage, onLanguageChange } from './i18n.js';

const labels = {
  menu: ['ファイルとフォルダーの操作', 'File and folder actions'],
  newFile: ['ここに新規ファイルを作成', 'New file here'], newFolder: ['ここに新規フォルダーを作成', 'New folder here'],
  rename: ['名前を変更', 'Rename'], remove: ['削除…', 'Delete…'],
  relative: ['相対パスをコピー', 'Copy relative path'], absolute: ['絶対パスをコピー', 'Copy full path'],
  cancel: ['キャンセル', 'Cancel'], close: ['閉じる', 'Close'], create: ['作成', 'Create'], delete: ['削除', 'Delete'],
  path: ['プロジェクト内のパス', 'Path in the project'],
  renameTitle: ['ファイルやフォルダーの名前を変更', 'Rename a file or folder'],
  renameHelp: ['既存のフォルダーへの移動もできます．原稿内のリンクや参照先は，変更後のパスに合わせて編集してください．', 'You can also move this item to an existing folder. Update links and references in your documents to use the new path.'],
  folderTitle: ['フォルダーを作成', 'Create a folder'], folderHelp: ['既存のフォルダー内に，新しいフォルダーを作成します．', 'Create a new folder inside an existing folder.'],
  deleteTitle: ['この項目を削除しますか？', 'Delete this item?'],
  deleteHelp: ['ファイルをディスクから削除します．この操作は元に戻せません．フォルダーは空の場合に削除できます．', 'This removes the file from disk and cannot be undone. Folders can be deleted when empty.'],
  dirty: ['次の未保存の本文と草稿も削除します:', 'The following unsaved text and drafts will also be removed:'],
  copied: ['パスをコピーしました．', 'Path copied.'], created: ['フォルダーを作成しました．', 'Folder created.'],
  renamed: ['名前を変更しました．', 'Item renamed.'], removed: ['削除しました．', 'Item deleted.'],
  stale: ['開いているファイルがディスク上で変更されています．本文とディスクの内容を確認し，ファイルを開き直してから操作してください．', 'An open file has changed on disk. Check your text and the file on disk, then reopen it before continuing.'],
  occupied: ['変更先に開いているファイルや未保存の草稿があります．別の名前を指定するか，そのタブと草稿の内容を確認してから操作してください．', 'The destination has an open file or an unsaved draft. Choose another name, or review that tab and its drafts before continuing.'],
};
export const fileActionText = key => labels[key]?.[getLanguage() === 'ja' ? 0 : 1] || key;
const make = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; };
const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export function mapEntryPath(path, from, to, directory) {
  if (path === from) return to;
  return directory && path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}
export function entryContains(entry, path) { return path === entry.path || (entry.directory && path.startsWith(`${entry.path}/`)); }
export function fileDestinationConflict(destination, paths, { source = null, platform = '' } = {}) {
  const normalize = value => {
    const path = String(value || '').trim().replaceAll('\\', '/').normalize('NFC');
    return platform === 'windows' || platform === 'darwin' ? path.toLocaleLowerCase('en-US') : path;
  };
  const target = normalize(destination);
  const origin = source && { path: normalize(source.path), directory: source.directory };
  return paths.find(path => {
    const candidate = normalize(path);
    return candidate && (!origin || !entryContains(origin, candidate)) && (candidate === target || candidate.startsWith(`${target}/`));
  }) || '';
}
export function absoluteProjectPath(root, relative) {
  if (!relative) return root;
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\');
  return root.replace(/[\\/]$/, '') + (windows ? '\\' : '/') + relative.replaceAll('/', windows ? '\\' : '/');
}

export function createFileActions({ tree, getProject, isBlocked, begin, end, inspectOpenDocuments, checkDestination, getUnsavedPaths, api, onChanged, onNewFile, onError, onNotice }) {
  const menu = make('div', 'file-context-menu'); menu.id = 'file-context-menu'; menu.role = 'menu'; menu.hidden = true;
  const dialog = make('dialog', 'dialog file-action-dialog'); dialog.id = 'file-action-dialog'; dialog.setAttribute('aria-labelledby', 'file-action-title');
  const form = make('form');
  const heading = make('div', 'dialog-heading'), title = make('h2'); title.id = 'file-action-title';
  const close = make('button', 'icon-button', '×'); close.type = 'button';
  heading.append(title, close);
  const body = make('div', 'file-action-body');
  const current = make('p', 'file-action-current'), help = make('p', 'field-help');
  const label = make('label', 'field-label'); label.htmlFor = 'file-action-path';
  const input = make('input'); input.id = 'file-action-path'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
  const dirty = make('div', 'file-action-unsaved');
  const error = make('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  body.append(current, help, label, input, dirty, error);
  const footer = make('div', 'dialog-actions'), cancel = make('button', 'button'), submit = make('button', 'button button-primary');
  cancel.type = 'button'; submit.type = 'submit'; submit.id = 'file-action-submit';
  footer.append(cancel, submit); form.append(heading, body, footer); dialog.append(form); document.body.append(menu, dialog);
  let returnFocus = null, action = '', entry = null, projectRoot = '', busy = false, locked = false;
  const text = fileActionText;

  function closeMenu(restore = false) {
    menu.hidden = true;
    if (returnFocus?.isConnected) { returnFocus.setAttribute('aria-expanded', 'false'); if (restore) returnFocus.focus(); }
  }
  function language() {
    menu.ariaLabel = text('menu'); close.ariaLabel = text('close'); cancel.textContent = text('cancel'); label.textContent = text('path');
    if (!dialog.open && !action) return;
    title.textContent = text(action === 'rename' ? 'renameTitle' : action === 'delete' ? 'deleteTitle' : 'folderTitle');
    help.textContent = text(action === 'rename' ? 'renameHelp' : action === 'delete' ? 'deleteHelp' : 'folderHelp');
    submit.textContent = text(action === 'rename' ? 'rename' : action === 'delete' ? 'delete' : 'create');
    const paths = action === 'delete' ? getUnsavedPaths(entry) : [];
    dirty.replaceChildren(); dirty.hidden = !paths.length;
    if (paths.length) {
      dirty.append(make('p', '', text('dirty')));
      const list = make('ul'); for (const path of paths) list.append(make('li', '', path)); dirty.append(list);
    }
  }
  function release() { if (locked) { locked = false; end(); } }
  function closeDialog() { if (!busy) dialog.close(); }
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { action = ''; release(); if (returnFocus?.isConnected) returnFocus.focus(); });
  const perform = task => Promise.resolve().then(task).catch(onError);

  async function openDialog(kind, target) {
    closeMenu(); if (busy || isBlocked()) return;
    projectRoot = getProject()?.root; if (!projectRoot) return;
    action = kind; locked = true;
    try {
      await begin();
      entry = kind === 'folder' ? target : await api(`/api/entry?path=${encodeURIComponent(target.path)}`, { projectRoot });
      if (kind !== 'folder') await inspectOpenDocuments(entry);
      error.hidden = true; current.textContent = target.path || projectRoot;
      input.hidden = label.hidden = kind === 'delete'; input.required = kind !== 'delete';
      input.value = kind === 'rename' ? target.path : (target.path ? `${target.path}/` : '');
      submit.classList.toggle('button-stop', kind === 'delete'); submit.classList.toggle('button-primary', kind !== 'delete');
      language(); dialog.showModal();
      if (kind === 'delete') cancel.focus();
      else {
        input.focus();
        const start = kind === 'rename' ? input.value.lastIndexOf('/') + 1 : input.value.length;
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(start, kind === 'rename' && !entry.directory && dot > start ? dot : input.value.length);
      }
    } catch (err) { action = ''; release(); throw err; }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || !action) return;
    busy = true; dialog.setAttribute('aria-busy', 'true'); error.hidden = true;
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    input.disabled = true;
    perform(async () => {
      try {
        const method = action === 'rename' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST';
        const body = action === 'folder' ? { path: input.value.trim() } : { path: entry.path, revision: entry.revision, ...(action === 'rename' ? { newPath: input.value.trim() } : {}) };
        if (action !== 'delete') checkDestination(body.newPath || body.path, action === 'rename' ? entry : null);
        const result = await api('/api/entry', { method, body, projectRoot });
        const finish = await onChanged(result);
        const message = text(action === 'folder' ? 'created' : action === 'delete' ? 'removed' : 'renamed');
        returnFocus = [...tree.querySelectorAll('.file-button, .tree-directory')].find(node => node.dataset.path === result.path) || tree;
        if (returnFocus.matches('.tree-directory')) returnFocus = returnFocus.querySelector('summary');
        dialog.close(); release(); await finish?.(); onNotice(result.historyWarning || message);
      } catch (err) { error.textContent = err?.message || String(err); error.hidden = false; }
      finally {
        busy = false; dialog.removeAttribute('aria-busy'); input.disabled = false;
        for (const button of dialog.querySelectorAll('button')) button.disabled = false;
      }
    });
  });

  function targetAt(node) {
    const file = node.closest('.file-button');
    if (file && tree.contains(file)) return { path: file.dataset.path, directory: false, anchor: file };
    const directory = node.closest('.tree-directory');
    if (directory && tree.contains(directory)) return { path: directory.dataset.path, directory: true, anchor: directory.querySelector('summary') };
    return { path: '', directory: true, anchor: tree };
  }
  function openMenu(target, x, y) {
    if (busy || isBlocked() || !getProject()) return;
    closeMenu(); returnFocus = target.anchor;
    returnFocus.setAttribute('aria-haspopup', 'menu'); returnFocus.setAttribute('aria-expanded', 'true');
    menu.replaceChildren();
    const folder = target.directory ? target.path : parentPath(target.path);
    const item = (key, handler, danger = false) => {
      const button = make('button', danger ? 'danger' : '', text(key)); button.type = 'button'; button.role = 'menuitem'; button.tabIndex = -1; button.dataset.action = key;
      button.addEventListener('click', () => { closeMenu(); perform(handler); }); menu.append(button);
    };
    item('newFile', () => onNewFile(folder)); item('newFolder', () => openDialog('folder', { path: folder, directory: true }));
    const separator = () => { const rule = make('div', 'file-menu-separator'); rule.role = 'separator'; menu.append(rule); };
    separator();
    if (target.path) item('relative', async () => { await navigator.clipboard.writeText(target.path); onNotice(text('copied')); });
    item('absolute', async () => { await navigator.clipboard.writeText(absoluteProjectPath(getProject().root, target.path)); onNotice(text('copied')); });
    if (target.path) { separator(); item('rename', () => openDialog('rename', target)); item('remove', () => openDialog('delete', target), true); }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, innerWidth - rect.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, innerHeight - rect.height - 6))}px`;
    menu.querySelector('button')?.focus();
  }
  tree.addEventListener('contextmenu', event => { if (isBlocked() || !getProject()) return; event.preventDefault(); openMenu(targetAt(event.target), event.clientX, event.clientY); });
  tree.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); const target = targetAt(event.target), rect = target.anchor.getBoundingClientRect(); openMenu(target, rect.left + 12, rect.bottom);
    } else if (['F2', 'Delete'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const target = targetAt(event.target); if (!target.path || isBlocked()) return;
      event.preventDefault(); returnFocus = target.anchor; perform(() => openDialog(event.key === 'F2' ? 'rename' : 'delete', target));
    }
  });
  menu.addEventListener('keydown', event => {
    const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(true); }
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); });
  window.addEventListener('resize', () => closeMenu()); tree.addEventListener('scroll', () => closeMenu(), { passive: true });
  tree.tabIndex = 0;
  onLanguageChange(() => { closeMenu(); language(); }); language();
  return { closeMenu, get open() { return dialog.open || !menu.hidden; } };
}
