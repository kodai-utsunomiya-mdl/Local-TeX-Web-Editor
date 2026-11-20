import { t, onLanguageChange, translateElements } from './i18n.js';
import { element, labelledInput, translated } from './import-dialog.js';

const MAX_FILE = 128 * 1024 * 1024;
const fileSize = bytes => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;

export function createFileImporter({ api, uploadFile, getProject, isBlocked = () => false, begin = async () => {}, end = () => {}, checkDestination = () => {}, onImported = async () => {}, onError = () => {}, onNotice = () => {} }) {
  const dialog = element('dialog', { id: 'file-import-dialog', class: 'dialog import-dialog file-import-dialog', 'aria-labelledby': 'file-import-title' });
  const header = element('div', { class: 'dialog-heading' });
  const close = translated('button', '閉じる', { type: 'button', class: 'icon-button', 'aria-label': t('閉じる'), 'data-i18n-aria-label': '閉じる' }); close.textContent = '×'; close.removeAttribute('data-i18n');
  header.append(translated('h2', 'コンピューターからファイルを追加', { id: 'file-import-title' }), close);
  const body = element('div', { class: 'import-body' });
  const help = translated('p', '選んだファイルをプロジェクトへコピーします．元のファイルはそのまま残ります．1 個あたり 128 MiB まで追加できます．', { class: 'field-help' });
  const folder = labelledInput('file-import-folder', '追加先のフォルダー', 'select');
  const picker = element('input', { id: 'file-import-input', type: 'file', multiple: '', hidden: '' });
  const choose = translated('button', 'ファイルを選び直す…', { type: 'button', class: 'button', id: 'file-import-choose' });
  const list = element('ol', { class: 'file-import-list', id: 'file-import-list' });
  const status = element('p', { class: 'field-help', id: 'file-import-progress', role: 'status', 'aria-live': 'polite' });
  const error = element('p', { class: 'form-error', role: 'alert', hidden: '' });
  const footer = element('div', { class: 'dialog-actions' });
  const refresh = translated('button', '保存先を再確認', { type: 'button', class: 'button', id: 'file-import-refresh' });
  const cancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const confirm = translated('button', 'ファイルを追加', { type: 'button', class: 'button button-primary', id: 'file-import-confirm' });
  footer.append(refresh, cancel, confirm); body.append(help, folder.group, choose, list, status);
  dialog.append(header, body, error, footer); document.body.append(dialog, picker);
  let rows = [], projectRoot = '', returnFocus = null, pickerContext = null, locked = false, opening = false;
  let generation = 0, previewController = null, uploadController = null, uploading = false, stopped = false, pendingResult = null, needsRefresh = false;
  let focusPath = '', attemptedPaths = new Set();

  function showError(value) { error.textContent = value?.message || String(value); error.hidden = false; }
  function clearError() { error.textContent = ''; error.hidden = true; }
  function completeCount() { return rows.filter(row => row.done).length; }
  function focusAfterClose() {
    const visible = node => node?.isConnected && node.getClientRects().length > 0 && !node.disabled;
    if (visible(returnFocus)) { returnFocus.focus(); return; }
    const directory = [...document.querySelectorAll('.tree-directory')].find(node => node.dataset.path === focusPath);
    const next = directory?.querySelector('summary') || document.getElementById('import-files') || document.getElementById('file-tree');
    if (visible(next)) next.focus();
  }
  async function notifyImported(result, refreshState = false) {
    let latest = result || {};
    if (refreshState) latest = { ...latest, state: await api('/api/state', { projectRoot }) };
    if (latest.state?.project?.root && latest.state.project.root !== projectRoot) throw new Error(t('プロジェクトが切り替わりました．追加先を選び直してください．'));
    await onImported({ ...latest, importedPaths: [...new Set([...rows.filter(row => row.done).map(row => row.path), ...(refreshState ? attemptedPaths : [])])] });
  }
  async function closeDialog() {
    if (uploading) { stopped = true; uploadController?.abort(); return; }
    if (pendingResult || needsRefresh) {
      uploading = true; updateControls();
      try { await notifyImported(pendingResult, true); }
      catch (err) { onError(err); }
      finally { uploading = false; }
    }
    const copied = completeCount();
    generation++; previewController?.abort(); previewController = null; pickerContext = null;
    dialog.close(); rows = []; list.replaceChildren(); pendingResult = null; needsRefresh = false;
    if (locked) { locked = false; end(); }
    focusAfterClose();
    if (copied) onNotice(t('{count} 個のファイルを追加しました．', { count: copied }));
  }
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });

  function checkPath(row) {
    if (row.done || row.choice === 'skip') return '';
    if (row.file.size > MAX_FILE) return t('追加するファイルは 1 個あたり 128 MiB 以内にしてください．');
    if (row.issue) return row.issue;
    if (row.choice === 'add' || row.choice === 'replace') {
      try { checkDestination(row.path); }
      catch (err) { return err?.message || String(err); }
    }
    return '';
  }
  function updateRow(row) {
    if (!row.editing && row.pathInput.value !== row.path) row.pathInput.value = row.path;
    const options = [];
    if (row.target?.exists) {
      options.push(['', '操作を選んでください']);
      if (row.target.replaceable) options.push(['replace', '同名のファイルを置き換える']);
      if (row.target.alternative) options.push(['copy', '別の名前で追加']);
    } else options.push(['add', 'この名前で追加']);
    options.push(['skip', 'このファイルをスキップ']);
    row.choiceInput.replaceChildren(...options.map(([value, label]) => element('option', { value }, t(label))));
    row.choiceInput.value = row.choice;
    const issue = checkPath(row);
    row.message.classList.toggle('form-error', !!issue);
    row.message.textContent = row.done ? t('追加しました') : row.checking ? t('保存先を確認しています…') : row.copying ? t('コピーしています…') : issue || (row.choice === 'skip' ? t('このファイルをスキップ') : row.target?.exists ? row.target.directory ? t('同じ名前のフォルダーがあります．') : t('同じ名前のファイルがあります ({size})．', { size: fileSize(row.target.size) }) : t('新しいファイルとして追加します．'));
    row.pathInput.disabled = uploading || row.done;
    row.choiceInput.disabled = uploading || row.done || row.checking;
    row.node.classList.toggle('file-import-complete', row.done);
  }
  function updateControls() {
    for (const row of rows) updateRow(row);
    const active = rows.filter(row => !row.done && row.choice !== 'skip');
    const names = new Set(); let duplicates = false;
    for (const row of active) { if (names.has(row.path)) duplicates = true; names.add(row.path); }
    const ready = active.length > 0 && !duplicates && active.every(row => !row.checking && !row.editing && !checkPath(row) && ['add', 'replace'].includes(row.choice));
    confirm.disabled = uploading || (!pendingResult && !needsRefresh && !ready);
    confirm.textContent = pendingResult || needsRefresh ? t('一覧を更新') : t('ファイルを追加');
    cancel.textContent = uploading ? t('停止') : completeCount() ? t('閉じる') : t('キャンセル');
    close.disabled = choose.disabled = folder.input.disabled = refresh.disabled = uploading;
    if (completeCount()) choose.disabled = folder.input.disabled = true;
    if (uploading || rows.some(row => row.checking)) dialog.setAttribute('aria-busy', 'true'); else dialog.removeAttribute('aria-busy');
    status.textContent = duplicates ? t('同じ保存先が複数あります．名前を変更するか，スキップを選んでください．') : stopped ? t('処理を停止しました．追加済み: {done} / {total} 個', { done: completeCount(), total: rows.length }) : t('追加済み: {done} / {total} 個', { done: completeCount(), total: rows.length });
  }
  async function inspectRow(row, currentGeneration = generation) {
    row.sequence++; const sequence = row.sequence;
    row.checking = true; row.target = null; row.issue = ''; row.choice = ''; updateControls();
    try {
      if (!row.path.trim()) throw new Error(t('保存先のパスを入力してください．'));
      if (row.file.size > MAX_FILE) throw new Error(t('追加するファイルは 1 個あたり 128 MiB 以内にしてください．'));
      const target = await api(`/api/files/import?path=${encodeURIComponent(row.path)}`, { projectRoot, timeout: 60000, signal: previewController?.signal });
      if (generation !== currentGeneration || row.sequence !== sequence) return;
      row.target = target; row.path = target.path; row.choice = target.exists ? '' : 'add';
    } catch (err) {
      if (generation !== currentGeneration || row.sequence !== sequence) return;
      row.issue = err?.message || String(err);
    } finally {
      if (generation === currentGeneration && row.sequence === sequence) { row.checking = false; updateControls(); }
    }
  }
  function createRow(file, index) {
    const node = element('li', { class: 'file-import-row', 'data-file-index': index });
    const name = element('p', { class: 'file-import-name' }, `${file.name} · ${fileSize(file.size)}`);
    const path = labelledInput(`file-import-path-${index}`, '保存先のパス');
    const action = labelledInput(`file-import-action-${index}`, '同名の場合の操作', 'select');
    const message = element('p', { class: 'field-help file-import-message' });
    const row = { file, path: folder.input.value ? `${folder.input.value}/${file.name}` : file.name, node, pathInput: path.input, choiceInput: action.input, message, choice: '', issue: '', target: null, checking: true, copying: false, done: false, editing: false, sequence: 0 };
    node.append(name, path.group, action.group, message);
    path.input.addEventListener('input', () => { row.editing = true; row.sequence++; updateControls(); });
    const commitPath = () => {
      if (!row.editing && row.path === path.input.value.trim()) return;
      row.editing = false; row.path = path.input.value.trim(); void inspectRow(row);
    };
    path.input.addEventListener('change', commitPath); path.input.addEventListener('blur', commitPath);
    path.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); path.input.blur(); } });
    action.input.addEventListener('change', () => {
      row.choice = action.input.value;
      if (row.choice === 'copy' && row.target?.alternative) { row.path = row.target.alternative; void inspectRow(row); }
      else updateControls();
    });
    return row;
  }
  function fillFolders(selected) {
    folder.input.replaceChildren(element('option', { value: '' }, t('プロジェクトの直下')));
    for (const path of getProject()?.directories || []) folder.input.append(element('option', { value: path }, path));
    if (selected && ![...folder.input.options].some(option => option.value === selected)) folder.input.append(element('option', { value: selected }, selected));
    folder.input.value = selected;
  }
  async function loadFiles(files, context) {
    if (!files.length) return;
    if (files.length > 100) { onError(new Error(t('ファイルは 100 個以内で選んでください．'))); return; }
    if (getProject()?.root !== context.root) { onError(new Error(t('プロジェクトが切り替わりました．追加先を選び直してください．'))); return; }
    opening = true;
    try {
      if (!locked) { locked = true; await begin(); }
      projectRoot = context.root; returnFocus = context.focus; focusPath = context.folder;
      generation++; previewController?.abort(); previewController = new AbortController();
      stopped = false; pendingResult = null; needsRefresh = false; attemptedPaths = new Set(); fillFolders(context.folder); clearError();
      rows = files.map(createRow); list.replaceChildren(...rows.map(row => row.node));
      translateElements(dialog); if (!dialog.open) dialog.showModal(); cancel.focus();
      const currentGeneration = generation;
      for (const row of rows) { if (generation !== currentGeneration) break; if (!row.editing && row.choice !== 'skip') await inspectRow(row, currentGeneration); }
    } catch (err) {
      if (locked) { locked = false; end(); }
      onError(err);
    } finally { opening = false; }
  }
  picker.addEventListener('change', () => {
    const context = pickerContext; pickerContext = null;
    if (!context) return;
    const files = [...picker.files]; picker.value = '';
    void loadFiles(files, context);
  });
  picker.addEventListener('cancel', () => { const context = pickerContext; pickerContext = null; if (dialog.open) choose.focus(); else if (context?.focus?.isConnected) context.focus.focus(); });
  function open(selectedFolder = '') {
    if (isBlocked() || locked || opening || pickerContext || !getProject()?.root) return;
    pickerContext = { root: getProject().root, folder: selectedFolder, focus: document.activeElement };
    document.body.append(picker); picker.value = ''; picker.click();
  }
  choose.addEventListener('click', () => {
    if (uploading || completeCount()) return;
    pickerContext = { root: projectRoot, folder: folder.input.value, focus: returnFocus };
    body.append(picker); picker.value = ''; picker.click();
  });
  folder.input.addEventListener('change', () => {
    if (uploading || completeCount()) return;
    clearError();
    for (const row of rows) { row.path = folder.input.value ? `${folder.input.value}/${row.file.name}` : row.file.name; void inspectRow(row); }
  });
  refresh.addEventListener('click', () => {
    clearError();
    for (const row of rows) if (!row.done && row.choice !== 'skip') void inspectRow(row);
  });

  confirm.addEventListener('click', async () => {
    if (uploading || confirm.disabled) return;
    clearError(); uploading = true; stopped = false; updateControls();
    let failed = false;
    try {
      if (pendingResult || needsRefresh) { await notifyImported(pendingResult, needsRefresh); pendingResult = null; needsRefresh = false; return; }
      for (const row of rows) {
        if (row.done || row.choice === 'skip') continue;
        if (stopped) break;
        const issue = checkPath(row); if (issue) throw new Error(issue);
        row.copying = true; updateControls(); uploadController = new AbortController(); attemptedPaths.add(row.path);
        try {
          const result = await uploadFile(row.path, row.file, { projectRoot, revision: row.choice === 'replace' ? row.target.revision : '', signal: uploadController.signal });
          row.done = true; pendingResult = result;
        } catch (err) {
          failed = true; needsRefresh = true;
          if (err?.data?.reviewRequired && err.data.target?.path === row.path) {
            row.target = err.data.target; row.choice = row.target.exists ? '' : 'add'; row.issue = '';
          } else if (!stopped) row.issue = err?.message || String(err);
          if (!stopped) showError(`${row.path}\n${err?.message || String(err)}`);
          break;
        } finally { row.copying = false; uploadController = null; updateControls(); }
      }
      if (stopped || needsRefresh) {
        await notifyImported(pendingResult, true); pendingResult = null; needsRefresh = false;
        if (stopped) for (const row of rows) if (!row.done && row.choice !== 'skip') await inspectRow(row);
      } else if (pendingResult) { await notifyImported(pendingResult); pendingResult = null; }
    } catch (err) { failed = true; showError(err); }
    finally {
      uploading = false; updateControls();
      if (!failed && !stopped && rows.every(row => row.done || row.choice === 'skip')) closeDialog();
      else cancel.focus();
    }
  });
  onLanguageChange(() => {
    if (!dialog.open) return;
    translateElements(dialog); fillFolders(folder.input.value); updateControls();
  });
  return { open, close: closeDialog, get busy() { return opening || uploading; }, destroy() { previewController?.abort(); uploadController?.abort(); dialog.remove(); picker.remove(); if (locked) { locked = false; end(); } } };
}
