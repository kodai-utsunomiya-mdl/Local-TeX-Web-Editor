import { t, getLanguage, onLanguageChange, translateElements } from './i18n.js';
import { element, translated } from './import-dialog.js';

const projectName = path => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);
const uniquePaths = paths => [...new Set(paths.filter(path => typeof path === 'string' && path))];

export function createProjectHome({ list, api, getMeta, getUnsavedPaths = () => [], beginAction = async () => {}, endAction = () => {},
  onOpen, onResume, onDeleted = () => {}, onError = () => {}, onNotice = () => {}, isBlocked = () => false }) {
  list.classList.add('project-home-list');
  let starting = false, active = null, submitting = false, ending = false, renderedSignature = '';

  const dialog = element('dialog', { id: 'project-delete-dialog', class: 'dialog project-delete-dialog', 'aria-labelledby': 'project-delete-title', 'aria-describedby': 'project-delete-description' });
  const heading = element('div', { class: 'dialog-heading' });
  const close = element('button', { type: 'button', class: 'icon-button', 'aria-label': t('閉じる'), 'data-i18n-aria-label': '閉じる' }, '×');
  heading.append(translated('h2', 'プロジェクトを削除', { id: 'project-delete-title' }), close);
  const body = element('div', { class: 'project-delete-body' });
  const description = translated('p', 'この操作は PC 上のプロジェクトフォルダーを中身ごと削除します．削除したファイルと草稿は元に戻せません．', { id: 'project-delete-description', class: 'project-delete-description' });
  const target = element('div', { class: 'project-delete-target' });
  const targetName = element('strong');
  const targetPath = element('code', { id: 'project-delete-path', dir: 'auto' }); target.append(targetName, targetPath);
  const count = element('p', { id: 'project-delete-count', class: 'project-delete-count' });
  const inventory = element('ul', { id: 'project-delete-entries', class: 'project-delete-entries', 'aria-label': t('削除する全項目'), 'data-i18n-aria-label': '削除する全項目', tabindex: '0' });
  const empty = translated('p', 'このフォルダーは空です．', { class: 'field-help', hidden: '' });
  const unsaved = element('section', { id: 'project-delete-unsaved', class: 'project-delete-notes', hidden: '' });
  const drafts = element('section', { id: 'project-delete-drafts', class: 'project-delete-notes', hidden: '' });
  const scope = element('label', { class: 'project-delete-acknowledge' });
  const acknowledge = element('input', { id: 'project-delete-acknowledge', type: 'checkbox' });
  scope.append(acknowledge, translated('span', 'このフォルダー内の全てのファイルとフォルダーを削除する'));
  const nameLabel = translated('label', '確認のため，プロジェクト名を入力', { for: 'project-delete-name', class: 'field-label' });
  const name = element('input', { id: 'project-delete-name', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', dir: 'auto', 'aria-describedby': 'project-delete-name-help' });
  const nameHelp = element('p', { id: 'project-delete-name-help', class: 'field-help' });
  const nameField = element('div', { class: 'project-delete-name-field' }); nameField.append(nameLabel, name, nameHelp);
  const message = element('p', { id: 'project-delete-message', class: 'project-delete-message', role: 'status', hidden: '' });
  const error = element('p', { id: 'project-delete-error', class: 'form-error', role: 'alert', hidden: '' });
  const footer = element('div', { class: 'dialog-actions' });
  const cancel = translated('button', 'キャンセル', { type: 'button', class: 'button', id: 'project-delete-cancel', autofocus: '' });
  const confirm = translated('button', 'プロジェクトを削除', { type: 'button', class: 'button project-delete-confirm', id: 'project-delete-confirm', disabled: '' });
  body.append(description, target, count, inventory, empty, unsaved, drafts, message, scope, nameField);
  footer.append(cancel, confirm); dialog.append(heading, body, error, footer); list.ownerDocument.body.append(dialog);

  function refresh() {
    const meta = getMeta() || {};
    const current = meta.project?.root || '';
    const paths = uniquePaths([current, ...(meta.recentProjects || []).map(value => typeof value === 'string' ? value : value?.root || value?.path || '')]).slice(0, 12);
    const blocked = Boolean(isBlocked() || starting || active || ending);
    const running = meta.build?.status === 'running';
    const signature = JSON.stringify([current, paths, blocked, running, getLanguage()]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const focused = list.contains(list.ownerDocument.activeElement) ? list.ownerDocument.activeElement : null;
    const focusedPath = focused?.closest('[data-project-path]')?.dataset.projectPath;
    const focusedAction = focused?.dataset.action;
    const fragment = list.ownerDocument.createDocumentFragment();
    for (const path of paths) {
      const isCurrent = path === current;
      const card = element('article', { class: `project-home-card${isCurrent ? ' current' : ''}`, 'data-project-path': path });
      const information = element('div', { class: 'project-home-information' });
      const title = element('div', { class: 'project-home-title' }); title.append(element('h3', {}, projectName(path)));
      if (isCurrent) title.append(translated('span', '編集中のプロジェクト', { class: 'project-home-current' }));
      information.append(title, element('p', { class: 'project-home-path', dir: 'auto' }, path));
      const actions = element('div', { class: 'project-home-actions' });
      const open = translated('button', isCurrent ? '編集に戻る' : '開く', { type: 'button', class: `button button-small${isCurrent ? ' button-primary' : ''}`, 'data-action': isCurrent ? 'resume' : 'open' });
      const remove = translated('button', '削除…', { type: 'button', class: 'button button-small project-home-delete', 'data-action': 'delete', 'aria-haspopup': 'dialog', 'aria-controls': dialog.id });
      open.disabled = blocked || (!isCurrent && running); remove.disabled = blocked || running;
      if (running && !isCurrent) open.title = t('コンパイルが終わるとプロジェクトを開けます．');
      if (running) remove.title = t('コンパイルが終わるとプロジェクトを削除できます．');
      open.addEventListener('click', () => {
        if (isBlocked() || active || starting || ending || (!isCurrent && getMeta()?.build?.status === 'running')) return;
        Promise.resolve().then(() => isCurrent ? onResume?.() : onOpen?.(path)).catch(onError);
      });
      remove.addEventListener('click', () => { void inspect(path); });
      actions.append(open, remove); card.append(information, actions); fragment.append(card);
    }
    list.replaceChildren(fragment);
    const section = list.closest('#welcome-recent'); if (section) section.hidden = !paths.length;
    if (focusedPath && focusedAction) {
      const card = [...list.querySelectorAll('[data-project-path]')].find(node => node.dataset.projectPath === focusedPath);
      const control = [...(card?.querySelectorAll('[data-action]') || [])].find(node => node.dataset.action === focusedAction);
      if (control && !control.disabled) control.focus({ preventScroll: true });
    }
  }

  function renderPaths(section, title, paths) {
    paths = uniquePaths(paths || []);
    section.hidden = !paths.length; section.replaceChildren();
    if (!paths.length) return;
    section.append(element('h3', {}, t(title, { count: paths.length })));
    const items = element('ul');
    for (const path of paths) items.append(element('li', { dir: 'auto' }, path));
    section.append(items);
  }
  function renderInspection(inspection, reset = true) {
    if (!inspection || typeof inspection.path !== 'string' || typeof inspection.name !== 'string' || !inspection.name || typeof inspection.revision !== 'string' || !Array.isArray(inspection.entries)) throw new Error(t('プロジェクトの内容を取得できませんでした．もう一度開いてください．'));
    active.inspection = inspection;
    targetName.textContent = inspection.name; targetPath.textContent = inspection.path;
    count.textContent = t('ファイル {files} 件・フォルダー {directories} 件', { files: inspection.fileCount, directories: inspection.directoryCount });
    const entries = list.ownerDocument.createDocumentFragment();
    for (const entry of inspection.entries) {
      const row = element('li', { class: entry.directory ? 'directory' : 'file' });
      const type = element('span', { class: 'project-delete-entry-type' }, t(entry.directory ? 'フォルダー' : 'ファイル'));
      row.append(type, element('code', { dir: 'auto' }, entry.path)); entries.append(row);
    }
    inventory.replaceChildren(entries); inventory.hidden = !inspection.entries.length; empty.hidden = Boolean(inspection.entries.length);
    renderPaths(unsaved, '未保存の原稿 ({count} 件)', getUnsavedPaths(inspection.path));
    renderPaths(drafts, 'PC に記録された草稿 ({count} 件)', inspection.draftPaths);
    nameHelp.textContent = t('「{name}」を正確に入力してください．', { name: inspection.name });
    if (reset) { acknowledge.checked = false; name.value = ''; }
    updateConfirm();
  }
  function updateConfirm() {
    confirm.disabled = submitting || !active?.inspection || !acknowledge.checked || name.value !== active.inspection.name;
  }
  function setSubmitting(value) {
    submitting = value; dialog.toggleAttribute('aria-busy', value);
    if (value) dialog.setAttribute('aria-busy', 'true');
    for (const control of [cancel, close, acknowledge, name]) control.disabled = value;
    updateConfirm();
  }
  async function inspect(path) {
    if (isBlocked() || starting || active || ending || getMeta()?.build?.status === 'running') return;
    starting = true; refresh();
    try {
      const result = await beginAction();
      if (result === false) return;
      active = { path, inspection: null };
      const inspection = await api(`/api/project/delete?path=${encodeURIComponent(path)}`, { projectRoot: null, timeout: 120000 });
      renderInspection(inspection); error.hidden = true; error.textContent = ''; message.hidden = true; message.textContent = '';
      setSubmitting(false); translateElements(dialog); dialog.showModal(); cancel.focus({ preventScroll: true });
    } catch (failure) {
      onError(failure);
      if (active) await finish();
    } finally { starting = false; refresh(); }
  }
  function closeDialog() { if (!submitting && dialog.open) dialog.close('cancel'); }
  async function finish() {
    if (!active || ending) return;
    const path = active.path; active = null; ending = true;
    try { await endAction(); }
    catch (failure) { onError(failure); }
    finally {
      ending = false; refresh();
      const card = [...list.querySelectorAll('[data-project-path]')].find(node => node.dataset.projectPath === path);
      const control = card?.querySelector('[data-action="delete"]') || list.querySelector('button:not(:disabled)') || list.ownerDocument.getElementById('welcome-open');
      if (control && !control.disabled) control.focus({ preventScroll: true });
    }
  }
  async function deleteProject() {
    if (confirm.disabled || !active?.inspection || submitting) return;
    const inspection = active.inspection; setSubmitting(true); error.hidden = true; message.hidden = true;
    let focusCancel = false;
    try {
      const result = await api(`/api/project/delete?path=${encodeURIComponent(inspection.path)}`, {
        method: 'DELETE', projectRoot: null, timeout: 120000,
        body: { path: inspection.path, revision: inspection.revision, confirmation: name.value },
      });
      try { await onDeleted(result); }
      finally {
        dialog.close('deleted');
        onNotice([t('プロジェクト「{name}」を削除しました．', { name: inspection.name }), result.warning].filter(Boolean).join(' '));
      }
    } catch (failure) {
      if (!dialog.open) onError(failure);
      else if (failure.status === 409) {
        acknowledge.checked = false; name.value = ''; active.inspection = null;
        try {
          const latest = failure.data?.project || failure.data?.inspection || await api(`/api/project/delete?path=${encodeURIComponent(inspection.path)}`, { projectRoot: null, timeout: 120000 });
          renderInspection(latest);
          message.textContent = t('確認後に内容が変わりました．最新の一覧を確認し，チェックとプロジェクト名をもう一度入力してください．'); message.hidden = false;
          focusCancel = true;
        } catch (refreshFailure) { error.textContent = String(refreshFailure.message || refreshFailure); error.hidden = false; }
      } else { error.textContent = String(failure.message || failure); error.hidden = false; }
    } finally { setSubmitting(false); if (focusCancel) cancel.focus({ preventScroll: true }); }
  }
  acknowledge.addEventListener('change', updateConfirm); name.addEventListener('input', updateConfirm);
  name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  confirm.addEventListener('click', () => { void deleteProject(); });
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener('close', () => { void finish(); });
  const stopLanguage = onLanguageChange(() => {
    refresh(); translateElements(dialog);
    if (active?.inspection) renderInspection(active.inspection, false);
  });
  refresh();
  return { refresh, destroy() { stopLanguage(); if (dialog.open) dialog.close(); dialog.remove(); list.replaceChildren(); } };
}
