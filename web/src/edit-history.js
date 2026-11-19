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
  const entries = element('div', 'history-entries'); entries.setAttribute('role', 'list'); entries.dataset.testid = 'history-entries';
  const changes = element('div', 'history-changes'); changes.dataset.testid = 'history-changes'; layout.append(entries, changes);
  const footer = element('div', 'writing-actions'); const selectAll = element('button', 'button'); selectAll.type = 'button'; const restore = element('button', 'button button-primary'); restore.type = 'button'; restore.dataset.testid = 'restore-history-selection'; restore.disabled = true; footer.append(selectAll, restore);
  const status = element('p', 'writing-status'); status.setAttribute('role', 'status'); status.dataset.testid = 'history-status';
  dialog.append(heading, description, settings, recordForm, layout, footer, status); document.body.append(dialog);
  let documentSnapshot = null, versions = [], hunks = [], selected = new Set(), chosenID = '', sequence = 0, busy = false;

  function translate() {
    title.textContent = tr('編集履歴', 'Edit history'); close.setAttribute('aria-label', tr('閉じる', 'Close'));
    description.textContent = documentSnapshot ? tr(`${documentSnapshot.path} の以前の内容を，現在の原稿と見比べて戻せます．`, `Compare earlier versions of ${documentSnapshot.path} with the current document and restore selected changes.`) : '';
    settingsTitle.textContent = tr('履歴の設定', 'History settings'); enabledText.textContent = tr('編集履歴を記録する', 'Record edit history'); daysText.textContent = tr('保存する日数', 'Days to keep'); capacityText.textContent = tr('合計容量 (MiB)', 'Total storage (MiB)'); saveSettings.textContent = tr('設定を保存', 'Save settings');
    limits.textContent = tr('保存前の原稿を，1 分以上の間隔で圧縮して記録します．1 ファイルにつき最大 50 版，全体で最大 2000 版です．2 MiB を超える原稿は対象外です．期間や容量を超えた古い版は削除されます．オフにすると新しい版の記録を停止します．', 'The previous saved text is compressed at intervals of at least one minute. Limits: 50 versions per file, 2000 versions overall, and 2 MiB per document. Older versions are removed when age or storage limits are reached. Turning this off stops new records.');
    label.placeholder = tr('版の名前 (任意)', 'Version name (optional)'); label.setAttribute('aria-label', label.placeholder);
    record.textContent = tr('現在の内容を記録', 'Record current text'); selectAll.textContent = tr('すべて選択 / 解除', 'Select / clear all');
    restore.textContent = tr(`選択した ${selected.size} 箇所を原稿へ戻す`, `Restore ${selected.size} selected changes`);
  }
  function showError(error) { status.textContent = error.message || String(error); status.classList.add('form-error'); }
  function updateSelection() {
    for (const box of changes.querySelectorAll('input[data-hunk]')) box.checked = selected.has(Number(box.dataset.hunk));
    restore.disabled = busy || selected.size === 0; selectAll.disabled = busy || hunks.length === 0; translate();
  }
  function renderEntries() {
    entries.replaceChildren();
    if (!versions.length) entries.append(element('p', 'field-help', tr('記録した版はまだありません．原稿を保存すると，変更前の内容を記録します．', 'No versions yet. Saving an edited document records the previous text.')));
    for (const entry of versions) {
      const button = element('button', 'history-entry'); button.type = 'button'; button.dataset.historyId = entry.id; button.setAttribute('aria-pressed', String(entry.id === chosenID));
      const when = new Date(entry.createdAt).toLocaleString(getLanguage() === 'ja' ? 'ja-JP' : 'en-US');
      button.append(element('strong', '', entry.label || when), element('span', '', entry.label ? when : tr('保存前の原稿', 'Text before saving')));
      button.addEventListener('click', () => loadEntry(entry.id)); entries.append(button);
    }
  }
  function renderChanges() {
    changes.replaceChildren();
    if (chosenID && !hunks.length) changes.append(element('p', 'field-help', tr('現在の原稿と同じ内容です．', 'This version matches the current document.')));
    hunks.forEach((hunk, index) => {
      const group = element('section', 'history-change'); const header = element('label', 'history-change-heading'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.hunk = String(index); checkbox.checked = selected.has(index);
      checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(index) : selected.delete(index); updateSelection(); });
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
    const request = ++sequence; const path = documentSnapshot.path;
    const result = await api(`/api/history?path=${encodeURIComponent(path)}`);
    if (request !== sequence || !dialog.open) return;
    versions = result.entries || []; enabled.checked = result.settings.enabled; days.value = String(result.settings.days); capacity.value = String(result.settings.maxBytes / 1048576); record.disabled = !result.settings.enabled;
    renderEntries();
  }
  async function loadEntry(id) {
    const request = ++sequence; chosenID = id; selected.clear(); hunks = []; renderEntries(); renderChanges(); status.classList.remove('form-error'); status.textContent = tr('履歴を読み込んでいます…', 'Loading the version…');
    try {
      const result = await api(`/api/history?path=${encodeURIComponent(documentSnapshot.path)}&id=${encodeURIComponent(id)}`);
      if (request !== sequence || !dialog.open) return;
      hunks = historyHunks(result.content, documentSnapshot.content); renderChanges(); status.textContent = tr('戻したい箇所を選んでください．原稿へ反映した後も Undo で取り消せます．', 'Select the changes to restore. You can undo them after applying them to the editor.');
    } catch (error) { if (request === sequence) showError(error); }
  }
  settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    try { await api('/api/history/settings', { method: 'PUT', body: { enabled: enabled.checked, days: Number(days.value), maxBytes: Number(capacity.value) * 1048576 } }); record.disabled = !enabled.checked; await refresh(); status.classList.remove('form-error'); status.textContent = tr('履歴の設定を保存しました．', 'History settings saved.'); }
    catch (error) { showError(error); }
  });
  recordForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const current = getActiveDocument();
      if (!current || current.path !== documentSnapshot.path) throw new Error(tr('原稿を開き直してから履歴を記録してください．', 'Reopen the document before recording its history.'));
      await api('/api/history', { method: 'POST', body: { path: current.path, content: current.content, revision: current.revision, label: label.value } });
      documentSnapshot = { ...current }; label.value = ''; chosenID = ''; hunks = []; selected.clear(); renderChanges(); await refresh(); status.classList.remove('form-error'); status.textContent = tr('現在の内容を記録しました．', 'The current text was recorded.');
    } catch (error) { showError(error); }
  });
  selectAll.addEventListener('click', () => { selected = selected.size === hunks.length ? new Set() : new Set(hunks.map((_, index) => index)); updateSelection(); });
  restore.addEventListener('click', async () => {
    if (busy || !selected.size) return;
    busy = true; close.disabled = true; updateSelection();
    try {
      const current = getActiveDocument();
      if (!current || current.path !== documentSnapshot.path || current.content !== documentSnapshot.content) throw new Error(tr('履歴を開いた後に原稿が変更されました．履歴を開き直してください．', 'The document changed after history was opened. Open history again.'));
      const content = restoreHistoryHunks(current.content, hunks, selected);
      const edits = hunks.filter((_, index) => selected.has(index)).map(hunk => ({ from: hunk.from, to: hunk.to, insert: hunk.before }));
      await replaceEditorText(current.path, content, documentSnapshot.content, edits); dialog.close();
    } catch (error) { showError(error); }
    finally { busy = false; close.disabled = false; updateSelection(); }
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++sequence; });
  const unsubscribe = onLanguageChange(() => { translate(); if (dialog.open) { renderEntries(); renderChanges(); } });
  translate();
  return {
    async open() {
      const current = getActiveDocument();
      if (!current) throw new Error(tr('履歴を確認する原稿を開いてください．', 'Open a text document to view its history.'));
      documentSnapshot = { ...current }; chosenID = ''; versions = []; hunks = []; selected.clear(); status.textContent = ''; status.classList.remove('form-error'); renderEntries(); renderChanges(); translate();
      if (!dialog.open) dialog.showModal();
      try { await refresh(); } catch (error) { showError(error); }
    },
    close() { if (!busy) dialog.close(); },
    destroy() { unsubscribe(); dialog.remove(); },
  };
}
