import { t, translateElements, onLanguageChange } from './i18n.js';
import { createImportDialog, element, translated, labelledInput } from './import-dialog.js';
import { parseTeXPackageNames } from './tex-packages.js';
import { formatTeXSetupBytes } from './tex-setup.js';
import { teXEnvironment } from './tex-setup-session.js';

export function filterTeXPackages(packages, query = '') {
  const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (packages || []).filter(item => words.every(word => `${item.name}\n${item.description || ''}`.toLowerCase().includes(word)));
}

export function teXRemovalMethod(inspection) {
  if (inspection?.method) return inspection.method;
  const environment = inspection?.environment;
  if (environment?.uninstallInSettings) return 'settings';
  if (!environment || environment.managed) return 'delete';
  return environment.uninstaller ? 'uninstaller' : 'trash';
}

export function createTeXManagement({ api, getMeta, getSetup, isBusy = () => false, isBlocked = () => false,
  onInstall, onAdd, onRemove, onUninstall, onProgress, onEnvironment = () => {}, onClose = () => {} }) {
  const ui = createImportDialog('tex-management-dialog', 'TeX を管理');
  ui.dialog.classList.add('tex-management-dialog');
  const path = element('p', { id: 'tex-management-directory', class: 'tex-setup-path' });
  const format = element('p', { id: 'tex-management-format', class: 'field-help' });
  const shared = translated('p', 'この TeX を使う他のアプリやユーザーにも変更が反映されます．', { class: 'field-help', hidden: '' });
  const elevation = translated('p', '変更を始めるときに，OS が管理者の承認を求めます．', { class: 'field-help', hidden: '' });
  const external = translated('p', 'この画面で利用できない操作は，TeX の管理ツールや設定にある手動コマンドを使ってください．', { class: 'field-help' });
  const manager = translated('button', 'TeX の管理ツールを開く', { id: 'tex-management-open-manager', type: 'button', class: 'button', hidden: '' });
  const managerNote = element('p', { id: 'tex-management-manager-note', class: 'field-help', role: 'status', hidden: '' });
  const loadingMessage = translated('p', 'TeX の環境を確認しています…', { class: 'field-help', role: 'status', hidden: '' });
  const install = translated('button', 'アプリ用の TeX を導入…', { id: 'tex-management-install', type: 'button', class: 'button' });
  const inventorySection = element('section', { id: 'tex-package-inventory' });
  const heading = translated('h3', 'インストール済みのパッケージ');
  const search = labelledInput('tex-package-filter', 'パッケージを検索', 'input', { type: 'search', autocomplete: 'off', spellcheck: 'false' });
  const status = element('p', { id: 'tex-package-list-status', class: 'field-help', role: 'status' });
  const list = element('ul', { id: 'tex-package-list', class: 'tex-managed-package-list' });
  const more = translated('button', '続きを表示', { id: 'tex-package-more', type: 'button', class: 'button button-small', hidden: '' });
  const selectionActions = element('div', { class: 'tex-package-selection-actions' });
  const selectionLimit = translated('p', '一度に削除できるパッケージは 128 個までです．選択する数を減らしてください．', { class: 'field-help', role: 'status', hidden: '' });
  const selectVisible = translated('button', '表示中のパッケージを選択', { type: 'button', class: 'button button-small' });
  const clear = translated('button', '選択を解除', { type: 'button', class: 'button button-small' });
  const remove = translated('button', '選んだパッケージを削除…', { id: 'tex-package-remove', type: 'button', class: 'button' });
  selectionActions.append(selectVisible, clear, remove);
  inventorySection.append(heading, search.group, status, list, more, selectionActions, selectionLimit,
    translated('p', 'TeX の管理に必要なパッケージは，この画面から削除できません．', { class: 'field-help' }));
  const adding = element('section', { id: 'tex-package-addition' });
  const names = labelledInput('tex-managed-package-names', '追加するパッケージ', 'input', { autocomplete: 'off', spellcheck: 'false', placeholder: 'siunitx cleveref' });
  const addError = element('p', { class: 'field-help', role: 'status' });
  const reinstallLabel = element('label', { class: 'checkbox-field' });
  const reinstall = element('input', { type: 'checkbox', id: 'tex-managed-package-reinstall' });
  reinstallLabel.append(reinstall, translated('span', 'ファイルが欠けている場合は，同じパッケージを再取得する'));
  const add = translated('button', '追加する内容を確認…', { id: 'tex-managed-package-add', type: 'button', class: 'button' });
  adding.append(translated('h3', 'パッケージを追加'), names.group, reinstallLabel, addError, add);
  const danger = element('details', { class: 'tex-environment-removal', id: 'tex-environment-removal' });
  const deleteEnvironment = translated('button', 'TeX の環境全体を削除…', { id: 'tex-environment-delete', type: 'button', class: 'button button-danger' });
  const uninstallError = element('p', { id: 'tex-management-uninstall-error', class: 'field-help', hidden: '' });
  danger.append(translated('summary', 'TeX の環境全体を削除'),
    translated('p', '選択中の TeX の環境全体を削除します．実際の保存先と内容を，次の画面で確認します．', { class: 'field-help' }), uninstallError, deleteEnvironment);
  ui.body.append(path, format, shared, elevation, external, manager, managerNote, loadingMessage, install, inventorySection, adding, danger);
  const refresh = translated('button', '一覧を更新', { id: 'tex-package-refresh', type: 'button', class: 'button' });
  const close = translated('button', '閉じる', { type: 'button', class: 'button' });
  ui.footer.append(refresh, close);

  const removal = createImportDialog('tex-package-remove-dialog', 'TeX パッケージの削除を確認');
  removal.dialog.classList.add('tex-management-dialog');
  const removalPath = element('p', { class: 'tex-setup-path' });
  const requested = element('p', { id: 'tex-package-remove-requested' });
  const removalList = element('ul', { id: 'tex-package-removal-list', class: 'tex-removal-list' });
  const removalNotice = element('p', { id: 'tex-package-remove-notice', class: 'field-help', role: 'status' });
  const removalShared = translated('p', 'この TeX を使う他のアプリやユーザーにも変更が反映されます．', { class: 'field-help', hidden: '' });
  const removalElevation = translated('p', '開始すると，OS が管理者の承認を求めます．表示された TeX の保存先を確認して承認してください．', { class: 'field-help', hidden: '' });
  const removalLogDetails = element('details', { class: 'tex-setup-log' });
  const removalLog = element('pre', { tabindex: '0' });
  removalLogDetails.append(translated('summary', '削除予定を調べたログ'), removalLog);
  removal.body.append(removalPath, requested,
    translated('p', '次のパッケージを削除します．原稿が使っている場合，追加し直すまでコンパイルが失敗することがあります．'),
    removalList, removalShared, removalElevation, removalNotice, removalLogDetails);
  const removeCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const removeConfirm = translated('button', '表示したパッケージを削除', { id: 'tex-package-remove-confirm', type: 'button', class: 'button button-danger' });
  removal.footer.append(removeCancel, removeConfirm);

  const deletion = createImportDialog('tex-environment-delete-dialog', 'TeX の環境全体の削除を確認');
  deletion.dialog.classList.add('tex-management-dialog');
  const deletePath = element('p', { id: 'tex-environment-delete-path', class: 'tex-setup-path' });
  const deleteCounts = element('p', { id: 'tex-environment-delete-counts' });
  const deleteNotice = element('p', { id: 'tex-environment-delete-notice', class: 'field-help', role: 'status' });
  const deleteShared = translated('p', 'この TeX を使う他のアプリやユーザーにも変更が反映されます．', { class: 'field-help', hidden: '' });
  const deleteElevation = translated('p', '開始すると，OS が管理者の承認を求めます．表示された TeX の保存先を確認して承認してください．', { class: 'field-help', hidden: '' });
  const uninstaller = element('p', { id: 'tex-environment-uninstaller', class: 'tex-setup-path', hidden: '' });
  const systemDirectories = element('div', { id: 'tex-environment-system-directories', hidden: '' });
  const systemDirectoryList = element('ul', { class: 'tex-removal-list' });
  systemDirectories.append(translated('p', 'TeX が使うシステムのフォルダー'), systemDirectoryList);
  const unknownList = element('ul', { id: 'tex-environment-unknown-files', class: 'tex-removal-list' });
  const acknowledgeLabel = element('label', { class: 'checkbox-field' });
  const acknowledge = element('input', { id: 'tex-environment-delete-acknowledge', type: 'checkbox' });
  acknowledgeLabel.append(acknowledge, translated('span', '表示したフォルダー内の TeX のファイルとフォルダーを全て削除する'));
  const confirmation = labelledInput('tex-environment-delete-name', '確認のため TinyTeX と入力', 'input', { autocomplete: 'off', spellcheck: 'false' });
  const deleteDescription = element('p', { id: 'tex-environment-delete-description' });
  deletion.body.append(deleteDescription,
    deletePath, deleteCounts, deleteShared, deleteElevation, uninstaller, systemDirectories, deleteNotice, unknownList, acknowledgeLabel, confirmation.group);
  const deleteCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const inspectAgain = translated('button', '内容を再確認', { id: 'tex-environment-delete-recheck', type: 'button', class: 'button' });
  const deleteConfirm = translated('button', 'TeX の環境全体を削除', { id: 'tex-environment-delete-confirm', type: 'button', class: 'button button-danger' });
  const openUninstaller = translated('button', 'Windows の設定でアンインストール…', { id: 'tex-environment-open-uninstaller', type: 'button', class: 'button', hidden: '' });
  deletion.footer.append(deleteCancel, inspectAgain, deleteConfirm, openUninstaller);

  let inventory = null, plan = null, inspection = null;
  let generation = 0, sequence = 0, controller = null, readEndpoint = '';
  let loading = false, mutating = false, returnFocus = null, limit = 100;
  let selected = new Set();
  let removalChanged = false, inspectionChanged = false;
  let destroyed = false;

  function environment() { return inventory?.environment || teXEnvironment(getSetup()); }
  function busy() { return loading || mutating || isBusy() || isBlocked(); }
  function filtered() { return filterTeXPackages(inventory?.packages, search.input.value); }
  function update() {
    if (destroyed || !ui.dialog.open) return;
    const current = environment();
    const available = !!current.directory || current.managed; const blocked = busy();
    loadingMessage.hidden = !loading;
    inventorySection.hidden = adding.hidden = danger.hidden = !available;
    external.hidden = available && current.canInstallPackages && current.canRemovePackages && current.canUninstall;
    path.hidden = !available;
    path.textContent = current.directory || inventory?.directory || getMeta()?.texBin || '';
    format.hidden = !current.format;
    format.textContent = { texlive: 'TeX Live', tinytex: 'TinyTeX', mactex: 'MacTeX' }[current.format] || current.format || '';
    shared.hidden = !available || current.managed;
    elevation.hidden = !available || !current.requiresElevation;
    manager.hidden = !current.managerApplication;
    manager.disabled = blocked;
    if (!current.managerApplication) managerNote.hidden = true;
    install.disabled = blocked;
    refresh.hidden = !available; refresh.disabled = blocked;
    search.input.disabled = !inventory || mutating;
    selectVisible.disabled = blocked || !filtered().some(item => !item.protected);
    clear.disabled = !selected.size || mutating;
    remove.disabled = blocked || !selected.size || selected.size > 128 || !current.canRemovePackages;
    selectionLimit.hidden = selected.size <= 128;
    deleteEnvironment.disabled = blocked || !(current.canUninstall || current.uninstallInSettings);
    uninstallError.hidden = !current.uninstallError;
    uninstallError.textContent = current.uninstallError || '';
    const packageNames = parseTeXPackageNames(names.input.value);
    add.disabled = blocked || !packageNames || !current.canInstallPackages;
    names.input.disabled = reinstall.disabled = mutating || isBusy();
    addError.textContent = names.input.value.trim() && !packageNames ? t('パッケージ名をスペースで区切って入力してください．例: latexmk synctex') : '';
    const count = filtered().length;
    status.textContent = loading ? t('パッケージの一覧を読み込んでいます…')
      : t('{total} 個中 {shown} 個を表示，{selected} 個を選択', { total: inventory?.packages?.length || 0, shown: Math.min(limit, count), selected: selected.size });
    more.hidden = count <= limit; more.disabled = blocked;
    for (const input of list.querySelectorAll('input')) input.disabled = blocked || input.dataset.protected === 'true';
    removeConfirm.disabled = blocked || !plan?.revision || !plan?.removals?.length || !current.canRemovePackages;
    const deletable = !!inspection?.canDelete;
    const inSettings = !!inspection?.environment?.uninstallInSettings;
    acknowledgeLabel.hidden = confirmation.group.hidden = deleteConfirm.hidden = inSettings;
    openUninstaller.hidden = !inSettings;
    openUninstaller.disabled = blocked || !inspection?.directory || !inspection?.revision;
    acknowledge.disabled = confirmation.input.disabled = blocked || !deletable;
    deleteConfirm.disabled = blocked || !deletable || !current.canUninstall || !acknowledge.checked || confirmation.input.value !== (inspection?.confirmation || 'TinyTeX');
    inspectAgain.disabled = blocked;
    for (const dialog of [removal.dialog, deletion.dialog]) {
      dialog.dataset.busy = String(mutating);
      dialog.setAttribute('aria-busy', String(mutating));
      for (const button of dialog.querySelectorAll('.dialog-heading button')) button.disabled = mutating;
    }
    removeCancel.disabled = deleteCancel.disabled = mutating;
  }

  function renderList() {
    const visible = filtered().slice(0, limit);
    list.replaceChildren(...visible.map(item => {
      const row = element('li', { 'data-package': item.name });
      const label = element('label');
      const checkbox = element('input', { type: 'checkbox', 'data-protected': String(!!item.protected), 'aria-label': t('{name} を選択', { name: item.name }) });
      checkbox.checked = selected.has(item.name);
      const text = element('span');
      text.append(element('code', {}, item.name));
      if (item.description) text.append(element('small', {}, item.description));
      label.append(checkbox, text); row.append(label);
      if (item.protected) row.append(element('span', { class: 'tex-package-protected' }, t('TeX の管理に必要')));
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.name); else selected.delete(item.name); update(); });
      return row;
    }));
    update();
  }

  async function read(endpoint, options = {}) {
    if (destroyed || loading || mutating) return null;
    const opened = generation, request = ++sequence;
    const abort = new AbortController(); controller = abort; readEndpoint = endpoint; loading = true; update();
    try {
      const result = await api(endpoint, { ...options, projectRoot: null, signal: abort.signal,
        timeout: endpoint.startsWith('/api/tex/setup/') ? 660000 : 120000 });
      return !destroyed && opened === generation && request === sequence && !abort.signal.aborted ? result : null;
    } catch (error) {
      if (destroyed || opened !== generation || request !== sequence || abort.signal.aborted) return null;
      throw error;
    } finally {
      if (controller === abort) { controller = null; readEndpoint = ''; loading = false; update(); }
    }
  }

  async function refreshList() {
    if (!(environment().directory || environment().managed || getMeta()?.latexmk || getMeta()?.texBin) || !ui.dialog.open || busy()) { update(); return; }
    ui.clearError();
    try {
      const result = await read('/api/tex/packages');
      if (!result) return;
      inventory = result;
      if (result.environment) onEnvironment(result.environment);
      const allowed = new Set((inventory.packages || []).filter(item => !item.protected).map(item => item.name));
      selected = new Set([...selected].filter(name => allowed.has(name)));
      renderList();
    } catch (error) { if (ui.dialog.open && error.name !== 'AbortError') ui.showError(error); }
  }

  function showPlan(next, changed = false) {
    plan = next; removalChanged = changed;
    if (next.environment) onEnvironment(next.environment);
    removalPath.textContent = next.directory || '';
    requested.textContent = t('選択したパッケージ: {packages}', { packages: (next.packages || []).join(', ') });
    removalList.replaceChildren(...(next.removals || []).map(item => element('li', {}, `${item.name} (${formatTeXSetupBytes(item.size)})`)));
    removalLog.textContent = next.log || ''; removalLogDetails.hidden = !next.log;
    const current = next.environment || environment();
    removalShared.hidden = !!current.managed;
    removalElevation.hidden = !current.requiresElevation;
    removalNotice.textContent = changed ? t('内容が変わりました．新しい削除予定を確認してください．') : '';
    removal.open(); update(); removeCancel.focus();
  }

  async function inspectRemoval() {
    if (busy() || !selected.size) return;
    ui.clearError();
    try {
      const result = await read('/api/tex/packages/remove-preview', { method: 'POST', body: { packages: [...selected] } });
      if (result) showPlan(result);
    } catch (error) { if (ui.dialog.open && error.name !== 'AbortError') ui.showError(error); }
  }

  function showInspection(next, changed = false) {
    inspection = next; inspectionChanged = changed;
    if (next.environment) onEnvironment(next.environment);
    acknowledge.checked = false; confirmation.input.value = '';
    deletePath.textContent = next.directory || '';
    const current = next.environment || environment();
    const method = teXRemovalMethod({ ...next, environment: current });
    deleteDescription.textContent = t(method === 'trash'
      ? '表示した TeX のフォルダーをごみ箱へ移します．必要な場合は OS のごみ箱から戻せます．戻した後は TeX の設定を再確認してください．'
      : method === 'uninstaller' ? '表示した TeX の公式アンインストーラーを起動します．画面の案内を確認して削除を進めます．'
        : method === 'settings' ? 'Windows の設定を開き，表示した TeX の環境のアンインストールへ進みます．'
          : 'この削除は元に戻せません．再び TeX を使う場合は，環境の導入が必要です．');
    deleteConfirm.textContent = t(method === 'trash' ? 'TeX の環境をごみ箱へ移す' : method === 'uninstaller' ? 'アンインストーラーで削除する' : 'TeX の環境全体を削除');
    confirmation.label.textContent = t('確認のため {name} と入力', { name: next.confirmation || 'TinyTeX' });
    deleteShared.hidden = !!current.managed;
    deleteElevation.hidden = !current.requiresElevation;
    uninstaller.hidden = !current.uninstaller;
    uninstaller.textContent = current.uninstaller ? t('使用するアンインストーラー: {path}', { path: current.uninstaller }) : '';
    systemDirectories.hidden = !current.systemDirectories?.length;
    systemDirectoryList.replaceChildren(...(current.systemDirectories || []).map(value => element('li', {}, value)));
    deleteCounts.textContent = t('ファイル {files} 個，フォルダー {directories} 個，{size}', { files: next.fileCount || 0, directories: next.directoryCount || 0, size: formatTeXSetupBytes(next.size || 0) });
    const unknown = next.unknownFiles || [];
    deleteNotice.textContent = current.uninstallInSettings
      ? t('Windows のアプリ設定で対象の TeX を選んでアンインストールします．この画面からは直接削除しません．')
      : !next.canDelete
      ? current.uninstallError || t('管理対象として確認できないファイルがあるため，環境全体を削除できません．表示されたファイルと保存先を確認してください．')
      : changed ? t('内容が変わりました．保存先と削除する内容をもう一度確認してください．')
        : unknown.length ? t('次のファイルも対象のフォルダーに含まれます．内容を確認してください．') : '';
    unknownList.hidden = !unknown.length;
    unknownList.replaceChildren(...unknown.map(name => element('li', {}, name)));
    deletion.open(); update(); deleteCancel.focus();
  }

  async function inspectEnvironment() {
    if (busy()) return;
    (deletion.dialog.open ? deletion : ui).clearError();
    try {
      const result = await read('/api/tex/setup/delete');
      if (result) showInspection(result);
    } catch (error) { if (ui.dialog.open && error.name !== 'AbortError') (deletion.dialog.open ? deletion : ui).showError(error); }
  }

  async function execute(action, operation) {
    if (busy()) return;
    mutating = true; action.clearError(); update();
    (action === removal ? removalNotice : deleteNotice).textContent = t('削除する内容を再確認しています…');
    try {
      const result = await operation();
      if (result?.started) {
        action.close(); ui.close(); onProgress(result.operation); return;
      }
      const error = result?.error || new Error(t('処理を開始できませんでした．状態を再確認してください．'));
      if (error.status === 409 && action === removal && error.data?.preview) showPlan(error.data.preview, true);
      else if (error.status === 409 && action === deletion && error.data?.inspection) showInspection(error.data.inspection, true);
      else action.showError(error);
    } catch (error) { action.showError(error); }
    finally { mutating = false; update(); if (action.dialog.open) (action === removal ? removeCancel : deleteCancel).focus(); }
  }

  async function open() {
    if (destroyed || isBlocked()) return;
    returnFocus = document.activeElement; ++generation;
    selected.clear(); limit = 100; search.input.value = ''; inventory = null;
    ui.open(); renderList(); close.focus();
    await refreshList();
  }

  search.input.addEventListener('input', () => { limit = 100; renderList(); });
  more.addEventListener('click', () => { limit += 100; renderList(); });
  names.input.addEventListener('input', update);
  selectVisible.addEventListener('click', () => { for (const item of filtered().slice(0, limit)) if (!item.protected) selected.add(item.name); renderList(); });
  clear.addEventListener('click', () => { selected.clear(); renderList(); });
  add.addEventListener('click', () => { if (!add.disabled) { const values = { packages: parseTeXPackageNames(names.input.value), reinstall: reinstall.checked }; ui.close(); onAdd(values); } });
  install.addEventListener('click', () => { if (!install.disabled) { ui.close(); onInstall(); } });
  manager.addEventListener('click', async () => {
    if (manager.disabled) return;
    ui.clearError();
    try {
      const result = await read('/api/tex/packages/manager', { method: 'POST', body: {} });
      if (result) { managerNote.textContent = t('TeX の管理ツールを開きました．変更が終わったら一覧を更新してください．'); managerNote.hidden = false; }
    } catch (error) { if (ui.dialog.open && error.name !== 'AbortError') ui.showError(error); }
  });
  remove.addEventListener('click', () => { void inspectRemoval(); });
  refresh.addEventListener('click', () => { void refreshList(); });
  close.addEventListener('click', () => ui.close());
  deleteEnvironment.addEventListener('click', () => { void inspectEnvironment(); });
  inspectAgain.addEventListener('click', () => { void inspectEnvironment(); });
  acknowledge.addEventListener('change', update); confirmation.input.addEventListener('input', update);
  removeCancel.addEventListener('click', () => { if (!mutating) removal.close(); });
  deleteCancel.addEventListener('click', () => { if (!mutating) deletion.close(); });
  removeConfirm.addEventListener('click', () => { if (!removeConfirm.disabled) void execute(removal, () => onRemove(plan)); });
  deleteConfirm.addEventListener('click', () => { if (!deleteConfirm.disabled) void execute(deletion, () => onUninstall(inspection, confirmation.input.value)); });
  openUninstaller.addEventListener('click', async () => {
    if (openUninstaller.disabled) return;
    deletion.clearError();
    try {
      const result = await read('/api/tex/setup/uninstaller', { method: 'POST', body: { directory: inspection.directory, revision: inspection.revision } });
      if (result && deletion.dialog.open) deleteNotice.textContent = t('Windows のアプリ設定を開きました．Windows 側でアンインストールした後，この画面を閉じて環境を再確認してください．');
    } catch (error) {
      if (deletion.dialog.open && error.status === 409 && error.data?.inspection) showInspection(error.data.inspection, true);
      else if (deletion.dialog.open && error.name !== 'AbortError') deletion.showError(error);
    }
  });
  for (const dialog of [removal.dialog, deletion.dialog]) {
    dialog.addEventListener('cancel', event => { if (mutating) event.preventDefault(); });
    dialog.addEventListener('click', event => { if (mutating && event.target === dialog) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  }
  removal.dialog.addEventListener('close', () => { if (ui.dialog.open && !remove.disabled) remove.focus(); });
  deletion.dialog.addEventListener('close', () => {
    if (readEndpoint === '/api/tex/setup/delete') {
      ++sequence; controller?.abort(); controller = null; readEndpoint = ''; loading = false; update();
    }
    if (ui.dialog.open && !deleteEnvironment.disabled) deleteEnvironment.focus();
  });
  ui.dialog.addEventListener('close', () => {
    ++generation; ++sequence; controller?.abort(); controller = null; readEndpoint = ''; loading = false;
    if (returnFocus?.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length) returnFocus.focus();
    onClose();
  });
  const unsubscribe = onLanguageChange(() => {
    for (const view of [ui, removal, deletion]) translateElements(view.dialog);
    renderList();
    if (removal.dialog.open && plan) showPlan(plan, removalChanged);
    if (deletion.dialog.open && inspection) showInspection(inspection, inspectionChanged);
  });
  return {
    open, update,
    refresh: refreshList,
    destroy() { destroyed = true; ++generation; controller?.abort(); unsubscribe(); for (const view of [ui, removal, deletion]) view.destroy(); },
  };
}
