import { t, onLanguageChange } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';

export const projectZIPLimit = 512 * 1024 * 1024;

export function suggestProjectZIPName(filename) {
  const name = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.zip$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[ .]+$/g, '').trim();
  return !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'project' : name;
}

export function projectParentFolder(root) {
  if (!root) return '';
  const clean = root.replace(/[\\/]+$/, '');
  const parent = clean.replace(/[\\/][^\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  if (root.startsWith('/') && !parent) return '/';
  return parent === clean ? '' : parent;
}

export function projectZIPDestination(parent, name) {
  if (!parent.trim() || !name.trim()) return '';
  const windows = /^[A-Za-z]:/.test(parent) || parent.startsWith('\\\\');
  return `${parent.trim().replace(/[\\/]+$/, '')}${windows ? '\\' : '/'}${name.trim()}`;
}

export function validateProjectZIP({ archive, parent, name }) {
  if (!archive) return '読み込む ZIP ファイルを選んでください．';
  if (!/\.zip$/i.test(archive.name || '')) return '拡張子が .zip のファイルを選んでください．';
  if (!archive.size) return '選択した ZIP ファイルは空です．';
  if (archive.size > projectZIPLimit) return 'ZIP ファイルは 512 MiB 以下にしてください．';
  if (!parent.trim()) return '保存先の親フォルダーを選んでください．';
  const folder = name.trim();
  if (!folder || /[ .]$/.test(folder) || /[<>:"/\\|?*\u0000-\u001f]/.test(folder) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder) ||
      ['.git', '.local-tex-editor', 'node_modules', '.venv', 'venv', '__pycache__'].includes(folder.toLowerCase())) return '新しいプロジェクトのフォルダー名を入力してください．';
  return '';
}

export function projectZIPFilename(project) {
  return `${suggestProjectZIPName(project.name || String(project.root || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1))}.zip`;
}

export async function exportProjectZIP({ project, saveAs = false, saveAll, flush, api, saveBlob }) {
  await saveAll();
  await flush();
  const options = { method: 'POST', body: {}, projectRoot: project.root, timeout: 0 };
  if (saveAs) return api('/api/project/save-as', options);
  const blob = await api('/api/project/download', { ...options, responseType: 'blob' });
  await saveBlob(blob, projectZIPFilename(project));
  return { downloaded: true };
}

export function createProjectZIP({ button, homeButton, api, getProject, isBlocked, canExport, onImport, onOpen, onExport, onError }) {
  const ui = createImportDialog('project-zip-dialog', 'ZIP からプロジェクトを作成');
  ui.dialog.classList.add('project-zip-dialog');
  const intro = translated('p', 'Overleaf などからダウンロードした ZIP を，新しいプロジェクトとして開きます．', { class: 'field-help project-zip-intro' });
  const archive = labelledInput('project-zip-archive', 'ZIP ファイル', 'input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed' });
  const parent = labelledInput('project-zip-parent', '保存先の親フォルダー', 'input', { autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'project-zip-parent-help' });
  const folderRow = element('div', { class: 'project-zip-folder-row' });
  const browse = translated('button', 'フォルダーを選ぶ', { id: 'project-zip-browse', type: 'button', class: 'button' });
  folderRow.append(parent.input, browse); parent.group.append(folderRow);
  parent.group.append(translated('p', 'このフォルダー内に，次の名前のプロジェクトを作成します．', { id: 'project-zip-parent-help', class: 'field-help' }));
  const name = labelledInput('project-zip-name', '新しいプロジェクトの名前', 'input', { autocomplete: 'off', spellcheck: 'false' });
  const destination = element('div', { class: 'project-zip-destination', hidden: '' });
  const destinationPath = element('code', { id: 'project-zip-destination' });
  destination.append(translated('span', '作成先'), destinationPath);
  const detail = translated('p', '原稿，参考文献，画像などのファイルを読み込みます．既存のプロジェクトはそのまま残ります．', { class: 'field-help' });
  const status = element('p', { id: 'project-zip-status', class: 'project-zip-status', role: 'status', hidden: '' });
  const cancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const submit = element('button', { id: 'project-zip-submit', type: 'button', class: 'button button-primary' });
  ui.body.append(intro, archive.group, parent.group, name.group, destination, detail, status);
  ui.footer.append(cancel, submit);
  const menu = element('div', { id: 'project-zip-menu', class: 'project-zip-menu', role: 'menu', 'aria-labelledby': button.id, hidden: '' });
  const importItem = translated('button', 'ZIP を読み込む…', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-action': 'import' });
  const downloadItem = translated('button', 'プロジェクトを ZIP でダウンロード', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-action': 'download' });
  const saveAsItem = translated('button', 'ZIP にして名前を付けて保存…', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-action': 'save-as' });
  menu.append(importItem, element('div', { role: 'separator', class: 'file-menu-separator' }), downloadItem, saveAsItem);
  document.body.append(menu);
  button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
  let picker = null, reading = false, created = null, suggestedName = '', returnFocus = null;

  const input = () => ({ archive: archive.input.files?.[0], parent: parent.input.value.trim(), name: name.input.value.trim() });
  function closeMenu(focus = false) {
    menu.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (focus && !button.disabled) button.focus();
  }
  function refresh() {
    const blocked = isBlocked();
    button.disabled = homeButton.disabled = blocked;
    importItem.disabled = blocked; downloadItem.disabled = saveAsItem.disabled = blocked || !canExport();
    if (blocked) closeMenu();
    for (const field of [archive.input, parent.input, name.input]) field.disabled = reading || !!created;
    browse.disabled = reading || !!created;
    browse.textContent = t(picker ? 'フォルダーの選択を取り消す' : 'フォルダーを選ぶ');
    submit.disabled = reading || !!picker || (!created && !!validateProjectZIP(input()));
    submit.textContent = t(created ? '作成したプロジェクトを開く' : '読み込んで開く');
    destinationPath.textContent = created?.path || projectZIPDestination(parent.input.value, name.input.value);
    destination.hidden = !destinationPath.textContent;
    status.hidden = !reading && !created;
    status.textContent = reading ? t(created ? 'プロジェクトを開いています…' : 'ZIP を読み込み，プロジェクトを開いています…')
      : created ? t('ZIP の読み込みは完了しています．作成したプロジェクトを開けます．') : '';
  }
  function open() {
    if (isBlocked() || document.querySelector('dialog[open]')) return;
    closeMenu(); returnFocus = document.activeElement; created = null; suggestedName = '';
    archive.input.value = ''; name.input.value = '';
    if (!parent.input.value.trim()) parent.input.value = projectParentFolder(getProject()?.root || '');
    refresh(); ui.open(); archive.input.focus();
  }
  function openMenu(last = false) {
    if (isBlocked() || document.querySelector('dialog[open]')) return;
    refresh(); menu.hidden = false; button.setAttribute('aria-expanded', 'true');
    const anchor = button.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 6))}px`;
    const items = [...menu.querySelectorAll('button:not(:disabled)')]; items[last ? items.length - 1 : 0]?.focus();
  }
  function edited() { ui.clearError(); refresh(); }
  archive.input.addEventListener('change', () => {
    const next = archive.input.files?.[0];
    if (next && (!name.input.value.trim() || name.input.value === suggestedName)) name.input.value = suggestedName = suggestProjectZIPName(next.name);
    edited();
    const error = next && validateProjectZIP({ ...input(), parent: 'parent', name: 'project' });
    if (error) ui.showError(t(error));
  });
  parent.input.addEventListener('input', edited);
  name.input.addEventListener('input', () => {
    edited();
    const error = name.input.value.trim() && validateProjectZIP({ archive: { name: 'project.zip', size: 1 }, parent: 'parent', name: name.input.value });
    if (error) ui.showError(t(error));
  });
  browse.addEventListener('click', async () => {
    if (picker) { picker.abort(); return; }
    const controller = picker = new AbortController(); ui.clearError(); refresh();
    try {
      const result = await api('/api/project/pick', { method: 'POST', body: {}, projectRoot: null, timeout: 0, signal: controller.signal });
      if (!controller.signal.aborted && ui.dialog.open && result?.path) parent.input.value = result.path;
    } catch (error) { if (error.name !== 'AbortError' && ui.dialog.open) ui.showError(error); }
    finally { if (picker === controller) picker = null; refresh(); }
  });
  cancel.addEventListener('click', () => ui.close());
  ui.dialog.addEventListener('close', () => {
    picker?.abort();
    const target = returnFocus?.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length ? returnFocus : button;
    if (!target.disabled) target.focus();
  });
  submit.addEventListener('click', async () => {
    if (reading || picker) return;
    const values = input(), error = !created && validateProjectZIP(values);
    if (error) { ui.showError(t(error)); return; }
    reading = true; refresh();
    const opened = await ui.run(async () => {
      try { return created ? await onOpen(created.path) : await onImport(values, result => { created = result; refresh(); }); }
      catch (error) { if (error?.shown) ui.dialog.close(); throw error; }
    });
    reading = false; refresh();
    if (opened) ui.close();
  });
  ui.dialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && [parent.input, name.input].includes(event.target)) { event.preventDefault(); if (!submit.disabled) submit.click(); }
  });
  const exportArchive = async saveAs => {
    closeMenu(true);
    if (isBlocked() || !canExport()) return;
    try { await onExport(saveAs); } catch (error) { onError(error); }
  };
  button.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu(true));
  button.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openMenu(event.key === 'ArrowUp'); }
  });
  homeButton.addEventListener('click', open);
  importItem.addEventListener('click', () => { closeMenu(true); open(); });
  downloadItem.addEventListener('click', () => exportArchive(false)); saveAsItem.addEventListener('click', () => exportArchive(true));
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
    else if (event.key === 'Tab') closeMenu(true);
  });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) closeMenu(); });
  window.addEventListener('resize', () => closeMenu());
  onLanguageChange(() => { closeMenu(); refresh(); });
  refresh();
  return { open, refresh, closeMenu };
}
