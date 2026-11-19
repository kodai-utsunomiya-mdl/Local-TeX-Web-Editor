import { getLanguage, onLanguageChange } from './i18n.js';

const tr = (ja, en) => getLanguage() === 'ja' ? ja : en;
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const compact = text => text.length > 500 ? `${text.slice(0, 500)}…` : text || '∅';

export function replacementChanges(files, selected) {
  const changes = [];
  for (const file of files) {
    const matches = file.matches.filter((match, index) => selected.has(`${file.path}\0${index}`));
    if (!matches.length) continue;
    let position = 0, content = '';
    for (const match of matches) {
      if (match.from < position || match.to < match.from || match.to > file.content.length || file.content.slice(match.from, match.to) !== match.text) throw new Error('Search results no longer match the document.');
      content += file.content.slice(position, match.from) + match.replacement;
      position = match.to;
    }
    content += file.content.slice(position);
    if (content !== file.content) changes.push({ path: file.path, content, revision: file.revision, expectedContent: file.content, edits: matches.map(match => ({ from: match.from, to: match.to, insert: match.replacement })) });
  }
  return changes;
}

// Call this while the app has paused ordinary saves and file switching. The
// response contains any completed writes if a later file changes on disk.
export async function replaceProjectDocuments(api, changes, openDocuments, onReplaced) {
  const opened = new Map(openDocuments.map(doc => [doc.path, doc]));
  const payload = changes.map(change => {
    const current = opened.get(change.path);
    if (current && current.content !== change.expectedContent) throw new Error(tr(`${change.path} は検索した後に編集されました．検索し直してください．`, `${change.path} was edited after the search. Search again before replacing.`));
    return { path: change.path, content: change.content, revision: current?.revision ?? change.revision };
  });
  let result;
  try { result = await api('/api/project/replace', { method: 'PUT', body: { changes: payload }, timeout: 60000 }); }
  catch (error) {
    if (error.data?.documents?.length) await onReplaced?.(error.data.documents, changes);
    throw error;
  }
  await onReplaced?.(result.documents || [], changes);
  return result;
}

