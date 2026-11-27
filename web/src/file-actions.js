import { getLanguage, onLanguageChange } from './i18n.js';

const labels = {
  menu: ['ファイルとフォルダーの操作', 'File and folder actions'],
  newFile: ['ここに新規ファイルを作成', 'New file here'], newFolder: ['ここに新規フォルダーを作成', 'New folder here'],
  importFiles: ['コンピューターからファイルを追加…', 'Add files from your computer…'],
  rename: ['名前を変更', 'Rename'], remove: ['削除…', 'Delete…'],
  duplicate: ['コピーを作成…', 'Create a copy…'], copy: ['コピーを作成', 'Create a copy'],
  download: ['ダウンロード', 'Download'], saveAs: ['名前を付けて保存…', 'Save As…'],
  importProject: ['ZIP を読み込む…', 'Import ZIP…'], downloadProject: ['プロジェクトを ZIP でダウンロード', 'Download project as ZIP'], saveProjectAs: ['ZIP にして名前を付けて保存…', 'Save project ZIP as…'],
  relative: ['相対パスをコピー', 'Copy relative path'], absolute: ['絶対パスをコピー', 'Copy full path'],
  cancel: ['キャンセル', 'Cancel'], close: ['閉じる', 'Close'], create: ['作成', 'Create'], delete: ['削除', 'Delete'],
  path: ['プロジェクト内のパス', 'Path in the project'],
  copyPath: ['コピー先のプロジェクト内のパス', 'Destination path in the project'],
  copyTitle: ['ファイルやフォルダーのコピーを作成', 'Create a copy of a file or folder'],
  copyHelp: ['保存済みの内容をコピーします．名前や保存先を変更できます．元のファイルはそのまま残ります．', 'Copy the saved contents. You can change the name or destination folder. The original stays in place.'],
  copyDirty: ['次のファイルには未保存の編集があります．コピーには保存済みの内容を使います:', 'These files have unsaved edits. Their copies will use the saved contents:'],
  renameTitle: ['ファイルやフォルダーの名前を変更', 'Rename a file or folder'],
  renameHelp: ['既存のフォルダーへの移動もできます．原稿内のリンクや参照先は，変更後のパスに合わせて編集してください．', 'You can also move this item to an existing folder. Update links and references in your documents to use the new path.'],
  folderTitle: ['フォルダーを作成', 'Create a folder'], folderHelp: ['既存のフォルダー内に，新しいフォルダーを作成します．', 'Create a new folder inside an existing folder.'],
  deleteTitle: ['この項目を削除しますか？', 'Delete this item?'],
  deleteHelp: ['このファイルをディスクから削除します．この操作は元に戻せません．', 'This removes the file from disk and cannot be undone.'],
  deleteFolderHelp: ['このフォルダーと，次に示す全ての項目をディスクから削除します．この操作は元に戻せません．', 'This removes the folder and all items listed below from disk and cannot be undone.'],
  contents: ['フォルダーに含まれる項目', 'Items inside this folder'],
  counts: ['ファイル {files} 個，フォルダー {folders} 個', '{files} files and {folders} folders'],
  empty: ['このフォルダーは空です．', 'This folder is empty.'],
  dirty: ['次の未保存の本文と草稿も削除します:', 'The following unsaved text and drafts will also be removed:'],
  copied: ['パスをコピーしました．', 'Path copied.'], created: ['フォルダーを作成しました．', 'Folder created.'],
  renamed: ['名前を変更しました．', 'Item renamed.'], removed: ['削除しました．', 'Item deleted.'],
  duplicated: ['コピーを作成しました．', 'Copy created.'],
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
  return paths.find(path => {
    const candidate = normalize(path);
    return candidate && (!source || !entryContains(source, path)) && (candidate === target || candidate.startsWith(`${target}/`));
  }) || '';
}
export function absoluteProjectPath(root, relative) {
  if (!relative) return root;
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\');
  return root.replace(/[\\/]$/, '') + (windows ? '\\' : '/') + relative.replaceAll('/', windows ? '\\' : '/');
}

