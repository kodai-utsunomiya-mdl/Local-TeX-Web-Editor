import { getLanguage, onLanguageChange } from './i18n.js';
import { historyHunks, restoreHistoryHunks } from './history-diff.js';

const tr = (ja, en) => getLanguage() === 'ja' ? ja : en;
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

export function createEditHistory({ api, getActiveDocument, replaceEditorText }) {
  const dialog = element('dialog', 'dialog writing-dialog edit-history-dialog'); dialog.id = 'edit-history-dialog'; dialog.dataset.testid = 'edit-history-dialog'; dialog.setAttribute('aria-labelledby', 'edit-history-title');
  const heading = element('div', 'dialog-heading'); const title = element('h2'); title.id = 'edit-history-title'; const close = element('button', 'icon-button', '×'); close.type = 'button'; heading.append(title, close);
  const description = element('p', 'field-help');
  const settings = element('details', 'history-settings'); const settingsTitle = element('summary');
  const settingsForm = element('form', 'writing-options');
  const enabledLabel = element('label'); const enabled = element('input'); enabled.type = 'checkbox'; enabled.dataset.testid = 'history-enabled'; const enabledText = element('span'); enabledLabel.append(enabled, enabledText);
  const daysLabel = element('label'); const daysText = element('span'); const days = element('input'); days.type = 'number'; days.min = '1'; days.max = '365'; days.required = true; days.dataset.testid = 'history-days'; daysLabel.append(daysText, days);
  const capacityLabel = element('label'); const capacityText = element('span'); const capacity = element('input'); capacity.type = 'number'; capacity.min = '5'; capacity.max = '200'; capacity.required = true; capacity.dataset.testid = 'history-capacity'; capacityLabel.append(capacityText, capacity);
  const saveSettings = element('button', 'button'); saveSettings.type = 'submit'; const limits = element('p', 'field-help'); settingsForm.append(enabledLabel, daysLabel, capacityLabel, saveSettings); settings.append(settingsTitle, settingsForm, limits);
  const recordForm = element('form', 'history-record-form'); const label = element('input'); label.type = 'text'; label.maxLength = 100; label.dataset.testid = 'history-label'; const record = element('button', 'button'); record.type = 'submit'; record.dataset.testid = 'record-history'; recordForm.append(label, record);
  const layout = element('div', 'history-layout');
  const versionsPane = element('section', 'history-versions');
  const versionActions = element('div', 'history-version-actions');
  const versionTitle = element('h3');
  const allVersionsLabel = element('label'); const allVersions = element('input'); allVersions.type = 'checkbox'; allVersions.id = 'history-select-all-versions'; const allVersionsText = element('span'); allVersionsLabel.append(allVersions, allVersionsText);
  const versionCount = element('span', 'field-help');
  const deleteVersions = element('button', 'button button-small history-delete-button'); deleteVersions.type = 'button'; deleteVersions.id = 'history-delete-selected'; deleteVersions.setAttribute('aria-haspopup', 'dialog'); deleteVersions.setAttribute('aria-controls', 'history-delete-dialog');
  versionActions.append(versionTitle, allVersionsLabel, versionCount, deleteVersions);
  const entries = element('div', 'history-entries'); entries.setAttribute('role', 'list'); entries.dataset.testid = 'history-entries';
  const changes = element('div', 'history-changes'); changes.dataset.testid = 'history-changes'; versionsPane.append(versionActions, entries); layout.append(versionsPane, changes);
  const footer = element('div', 'writing-actions'); const selectAll = element('button', 'button'); selectAll.type = 'button'; selectAll.id = 'history-select-all-changes'; const restore = element('button', 'button button-primary'); restore.type = 'button'; restore.dataset.testid = 'restore-history-selection'; restore.disabled = true; footer.append(selectAll, restore);
  const status = element('p', 'writing-status'); status.setAttribute('role', 'status'); status.dataset.testid = 'history-status';
  dialog.append(heading, description, settings, recordForm, layout, footer, status); document.body.append(dialog);
  const deleteDialog = element('dialog', 'dialog history-delete-dialog'); deleteDialog.id = 'history-delete-dialog'; deleteDialog.setAttribute('aria-labelledby', 'history-delete-title'); deleteDialog.setAttribute('aria-describedby', 'history-delete-description');
  const deleteHeading = element('div', 'dialog-heading'); const deleteTitle = element('h2'); deleteTitle.id = 'history-delete-title'; deleteHeading.append(deleteTitle);
  const deleteDescription = element('p', 'field-help'); deleteDescription.id = 'history-delete-description';
  const deleteEntries = element('ul', 'history-delete-entries'); deleteEntries.id = 'history-delete-entries';
  const deleteError = element('p', 'form-error'); deleteError.hidden = true; deleteError.setAttribute('role', 'alert');
  const deleteFooter = element('div', 'dialog-actions'); const deleteCancel = element('button', 'button'); deleteCancel.type = 'button'; deleteCancel.id = 'history-delete-cancel'; const deleteConfirm = element('button', 'button history-delete-button'); deleteConfirm.type = 'button'; deleteConfirm.id = 'history-delete-confirm'; deleteFooter.append(deleteCancel, deleteConfirm);
  deleteDialog.append(deleteHeading, deleteDescription, deleteEntries, deleteError, deleteFooter); document.body.append(deleteDialog);
  let documentSnapshot = null, versions = [], hunks = [], selected = new Set(), selectedVersions = new Set(), chosenID = '', loadedID = '', loadingID = '';
  let sequence = 0, listSequence = 0, entrySequence = 0, busy = false, historyEnabled = true;
  let lastSelectedVersion = '', lastSelectedHunk = -1, pendingDeletion = [];

  function versionDate(entry) { return new Date(entry.createdAt).toLocaleString(getLanguage() === 'ja' ? 'ja-JP' : 'en-US'); }
  function selectRange(values, selection, index, anchor, checked, range) {
    const first = range && anchor >= 0 ? Math.min(index, anchor) : index;
    const last = range && anchor >= 0 ? Math.max(index, anchor) : index;
    for (let position = first; position <= last; position++) checked ? selection.add(values[position]) : selection.delete(values[position]);
  }
  function updateVersionSelection() {
    for (const box of entries.querySelectorAll('input[data-history-select]')) { box.checked = selectedVersions.has(box.dataset.historySelect); box.disabled = busy; }
    for (const button of entries.querySelectorAll('button')) button.disabled = busy;
    allVersions.checked = versions.length > 0 && selectedVersions.size === versions.length;
    allVersions.indeterminate = selectedVersions.size > 0 && selectedVersions.size < versions.length;
    allVersions.disabled = busy || !versions.length;
    versionCount.textContent = tr(`${versions.length} 版中 ${selectedVersions.size} 版を選択`, `${selectedVersions.size} of ${versions.length} versions selected`);
    deleteVersions.textContent = tr(`選択した ${selectedVersions.size} 版を削除…`, `Delete ${selectedVersions.size} selected versions…`);
    deleteVersions.disabled = busy || !selectedVersions.size;
  }
  function renderDeletion() {
    deleteTitle.textContent = tr('選択した版を削除', 'Delete selected versions');
    deleteDescription.textContent = tr(`${documentSnapshot?.path || ''} の次の ${pendingDeletion.length} 版を編集履歴から削除します．削除した履歴は元に戻せません．`, `Delete these ${pendingDeletion.length} versions of ${documentSnapshot?.path || ''} from edit history. Deleted versions cannot be recovered.`);
    deleteEntries.replaceChildren();
    for (const entry of pendingDeletion) {
      const item = element('li'); item.append(element('strong', '', entry.label || versionDate(entry)));
      if (entry.label) item.append(element('span', '', versionDate(entry)));
      deleteEntries.append(item);
    }
    deleteCancel.textContent = tr('キャンセル', 'Cancel');
    deleteConfirm.textContent = tr(`${pendingDeletion.length} 版を削除`, `Delete ${pendingDeletion.length} versions`);
    deleteConfirm.disabled = deleteCancel.disabled = busy;
  }

  function translate() {
    title.textContent = tr('編集履歴', 'Edit history'); close.setAttribute('aria-label', tr('閉じる', 'Close'));
    description.textContent = documentSnapshot ? tr(`${documentSnapshot.path} の以前の内容を，現在の原稿と見比べて戻せます．`, `Compare earlier versions of ${documentSnapshot.path} with the current document and restore selected changes.`) : '';
    settingsTitle.textContent = tr('履歴の設定', 'History settings'); enabledText.textContent = tr('編集履歴を記録する', 'Record edit history'); daysText.textContent = tr('保存する日数', 'Days to keep'); capacityText.textContent = tr('合計容量 (MiB)', 'Total storage (MiB)'); saveSettings.textContent = tr('設定を保存', 'Save settings');
    limits.textContent = tr('保存前の原稿を，1 分以上の間隔で圧縮して記録します．1 ファイルにつき最大 50 版，全体で最大 2000 版です．2 MiB を超える原稿は対象外です．期間や容量を超えた古い版は削除されます．オフにすると新しい版の記録を停止します．', 'The previous saved text is compressed at intervals of at least one minute. Limits: 50 versions per file, 2000 versions overall, and 2 MiB per document. Older versions are removed when age or storage limits are reached. Turning this off stops new records.');
    label.placeholder = tr('版の名前 (任意)', 'Version name (optional)'); label.setAttribute('aria-label', label.placeholder);
    record.textContent = tr('現在の内容を記録', 'Record current text');
    selectAll.textContent = selected.size && selected.size === hunks.length ? tr('変更箇所の選択を解除', 'Clear change selection') : tr('変更箇所をすべて選択', 'Select all changes');
    restore.textContent = tr(`選択した ${selected.size} 箇所を原稿へ戻す`, `Restore ${selected.size} selected changes`);
    versionTitle.textContent = tr('記録した版', 'Recorded versions'); allVersionsText.textContent = tr('すべての版を選択', 'Select all versions');
    updateVersionSelection(); if (deleteDialog.open) renderDeletion();
  }
  function showError(error) { status.textContent = error.message || String(error); status.classList.add('form-error'); }
  function updateSelection() {
    for (const box of changes.querySelectorAll('input[data-hunk]')) { box.checked = selected.has(Number(box.dataset.hunk)); box.disabled = busy; }
    restore.disabled = busy || selected.size === 0; selectAll.disabled = busy || hunks.length === 0;
    close.disabled = saveSettings.disabled = enabled.disabled = days.disabled = capacity.disabled = label.disabled = busy;
    record.disabled = busy || !historyEnabled; translate();
  }
  function renderEntries() {
    const focused = entries.contains(document.activeElement) ? { id: document.activeElement.dataset.historyId, selected: document.activeElement.dataset.historySelect } : null;
    entries.replaceChildren();
    layout.classList.toggle('is-empty', !versions.length);
    versionActions.hidden = !versions.length;
    changes.hidden = !versions.length;
    if (!versions.length) {
      const empty = element('div', 'history-empty');
      const explanation = element('p', 'field-help');
      explanation.append(
        element('span', 'history-empty-clause', tr('原稿を保存すると，', 'Saving an edited document')),
        document.createTextNode(tr('', ' ')),
        element('span', 'history-empty-clause', tr('変更前の内容を記録します．', 'records the previous text.')),
      );
      empty.append(element('p', 'field-help', tr('記録した版はまだありません．', 'No versions yet.')), explanation);
      entries.append(empty);
    }
    for (const [index, entry] of versions.entries()) {
      const row = element('div', 'history-entry-row'); row.setAttribute('role', 'listitem');
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.historySelect = entry.id;
      checkbox.setAttribute('aria-label', tr(`${entry.label || versionDate(entry)} を選択`, `Select ${entry.label || versionDate(entry)}`));
      checkbox.addEventListener('click', event => {
        selectRange(versions.map(item => item.id), selectedVersions, index, versions.findIndex(item => item.id === lastSelectedVersion), checkbox.checked, event.shiftKey);
        lastSelectedVersion = entry.id; updateVersionSelection();
      });
      const button = element('button', 'history-entry'); button.type = 'button'; button.dataset.historyId = entry.id; button.setAttribute('aria-pressed', String(entry.id === chosenID));
      const when = versionDate(entry);
      button.append(element('strong', '', entry.label || when), element('span', '', entry.label ? when : tr('保存前の原稿', 'Text before saving')));
      button.addEventListener('click', () => { if (!busy) void loadEntry(entry.id); }); row.append(checkbox, button); entries.append(row);
    }
    updateVersionSelection();
    if (focused) {
      const control = [...entries.querySelectorAll('input, button')].find(node => focused.id ? node.dataset.historyId === focused.id : node.dataset.historySelect === focused.selected);
      if (control && !control.disabled) control.focus({ preventScroll: true });
    }
  }
  function renderChanges() {
    changes.replaceChildren();
    if (chosenID && loadingID === chosenID) changes.append(element('p', 'field-help', tr('履歴を読み込んでいます…', 'Loading the version…')));
    else if (chosenID && loadedID === chosenID && !hunks.length) changes.append(element('p', 'field-help', tr('現在の原稿と同じ内容です．', 'This version matches the current document.')));
    hunks.forEach((hunk, index) => {
      const group = element('section', 'history-change'); const header = element('label', 'history-change-heading'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.hunk = String(index); checkbox.checked = selected.has(index);
      checkbox.addEventListener('click', event => {
        selectRange(hunks.map((_, position) => position), selected, index, lastSelectedHunk, checkbox.checked, event.shiftKey);
        lastSelectedHunk = index; updateSelection();
      });
      header.append(checkbox, element('span', '', tr(`現在の ${hunk.line} 行目からの変更`, `Change starting at current line ${hunk.line}`)));
      const columns = element('div', 'history-diff-columns');
      for (const [name, text, className] of [[tr('以前の内容', 'Earlier text'), hunk.before, 'history-earlier'], [tr('現在の原稿', 'Current text'), hunk.current, 'history-current']]) {
        const column = element('div', className); column.append(element('h4', '', name));
        column.append(element('pre', '', text.length > 20000 ? `${text.slice(0, 20000)}\n…${tr('(表示を省略しています．選択するとこの変更全体を戻します)', '(Display shortened; selecting restores this entire change)')}` : text || tr('(空)', '(empty)'))); columns.append(column);
      }
      group.append(header, columns); changes.append(group);
    });
    updateSelection();
  }
  async function refresh() {
    const request = ++listSequence, generation = sequence; const { path, projectRoot } = documentSnapshot;
    const result = await api(`/api/history?path=${encodeURIComponent(path)}`, { projectRoot });
    if (request !== listSequence || generation !== sequence || !dialog.open) return;
    applyHistoryResponse(result);
  }
  function applyHistoryResponse(result) {
    versions = result.entries || [];
    selectedVersions = new Set([...selectedVersions].filter(id => versions.some(entry => entry.id === id)));
    if (chosenID && !versions.some(entry => entry.id === chosenID)) { ++entrySequence; chosenID = loadedID = loadingID = ''; hunks = []; selected.clear(); lastSelectedHunk = -1; renderChanges(); }
    if (result.settings) { historyEnabled = result.settings.enabled; enabled.checked = historyEnabled; days.value = String(result.settings.days); capacity.value = String(result.settings.maxBytes / 1048576); record.disabled = busy || !historyEnabled; }
    renderEntries();
  }
  async function loadEntry(id) {
    const request = ++entrySequence, generation = sequence; const snapshot = documentSnapshot;
    chosenID = loadingID = id; loadedID = ''; selected.clear(); lastSelectedHunk = -1; hunks = []; renderEntries(); renderChanges(); status.classList.remove('form-error'); status.textContent = tr('履歴を読み込んでいます…', 'Loading the version…');
    try {
      const result = await api(`/api/history?path=${encodeURIComponent(snapshot.path)}&id=${encodeURIComponent(id)}`, { projectRoot: snapshot.projectRoot });
      if (request !== entrySequence || generation !== sequence || !dialog.open || chosenID !== id) return;
      loadingID = ''; loadedID = id;
      hunks = historyHunks(result.content, snapshot.content); renderChanges(); status.textContent = tr('戻したい箇所を選んでください．原稿へ反映した後も Undo で取り消せます．', 'Select the changes to restore. You can undo them after applying them to the editor.');
    } catch (error) { if (request === entrySequence && generation === sequence && dialog.open && chosenID === id) { loadingID = ''; renderChanges(); showError(error); } }
  }
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; updateSelection();
    try { await api('/api/history/settings', { method: 'PUT', projectRoot: documentSnapshot.projectRoot, body: { enabled: enabled.checked, days: Number(days.value), maxBytes: Number(capacity.value) * 1048576 } }); await refresh(); status.classList.remove('form-error'); status.textContent = tr('履歴の設定を保存しました．', 'History settings saved.'); }
    catch (error) { showError(error); }
    finally { busy = false; updateSelection(); }
  });
  recordForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true; updateSelection();
    try {
      const current = getActiveDocument();
      if (!current || current.path !== documentSnapshot.path || current.projectRoot !== documentSnapshot.projectRoot) throw new Error(tr('原稿を開き直してから履歴を記録してください．', 'Reopen the document before recording its history.'));
      await api('/api/history', { method: 'POST', projectRoot: current.projectRoot, body: { path: current.path, content: current.content, revision: current.revision, label: label.value } });
      documentSnapshot = { ...current }; label.value = ''; chosenID = loadedID = loadingID = ''; hunks = []; selected.clear(); renderChanges(); await refresh(); status.classList.remove('form-error'); status.textContent = tr('現在の内容を記録しました．', 'The current text was recorded.');
    } catch (error) { showError(error); }
    finally { busy = false; updateSelection(); }
  });
  selectAll.addEventListener('click', () => { selected = selected.size === hunks.length ? new Set() : new Set(hunks.map((_, index) => index)); updateSelection(); });
  allVersions.addEventListener('change', () => { selectedVersions = allVersions.checked ? new Set(versions.map(entry => entry.id)) : new Set(); lastSelectedVersion = ''; updateVersionSelection(); });
  deleteVersions.addEventListener('click', () => {
    if (busy || !selectedVersions.size) return;
    pendingDeletion = versions.filter(entry => selectedVersions.has(entry.id));
    deleteError.hidden = true; deleteError.textContent = ''; renderDeletion();
    deleteDialog.showModal(); deleteCancel.focus({ preventScroll: true });
  });
  deleteCancel.addEventListener('click', () => { if (!busy) deleteDialog.close('cancel'); });
  deleteDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  deleteDialog.addEventListener('close', () => {
    if (!dialog.open) return;
    const control = [deleteVersions, ...entries.querySelectorAll('button'), record, close].find(button => !button.disabled);
    control?.focus({ preventScroll: true });
  });
  deleteConfirm.addEventListener('click', async () => {
    if (busy || !pendingDeletion.length) return;
    ++listSequence; busy = true; deleteError.hidden = true; updateSelection(); renderDeletion();
    try {
      const result = await api('/api/history', { method: 'DELETE', projectRoot: documentSnapshot.projectRoot, body: { path: documentSnapshot.path, ids: pendingDeletion.map(entry => entry.id) } });
      applyHistoryResponse(result);
      const count = result.deleted?.length || 0;
      status.classList.remove('form-error'); status.textContent = count ? tr(`${count} 版を編集履歴から削除しました．`, `Deleted ${count} versions from edit history.`) : tr('選択した版はすでに一覧にありません．', 'The selected versions are no longer in the history.');
      deleteDialog.close('deleted');
    } catch (error) {
      deleteError.textContent = error.message || String(error); deleteError.hidden = false;
      try { await refresh(); } catch (refreshError) { showError(refreshError); }
    } finally { busy = false; updateSelection(); renderDeletion(); }
  });
  restore.addEventListener('click', async () => {
    if (busy || !selected.size) return;
    busy = true; close.disabled = true; updateSelection();
    try {
      const current = getActiveDocument();
      if (!current || current.path !== documentSnapshot.path || current.projectRoot !== documentSnapshot.projectRoot || current.content !== documentSnapshot.content) throw new Error(tr('履歴を開いた後に原稿が変更されました．履歴を開き直してください．', 'The document changed after history was opened. Open history again.'));
      const content = restoreHistoryHunks(current.content, hunks, selected);
      const edits = hunks.filter((_, index) => selected.has(index)).map(hunk => ({ from: hunk.from, to: hunk.to, insert: hunk.before }));
      await replaceEditorText(current.path, content, documentSnapshot.content, edits); dialog.close();
    } catch (error) { showError(error); }
    finally { busy = false; close.disabled = false; updateSelection(); }
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++sequence; if (deleteDialog.open && !busy) deleteDialog.close(); });
  const unsubscribe = onLanguageChange(() => { translate(); if (dialog.open) { renderEntries(); renderChanges(); } });
  translate();
  return {
    async open() {
      const current = getActiveDocument();
      if (!current) throw new Error(tr('履歴を確認する原稿を開いてください．', 'Open a text document to view its history.'));
      const generation = ++sequence;
      documentSnapshot = { ...current }; chosenID = loadedID = loadingID = ''; versions = []; hunks = []; selected.clear(); selectedVersions.clear(); lastSelectedVersion = ''; lastSelectedHunk = -1; pendingDeletion = []; status.textContent = ''; status.classList.remove('form-error'); renderEntries(); renderChanges(); translate();
      if (!dialog.open) dialog.showModal();
      try { await refresh(); } catch (error) { if (generation === sequence && dialog.open) showError(error); }
    },
    close() { if (!busy) { if (deleteDialog.open) deleteDialog.close(); dialog.close(); } },
    destroy() { unsubscribe(); deleteDialog.remove(); dialog.remove(); },
  };
}
