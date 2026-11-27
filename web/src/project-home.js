import { t, getLanguage, onLanguageChange, translateElements } from './i18n.js';
import { element, translated } from './import-dialog.js';
import { projectStatusFor, recentProjectEntries } from './project-status.js';

const projectName = path => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(path);
const uniquePaths = paths => [...new Set(paths.filter(path => typeof path === 'string' && path))];

export function createProjectHome({ list, api, getMeta, getUnsavedPaths = () => [], beginAction = async () => {}, endAction = () => {},
  onOpen, onResume, onExport = async () => {}, canExport = () => true, onDeleted = () => {}, refreshStatus = async () => {}, onRecentChanged = () => {},
  onError = () => {}, onNotice = () => {}, isBlocked = () => false }) {
  list.classList.add('project-home-list');
  let starting = false, active = null, submitting = false, ending = false, checking = false, removing = false, exporting = false, destroyed = false, renderedSignature = '', zipPath = '';
  const statusText = entry => entry.message || t('プロジェクトの場所を確認できません．フォルダーを選び直してください．');
  const statusLabels = {
    missing: 'フォルダーが見つかりません', 'not-directory': 'この場所はフォルダーではありません',
    unavailable: 'フォルダーを読み取れません', changed: 'フォルダーの場所が変わりました',
  };

  const zipMenu = element('div', { id: 'project-home-zip-menu', class: 'project-zip-menu project-home-zip-menu', role: 'menu', 'aria-describedby': 'project-home-zip-help', hidden: '' });
  const zipHeading = element('p', { class: 'project-home-zip-heading', dir: 'auto' });
  const zipHelp = element('p', { id: 'project-home-zip-help', class: 'project-home-zip-help' });
  const download = translated('button', 'プロジェクトを ZIP でダウンロード', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-action': 'download' });
  const saveAs = translated('button', 'ZIP にして名前を付けて保存…', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-action': 'save-as' });
  zipMenu.append(zipHeading, zipHelp, download, saveAs);
  list.ownerDocument.body.append(zipMenu);

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
    if (destroyed) return;
    const meta = getMeta() || {};
    const current = meta.project?.root || '';
    const entries = recentProjectEntries(meta);
    const blocked = Boolean(isBlocked() || starting || active || ending || checking || removing || exporting);
    const running = meta.build?.status === 'running';
    if (active?.inspection && projectStatusFor(meta, active.path).status !== 'available') {
      active.inspection = null; acknowledge.checked = false; name.value = '';
      error.textContent = statusText(projectStatusFor(meta, active.path)); error.hidden = false; updateConfirm();
    }
    const signature = JSON.stringify([current, entries, entries.map(entry => canExport(entry.path)), blocked, running, getLanguage()]);
    if (signature === renderedSignature) return;
    renderedSignature = signature;
    const focused = list.contains(list.ownerDocument.activeElement) ? list.ownerDocument.activeElement : null;
    const focusedPath = focused?.closest('[data-project-path]')?.dataset.projectPath;
    const focusedAction = focused?.dataset.action;
    const fragment = list.ownerDocument.createDocumentFragment();
    for (const entry of entries) {
      const { path, current: isCurrent } = entry, available = entry.status === 'available';
      const card = element('article', { class: `project-home-card${isCurrent ? ' current' : ''}${available ? '' : ' unavailable'}`, 'data-project-path': path, 'data-project-status': entry.status });
      const information = element('div', { class: 'project-home-information' });
      const title = element('div', { class: 'project-home-title' }); title.append(element('h3', {}, projectName(path)));
      if (isCurrent) title.append(translated('span', '編集中のプロジェクト', { class: 'project-home-current' }));
      information.append(title, element('p', { class: 'project-home-path', dir: 'auto' }, path));
      if (!available) {
        information.append(translated('p', statusLabels[entry.status] || statusLabels.unavailable, { class: 'project-home-status' }), element('p', { class: 'project-home-status-help' }, statusText(entry)));
      }
      const actions = element('div', { class: 'project-home-actions' });
      const open = translated('button', isCurrent ? '編集に戻る' : '開く', { type: 'button', class: `button button-small${isCurrent ? ' button-primary' : ''}`, 'data-action': isCurrent ? 'resume' : 'open' });
      const zip = element('button', { id: `project-home-zip-${fragment.childElementCount}`, type: 'button', class: 'button button-small project-home-zip', 'data-action': 'zip',
        'aria-label': t('「{name}」の ZIP を保存', { name: projectName(path) }), 'aria-haspopup': 'menu', 'aria-controls': zipMenu.id, 'aria-expanded': 'false' }, 'ZIP');
      const remove = translated('button', '削除…', { type: 'button', class: 'button button-small project-home-delete', 'data-action': 'delete', 'aria-haspopup': 'dialog', 'aria-controls': dialog.id });
      open.disabled = blocked || (!isCurrent && (running || !available)); remove.disabled = blocked || running || !available;
      zip.disabled = blocked || running || !available || !canExport(path);
      if (running && !isCurrent) open.title = t('コンパイルが終わるとプロジェクトを開けます．');
      if (running) remove.title = t('コンパイルが終わるとプロジェクトを削除できます．');
      if (running) zip.title = t('コンパイルが終わるとプロジェクトの ZIP を保存できます．');
      if (!available && !isCurrent) open.title = statusText(entry);
      if (!available) remove.title = zip.title = statusText(entry);
      open.addEventListener('click', () => { void openPath(path); });
      zip.addEventListener('click', () => zipPath === path ? closeZIPMenu(true) : openZIPMenu(path));
      zip.addEventListener('keydown', event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openZIPMenu(path, event.key === 'ArrowUp'); }
      });
      remove.addEventListener('click', () => { void inspect(path); });
      actions.append(open, zip, remove);
      if (!available) {
        const retry = translated('button', '再確認', { type: 'button', class: 'button button-small', 'data-action': 'refresh' });
        retry.disabled = blocked;
        retry.addEventListener('click', () => { void recheck(path); }); actions.append(retry);
      }
      if (!isCurrent) {
        const forget = translated('button', '一覧から外す', { type: 'button', class: 'button button-small', 'data-action': 'forget', title: t('最近の一覧から外します．PC 上のファイルと草稿は残ります．') });
        forget.disabled = blocked;
        forget.addEventListener('click', () => { void forgetRecent(path); }); actions.append(forget);
      }
      card.append(information, actions); fragment.append(card);
    }
    list.replaceChildren(fragment);
    const section = list.closest('#welcome-recent'); if (section) section.hidden = !entries.length;
    if (zipPath) {
      if (blocked || running || !zipButton(zipPath) || zipButton(zipPath).disabled) closeZIPMenu(zipMenu.contains(list.ownerDocument.activeElement));
      else positionZIPMenu();
    }
    if (focusedPath && focusedAction) {
      const card = [...list.querySelectorAll('[data-project-path]')].find(node => node.dataset.projectPath === focusedPath);
      const control = [...(card?.querySelectorAll('[data-action]') || [])].find(node => node.dataset.action === focusedAction);
      if (control && !control.disabled) control.focus({ preventScroll: true });
    }
  }

  function busy() { return destroyed || isBlocked() || starting || active || ending || checking || removing || exporting; }
  function zipButton(path) {
    const card = [...list.querySelectorAll('[data-project-path]')].find(node => node.dataset.projectPath === path);
    return card?.querySelector('[data-action="zip"]');
  }
  function closeZIPMenu(focus = false) {
    const path = zipPath;
    zipButton(path)?.setAttribute('aria-expanded', 'false');
    zipMenu.hidden = true; zipPath = '';
    if (focus && path) focusCard(path, 'zip');
  }
  function positionZIPMenu() {
    const button = zipButton(zipPath);
    if (!button) { closeZIPMenu(); return; }
    button.setAttribute('aria-expanded', 'true'); zipMenu.setAttribute('aria-labelledby', button.id);
    const anchor = button.getBoundingClientRect(), bounds = zipMenu.getBoundingClientRect();
    zipMenu.style.left = `${Math.max(6, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 6))}px`;
    zipMenu.style.top = `${Math.max(6, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 6))}px`;
  }
  function openZIPMenu(path, last = false) {
    if (busy() || getMeta()?.build?.status === 'running' || list.ownerDocument.querySelector('dialog[open]')) return;
    const entry = recentProjectEntries(getMeta()).find(value => value.path === path);
    if (!entry || entry.status !== 'available' || !canExport(path)) return;
    closeZIPMenu(); zipPath = path;
    zipHeading.textContent = projectName(path);
    zipHelp.textContent = t(entry.current ? '未保存の変更を保存して，ZIP にまとめます．' : 'このプロジェクトの保存済みファイルを ZIP にまとめます．');
    zipMenu.hidden = false; positionZIPMenu();
    (last ? saveAs : download).focus({ preventScroll: true });
  }
  async function exportPath(saveAs) {
    const path = zipPath; closeZIPMenu(true);
    if (!path || busy() || getMeta()?.build?.status === 'running' || !canExport(path)) return;
    exporting = true; refresh();
    try {
      await reloadStatus();
      const entry = recentProjectEntries(getMeta()).find(value => value.path === path);
      if (!entry || entry.status !== 'available') { onNotice(statusText(entry || {})); return; }
      await onExport(path, saveAs);
    } catch (failure) {
      onError(failure);
      try { await reloadStatus(); } catch (refreshFailure) { onError(refreshFailure); }
    } finally {
      exporting = false; refresh();
      if (!list.ownerDocument.querySelector('dialog[open]')) focusCard(path, 'zip');
    }
  }
  download.addEventListener('click', () => { void exportPath(false); });
  saveAs.addEventListener('click', () => { void exportPath(true); });
  zipMenu.addEventListener('keydown', event => {
    const items = [download, saveAs], index = items.indexOf(list.ownerDocument.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    } else if (event.key === 'Escape') { event.preventDefault(); closeZIPMenu(true); }
    else if (event.key === 'Tab') closeZIPMenu(true);
  });
  const outsideZIPMenu = event => { if (zipPath && !zipMenu.contains(event.target) && !zipButton(zipPath)?.contains(event.target)) closeZIPMenu(); };
  const movedZIPMenu = event => { if (zipPath && (event.type === 'resize' || !zipMenu.contains(event.target))) closeZIPMenu(zipMenu.contains(list.ownerDocument.activeElement)); };
  list.ownerDocument.addEventListener('pointerdown', outsideZIPMenu);
  window.addEventListener('resize', movedZIPMenu);
  window.addEventListener('scroll', movedZIPMenu, true);
  async function reloadStatus() {
    await refreshStatus();
    refresh();
  }
  function focusCard(path, action) {
    if (destroyed) return;
    const card = [...list.querySelectorAll('[data-project-path]')].find(node => node.dataset.projectPath === path);
    const requested = card?.querySelector(`[data-action="${action}"]`);
    const control = requested && !requested.disabled ? requested : card?.querySelector('button:not(:disabled)') || list.querySelector('button:not(:disabled)') || list.ownerDocument.getElementById('welcome-open');
    control?.focus({ preventScroll: true });
  }
  async function openPath(path) {
    if (busy()) return;
    const entry = recentProjectEntries(getMeta()).find(value => value.path === path);
    if (!entry || !entry.current && getMeta()?.build?.status === 'running') return;
    if (entry.current) {
      try { await onResume?.(); } catch (failure) { onError(failure); }
      return;
    }
    starting = true; refresh();
    try {
      await reloadStatus();
      const status = projectStatusFor(getMeta(), path);
      if (status.status !== 'available') { onNotice(statusText(status)); return; }
      await onOpen?.(path);
    } catch (failure) {
      onError(failure);
      try { await reloadStatus(); } catch (refreshFailure) { onError(refreshFailure); }
    } finally { starting = false; refresh(); }
  }
  async function recheck(path) {
    if (busy()) return;
    checking = true; refresh();
    try { await reloadStatus(); }
    catch (failure) { onError(failure); }
    finally { checking = false; refresh(); focusCard(path, 'refresh'); }
  }
  async function forgetRecent(path) {
    if (busy() || path === getMeta()?.project?.root) return;
    removing = true; refresh();
    try {
      const result = await api('/api/project/recent', { method: 'DELETE', projectRoot: null, body: { path } });
      await onRecentChanged(result.state);
      onNotice(t('最近のプロジェクトの一覧から外しました．ファイルと草稿はそのままです．'));
    } catch (failure) {
      onError(failure);
      try { await reloadStatus(); } catch (refreshFailure) { onError(refreshFailure); }
    } finally { removing = false; refresh(); focusCard(path, 'forget'); }
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
    if (busy() || getMeta()?.build?.status === 'running') return;
    starting = true; refresh();
    try {
      await reloadStatus();
      const status = projectStatusFor(getMeta(), path);
      if (status.status !== 'available') { onNotice(statusText(status)); return; }
      const result = await beginAction();
      if (result === false) return;
      active = { path, inspection: null };
      const inspection = await api(`/api/project/delete?path=${encodeURIComponent(path)}`, { projectRoot: null, timeout: 120000 });
      renderInspection(inspection); error.hidden = true; error.textContent = ''; message.hidden = true; message.textContent = '';
      setSubmitting(false); translateElements(dialog); dialog.showModal(); cancel.focus({ preventScroll: true });
    } catch (failure) {
      onError(failure);
      if (active) await finish();
      try { await reloadStatus(); } catch (refreshFailure) { onError(refreshFailure); }
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
      focusCard(path, 'delete');
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
      } else {
        if ([400, 403, 404].includes(failure.status)) { active.inspection = null; acknowledge.checked = false; name.value = ''; }
        error.textContent = String(failure.message || failure); error.hidden = false;
      }
      try { await reloadStatus(); } catch (refreshFailure) { onError(refreshFailure); }
    } finally { setSubmitting(false); if (focusCancel) cancel.focus({ preventScroll: true }); }
  }
  acknowledge.addEventListener('change', updateConfirm); name.addEventListener('input', updateConfirm);
  name.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
  close.addEventListener('click', closeDialog); cancel.addEventListener('click', closeDialog);
  confirm.addEventListener('click', () => { void deleteProject(); });
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener('close', () => { void finish(); });
  const stopLanguage = onLanguageChange(() => {
    closeZIPMenu(); refresh(); translateElements(dialog); translateElements(zipMenu);
    if (active?.inspection) renderInspection(active.inspection, false);
  });
  refresh();
  return { refresh, destroy() {
    destroyed = true; stopLanguage(); closeZIPMenu();
    list.ownerDocument.removeEventListener('pointerdown', outsideZIPMenu);
    window.removeEventListener('resize', movedZIPMenu); window.removeEventListener('scroll', movedZIPMenu, true);
    if (dialog.open) dialog.close(); dialog.remove(); zipMenu.remove(); list.replaceChildren();
  } };
}