export function suggestEntryCopyPath(entry, paths, { platform = '' } = {}) {
  const normalize = value => {
    const normalized = String(value).replaceAll('\\', '/').normalize('NFC');
    return platform === 'windows' || platform === 'darwin' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  const occupied = new Set();
  for (const value of paths) {
    const path = normalize(value); occupied.add(path);
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) occupied.add(path.slice(0, end));
  }
  const slash = entry.path.lastIndexOf('/'), parent = entry.path.slice(0, slash + 1), name = entry.path.slice(slash + 1);
  const dot = entry.directory ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : '';
  for (let number = 1; ; number++) {
    const candidate = `${parent}${stem}-copy${number > 1 ? `-${number}` : ''}${extension}`;
    if (!occupied.has(normalize(candidate))) return candidate;
  }
}

export function createFileActions({ tree, getProject, getCopyPath, isBlocked, begin, end, inspectOpenDocuments, checkDestination, getUnsavedPaths, api, onChanged, onNewFile, onImportFiles = null, onDownload = null, onSaveAs = null, onImportProject = null, onDownloadProject = null, onSaveProjectAs = null, onError, onNotice }) {
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
  const contents = make('section', 'file-action-contents'); contents.hidden = true; contents.setAttribute('aria-live', 'polite');
  const dirty = make('div', 'file-action-unsaved');
  const error = make('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  body.append(current, help, label, input, contents, dirty, error);
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
    menu.ariaLabel = text('menu'); close.ariaLabel = text('close'); cancel.textContent = text('cancel'); label.textContent = text(action === 'copy' ? 'copyPath' : 'path');
    if (!dialog.open && !action) return;
    title.textContent = text(action === 'copy' ? 'copyTitle' : action === 'rename' ? 'renameTitle' : action === 'delete' ? 'deleteTitle' : 'folderTitle');
    help.textContent = text(action === 'copy' ? 'copyHelp' : action === 'rename' ? 'renameHelp' : action === 'delete' ? entry.directory ? 'deleteFolderHelp' : 'deleteHelp' : 'folderHelp');
    submit.textContent = text(action === 'copy' ? 'copy' : action === 'rename' ? 'rename' : action === 'delete' ? 'delete' : 'create');
    contents.replaceChildren(); contents.hidden = !['delete', 'copy'].includes(action) || !entry?.directory;
    if (!contents.hidden) {
      contents.append(make('h3', '', text('contents')));
      contents.append(make('p', 'file-action-counts', entry.empty ? text('empty') : text('counts').replace('{files}', entry.fileCount).replace('{folders}', entry.directoryCount)));
      if (entry.entries?.length) {
        const list = make('ul');
        for (const item of entry.entries) list.append(make('li', item.directory ? 'file-action-directory' : '', `${item.path}${item.directory ? '/' : ''}`));
        contents.append(list);
      }
    }
    const paths = ['delete', 'copy'].includes(action) ? getUnsavedPaths(entry) : [];
    dirty.replaceChildren(); dirty.hidden = !paths.length;
    if (paths.length) {
      dirty.append(make('p', '', text(action === 'copy' ? 'copyDirty' : 'dirty')));
      const list = make('ul'); for (const path of paths) list.append(make('li', '', path)); dirty.append(list);
    }
  }
  function release() { if (locked) { locked = false; end(); } }
  function finishDialog() {
    dialog.close(); action = ''; release();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function closeDialog() { if (!busy) finishDialog(); }
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  // The browser queues the close event. Complete the action now so that
  // keyboard input can immediately return to the file list.
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
  const perform = task => Promise.resolve().then(task).catch(onError);

  async function openDialog(kind, target) {
    closeMenu(); if (busy || isBlocked()) return;
    projectRoot = getProject()?.root; if (!projectRoot) return;
    action = kind; locked = true;
    try {
      await begin();
      entry = kind === 'folder' ? target : await api(`/api/entry?path=${encodeURIComponent(target.path)}`, { projectRoot, timeout: 60000 });
      if (kind !== 'folder') await inspectOpenDocuments(entry, kind);
      error.hidden = true; current.textContent = target.path || projectRoot;
      input.hidden = label.hidden = kind === 'delete'; input.required = kind !== 'delete';
      input.value = kind === 'copy' ? getCopyPath(entry) : kind === 'rename' ? target.path : (target.path ? `${target.path}/` : '');
      submit.classList.toggle('button-stop', kind === 'delete'); submit.classList.toggle('button-primary', kind !== 'delete');
      language(); dialog.showModal();
      if (kind === 'delete') cancel.focus();
      else {
        input.focus();
        const named = kind === 'rename' || kind === 'copy';
        const start = named ? input.value.lastIndexOf('/') + 1 : input.value.length;
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(start, named && !entry.directory && dot > start ? dot : input.value.length);
      }
    } catch (err) { action = ''; release(); throw err; }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || !action) return;
    busy = true; dialog.setAttribute('aria-busy', 'true'); error.hidden = true;
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    input.disabled = true;
    perform(async () => {
      let reviewRequired = false;
      try {
        const method = action === 'rename' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'POST';
        const body = action === 'folder' ? { path: input.value.trim() } : { path: entry.path, revision: entry.revision, ...(['rename', 'copy'].includes(action) ? { newPath: input.value.trim() } : {}), ...(action === 'copy' ? { action: 'copy' } : {}) };
        if (action !== 'delete') checkDestination(body.newPath || body.path, action === 'rename' ? entry : null);
        const result = await api('/api/entry', { method, body, projectRoot, timeout: action === 'copy' ? 120000 : 60000 });
        const finish = await onChanged(result);
        const message = text(action === 'copy' ? 'duplicated' : action === 'folder' ? 'created' : action === 'delete' ? 'removed' : 'renamed');
        returnFocus = [...tree.querySelectorAll('.file-button, .tree-directory')].find(node => node.dataset.path === result.path) || tree;
        if (returnFocus.matches('.tree-directory')) returnFocus = returnFocus.querySelector('summary');
        finishDialog(); await finish?.(); onNotice(result.historyWarning || message);
      } catch (err) {
        if (['delete', 'copy'].includes(action) && err?.data?.reviewRequired && err.data.entry?.path === entry.path) {
          entry = err.data.entry; language(); reviewRequired = true;
        }
        error.textContent = err?.message || String(err); error.hidden = false;
      }
      finally {
        busy = false; dialog.removeAttribute('aria-busy'); input.disabled = false;
        for (const button of dialog.querySelectorAll('button')) button.disabled = false;
        if (reviewRequired) cancel.focus();
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
    if (onImportFiles) item('importFiles', () => { if (returnFocus?.isConnected) returnFocus.focus(); onImportFiles(folder); });
    const separator = () => { const rule = make('div', 'file-menu-separator'); rule.role = 'separator'; menu.append(rule); };
    separator();
    if (target.path && !target.directory) {
      if (onDownload) item('download', () => { if (returnFocus?.isConnected) returnFocus.focus(); return onDownload(target); });
      if (onSaveAs) item('saveAs', () => { if (returnFocus?.isConnected) returnFocus.focus(); return onSaveAs(target); });
      if (onDownload || onSaveAs) separator();
    }
    if (target.path) item('relative', async () => { await navigator.clipboard.writeText(target.path); onNotice(text('copied')); });
    item('absolute', async () => { await navigator.clipboard.writeText(absoluteProjectPath(getProject().root, target.path)); onNotice(text('copied')); });
    if (target.path) { separator(); item('duplicate', () => openDialog('copy', target)); item('rename', () => openDialog('rename', target)); item('remove', () => openDialog('delete', target), true); }
    if (onImportProject || onDownloadProject || onSaveProjectAs) {
      separator();
      if (onImportProject) item('importProject', () => { if (returnFocus?.isConnected) returnFocus.focus(); onImportProject(); });
      if (onDownloadProject) item('downloadProject', onDownloadProject);
      if (onSaveProjectAs) item('saveProjectAs', onSaveProjectAs);
    }
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