export function createProjectSearch({ api, getOpenDocuments, openSource, replaceDocuments, onError }) {
  const dialog = element('dialog', 'dialog writing-dialog project-search-dialog');
  dialog.id = 'project-search-dialog'; dialog.dataset.testid = 'project-search-dialog';
  dialog.setAttribute('aria-labelledby', 'project-search-title');
  const heading = element('div', 'dialog-heading');
  const title = element('h2'); title.id = 'project-search-title';
  const close = element('button', 'icon-button', '×'); close.type = 'button'; close.dataset.testid = 'close-project-search';
  heading.append(title, close);
  const form = element('form', 'project-search-form');
  const queryLabel = element('label', 'field-label'); queryLabel.htmlFor = 'project-search-query';
  const query = element('textarea'); query.id = 'project-search-query'; query.dataset.testid = 'project-search-query'; query.rows = 2; query.required = true; query.spellcheck = false; query.maxLength = 4096;
  const replacementLabel = element('label', 'field-label'); replacementLabel.htmlFor = 'project-search-replacement';
  const replacement = element('textarea'); replacement.id = 'project-search-replacement'; replacement.dataset.testid = 'project-search-replacement'; replacement.rows = 2; replacement.spellcheck = false;
  const options = element('div', 'writing-options');
  const check = (id) => { const label = element('label'); const input = element('input'); input.type = 'checkbox'; input.id = id; input.dataset.testid = id; const text = element('span'); label.append(input, text); options.append(label); return { input, text }; };
  const matchCase = check('project-search-case'), regexp = check('project-search-regexp'), word = check('project-search-word');
  const help = element('p', 'field-help');
  const actions = element('div', 'writing-actions');
  const search = element('button', 'button button-primary'); search.type = 'submit'; search.dataset.testid = 'run-project-search';
  const cancel = element('button', 'button'); cancel.type = 'button'; cancel.hidden = true;
  const selectAll = element('button', 'button'); selectAll.type = 'button'; selectAll.dataset.testid = 'select-all-search-results';
  const replace = element('button', 'button'); replace.type = 'button'; replace.disabled = true; replace.dataset.testid = 'replace-project-selection';
  actions.append(search, cancel, selectAll, replace);
  form.append(queryLabel, query, replacementLabel, replacement, options, help, actions);
  const status = element('p', 'writing-status'); status.setAttribute('role', 'status'); status.dataset.testid = 'project-search-status';
  const results = element('div', 'project-search-results'); results.dataset.testid = 'project-search-results';
  dialog.append(heading, form, status, results); document.body.append(dialog);
  let files = [], selected = new Set(), controller = null, sequence = 0, replacing = false, lastOptions = '';

  function translate() {
    title.textContent = tr('プロジェクト全体を検索・置換', 'Search and replace across the project');
    close.setAttribute('aria-label', tr('閉じる', 'Close'));
    queryLabel.textContent = tr('検索する文字列', 'Find'); replacementLabel.textContent = tr('置換後の文字列', 'Replace with');
    matchCase.text.textContent = tr('大文字と小文字を区別', 'Match case'); regexp.text.textContent = tr('正規表現', 'Regular expression'); word.text.textContent = tr('単語単位', 'Whole word');
    help.textContent = tr('開いている原稿は編集中の内容を検索します．正規表現は RE2 を使用し，置換には $1 や ${name} を使えます．検索結果は最大 1000 件です．', 'Open documents use their current editor text. Regular expressions use RE2; replacements accept $1 or ${name}. Results are limited to 1000 matches.');
    search.textContent = tr('検索する', 'Search'); cancel.textContent = tr('検索を中止', 'Cancel search');
    selectAll.textContent = tr('すべて選択 / 解除', 'Select / clear all');
    replace.textContent = tr(`選択した ${selected.size} 箇所を置換`, `Replace ${selected.size} selected matches`);
  }
  const optionsValue = () => JSON.stringify({ query: query.value, replacement: replacement.value, caseSensitive: matchCase.input.checked, regexp: regexp.input.checked, wholeWord: word.input.checked });
  function showError(error) { status.textContent = error.message || String(error); status.classList.add('form-error'); }
  function showSourceError(error) {
    if (onError) { onError(error); return; }
    if (!dialog.open && dialog.isConnected) dialog.showModal();
    showError(error);
  }
  function updateSelection() {
    for (const box of results.querySelectorAll('input[data-match]')) box.checked = selected.has(box.dataset.match);
    replace.disabled = replacing || !selected.size || optionsValue() !== lastOptions;
    selectAll.disabled = replacing || !files.length;
    translate();
  }
  function invalidate() { replace.disabled = true; if (files.length) status.textContent = tr('条件が変わりました．検索し直すと置換できます．', 'The search options changed. Search again before replacing.'); }
  for (const input of [query, replacement, matchCase.input, regexp.input, word.input]) input.addEventListener('input', invalidate);
  function render() {
    results.replaceChildren();
    for (const file of files) {
      const group = element('section', 'project-search-file');
      const header = element('h3', 'project-search-file-heading', `${file.path} (${file.matches.length})`); group.append(header);
      file.matches.forEach((match, index) => {
        const row = element('div', 'project-search-match');
        const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.dataset.match = `${file.path}\0${index}`; checkbox.checked = selected.has(checkbox.dataset.match); checkbox.setAttribute('aria-label', tr(`${file.path} の ${match.line} 行目を置換`, `Replace the match at ${file.path}:${match.line}`));
        checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(checkbox.dataset.match) : selected.delete(checkbox.dataset.match); updateSelection(); });
        const details = element('div', 'project-search-match-detail');
        const location = element('button', 'writing-location', `${match.line}:${match.column}  ${match.snippet}`); location.type = 'button'; location.addEventListener('click', () => { dialog.close(); Promise.resolve().then(() => openSource(file.path, match.line, match.column, match.from, match.to)).catch(showSourceError); });
        const preview = element('div', 'replacement-preview');
        const before = element('code', 'replacement-before', compact(match.text)); const after = element('code', 'replacement-after', compact(match.replacement));
        before.setAttribute('aria-label', tr('変更前', 'Before')); after.setAttribute('aria-label', tr('変更後', 'After')); preview.append(before, element('span', 'replacement-arrow', '→'), after);
        details.append(location, preview); row.append(checkbox, details); group.append(row);
      });
      results.append(group);
    }
    updateSelection();
  }
  async function runSearch(event) {
    event?.preventDefault(); controller?.abort(); const request = ++sequence; controller = new AbortController();
    files = []; selected.clear(); render(); status.classList.remove('form-error'); status.textContent = tr('検索しています…', 'Searching…'); cancel.hidden = false; search.disabled = true;
    const parameters = JSON.parse(optionsValue()); lastOptions = optionsValue();
    try {
      const result = await api('/api/project/search', { method: 'POST', body: { ...parameters, documents: getOpenDocuments().filter(doc => doc.dirty !== false) }, signal: controller.signal, timeout: 30000 });
      if (request !== sequence || !dialog.open) return;
      files = result.files || []; render();
      status.textContent = tr(`${result.count} 件が ${files.length} ファイルで見つかりました．${result.scanned} ファイルを検索しました．`, `${result.count} matches in ${files.length} files; ${result.scanned} files searched.`);
      if (result.skipped) status.textContent += tr(` ${result.skipped} ファイルはサイズや文字コードなどのため対象外でした．`, ` ${result.skipped} files were skipped because of size, encoding, or access.`);
      if (result.limited) status.textContent += tr(' 上限に達しました．検索する文字列を詳しく指定してください．', ' A limit was reached. Use a more specific search.');
    } catch (error) { if (request === sequence && error.name !== 'AbortError') showError(error); }
    finally { if (request === sequence) { controller = null; cancel.hidden = true; search.disabled = false; } }
  }
  form.addEventListener('submit', runSearch);
  selectAll.addEventListener('click', () => {
    const count = files.reduce((sum, file) => sum + file.matches.length, 0);
    if (selected.size === count) selected.clear();
    else for (const file of files) file.matches.forEach((_, index) => selected.add(`${file.path}\0${index}`));
    updateSelection();
  });
  replace.addEventListener('click', async () => {
    if (replacing || optionsValue() !== lastOptions) return;
    try {
      const changes = replacementChanges(files, selected);
      if (!changes.length) { status.textContent = tr('変更する内容はありません．', 'The selected replacements make no changes.'); return; }
      replacing = true; close.disabled = true; search.disabled = true; updateSelection();
      const result = await replaceDocuments(changes);
      files = []; selected.clear(); render(); status.classList.remove('form-error');
      status.textContent = tr(`${result?.documents?.length ?? changes.length} ファイルを保存しました．`, `Saved ${result?.documents?.length ?? changes.length} files.`);
    } catch (error) { files = []; selected.clear(); render(); showError(error); }
    finally { replacing = false; close.disabled = false; search.disabled = false; updateSelection(); }
  });
  cancel.addEventListener('click', () => { ++sequence; controller?.abort(); controller = null; cancel.hidden = true; search.disabled = false; status.textContent = tr('検索を中止しました．', 'Search cancelled.'); });
  close.addEventListener('click', () => { if (!replacing) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (replacing) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++sequence; controller?.abort(); controller = null; cancel.hidden = true; search.disabled = false; });
  const unsubscribe = onLanguageChange(() => { translate(); if (dialog.open) render(); });
  translate();
  return {
    open(initialQuery) { if (initialQuery !== undefined) { query.value = String(initialQuery).slice(0, 4096); if (optionsValue() !== lastOptions) invalidate(); } updateSelection(); if (!dialog.open) dialog.showModal(); query.focus(); },
    close() { if (!replacing) dialog.close(); },
    destroy() { controller?.abort(); unsubscribe(); dialog.remove(); },
  };
}
