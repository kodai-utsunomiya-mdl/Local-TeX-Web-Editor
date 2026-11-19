import { getLanguage, onLanguageChange } from './i18n.js';
import { extractReferenceTokens, referenceAt, planReferenceRename, validReferenceKey } from './references-data.js';

const labels = {
  title: ['引用と相互参照', 'Citations and references'], close: ['閉じる', 'Close'], search: ['キー，題名，著者を検索', 'Find a key, title, or author'],
  loading: ['プロジェクトの引用と参照を調べています…', 'Reading citations and references in the project…'],
  empty: ['引用やラベルが見つかりません．', 'No citations or labels were found.'],
  select: ['キーを選ぶと，定義と使用箇所を表示します．', 'Choose a key to see its definition and uses.'],
  definition: ['定義', 'Definitions'], uses: ['使用箇所', 'Uses'], citation: ['文献', 'Citation'], label: ['ラベル', 'Label'],
  missing: ['このプロジェクト内に定義がありません．', 'This key has no definition in the project.'],
  unused: ['標準的な引用・参照コマンドでの使用は見つかりません．', 'No uses in standard citation or reference commands were found.'],
  rename: ['キーの名前を変更', 'Rename the key'], newKey: ['新しいキー', 'New key'], preview: ['変更内容を確認', 'Preview changes'], apply: ['確認した変更を適用', 'Apply these changes'],
  current: ['変更前', 'Before'], changed: ['変更後', 'After'],
  changes: ['変更内容', 'Changes'],
  invalid: ['新しいキーには文字，数字，: . _ / + @ - を使えます．現在と異なる名前を入力してください．', 'Use letters, digits, or : . _ / + @ - and choose a different key.'],
  duplicate: ['このキーの定義が複数あります．定義を開いて名前を確認してください．', 'This key has multiple definitions. Open them to check their names.'],
  collision: ['入力したキーは，すでに別の定義で使われています．', 'Another definition already uses this key.'],
  limit: ['一部のファイルが大きいため，表示する範囲を制限しています．名前の変更は，全体を確認できるプロジェクトで利用できます．', 'Some files exceed the reading limits. Renaming is available when the whole project can be checked.'],
  scope: ['標準的な引用・参照コマンドを対象にします．コメント，コード例，自作コマンドの定義はそのままになります．', 'This covers standard citation and reference commands. Comments, code examples, and custom command definitions stay as written.'],
  done: ['キーの名前を変更しました．', 'The key was renamed.'], refresh: ['一覧を更新', 'Refresh'],
  more: ['表示は先頭の 500 件です．検索する語を追加して絞り込めます．', 'Showing the first 500 keys. Add search terms to narrow the list.'],
  moreUses: ['先頭の 500 箇所を表示しています．', 'Showing the first 500 locations.'],
  moreChanges: ['次の 200 行を表示', 'Show the next 200 lines'],
};
const text = key => labels[key]?.[getLanguage() === 'ja' ? 0 : 1] || key;
const make = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = value; return node; };

export function createReferenceTools({ getFiles, readFile, getCurrent, onOpen, onApply, onError }) {
  const dialog = make('dialog', 'dialog reference-dialog'); dialog.dataset.testid = 'reference-dialog';
  dialog.setAttribute('aria-labelledby', 'reference-title');
  const heading = make('div', 'dialog-heading'), title = make('h2'); title.id = 'reference-title';
  const close = make('button', 'icon-button', '×'); close.type = 'button'; close.dataset.testid = 'reference-close';
  heading.append(title, close);
  const searchRow = make('div', 'reference-search-row');
  const search = make('input'); search.type = 'search'; search.dataset.testid = 'reference-search'; search.autocomplete = 'off'; search.spellcheck = false;
  const refresh = make('button', 'button'); refresh.type = 'button';
  searchRow.append(search, refresh);
  const status = make('p', 'field-help reference-status'); status.setAttribute('role', 'status');
  const columns = make('div', 'reference-columns'), list = make('div', 'reference-key-list'), detail = make('section', 'reference-details');
  columns.append(list, detail);
  dialog.append(heading, searchRow, status, columns); document.body.append(dialog);
  let files = [], tokens = [], selected = null, busy = false, complete = true, generation = 0, plan = null;
  const perform = action => Promise.resolve().then(action).catch(error => { if (dialog.open) { status.textContent = error.message || String(error); status.classList.add('error'); } onError?.(error); });

  function language() {
    title.textContent = text('title'); close.setAttribute('aria-label', text('close'));
    search.placeholder = search.ariaLabel = text('search'); refresh.textContent = text('refresh');
    if (!busy) { renderKeys(); renderDetails(); status.textContent = complete ? text('scope') : text('limit'); }
    else status.textContent = text('loading');
  }

  function renderKeys() {
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const groups = new Map();
    for (const item of tokens) {
      const id = `${item.kind}:${item.key}`;
      const previous = groups.get(id);
      if (!previous || item.role === 'definition') groups.set(id, item);
    }
    let count = 0;
    for (const item of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      if (query && ![item.key, item.title, item.author, item.year, item.context].join(' ').toLocaleLowerCase().includes(query)) continue;
      if (count++ >= 500) { list.append(make('p', 'field-help', text('more'))); break; }
      const button = make('button', 'reference-key'); button.type = 'button';
      button.dataset.referenceKey = item.key; button.dataset.kind = item.kind;
      button.classList.toggle('selected', selected?.key === item.key && selected?.kind === item.kind);
      button.append(make('strong', '', item.key), make('span', 'field-help', [text(item.kind), item.title || item.context].filter(Boolean).join(' · ')));
      button.addEventListener('click', () => { selected = { kind: item.kind, key: item.key }; plan = null; renderKeys(); renderDetails(); });
      list.append(button);
    }
    if (!list.childElementCount) list.append(make('p', 'field-help', text('empty')));
  }

  function sourcePreview(item) {
    const file = files.find(file => file.path === item.path);
    if (!file) return '';
    const lines = file.lines ||= file.content.split('\n');
    return lines.slice(Math.max(0, item.line - 3), item.line + 3).join('\n').slice(0, 1400);
  }

  function location(item) {
    const block = make('div', 'reference-location');
    const button = make('button', 'button button-small', `${item.path}:${item.line}`); button.type = 'button';
    button.addEventListener('click', () => perform(async () => { dialog.close(); await onOpen(item.path, item.line, item.column, item.from); }));
    block.append(button);
    const description = [item.title, item.author, item.year, item.context].filter(Boolean).join(' · ');
    if (description) block.append(make('p', 'reference-description', description));
    block.append(make('pre', 'reference-excerpt', sourcePreview(item)));
    return block;
  }

  function renderDetails({ focusChanges = false } = {}) {
    detail.replaceChildren();
    if (!selected) { detail.append(make('p', 'field-help', text('select'))); return; }
    const matches = tokens.filter(item => item.kind === selected.kind && item.key === selected.key);
    const definitions = matches.filter(item => item.role === 'definition'), uses = matches.filter(item => item.role === 'use');
    detail.append(make('h3', 'reference-selected-key', selected.key), make('h4', '', `${text('definition')} (${definitions.length})`));
    if (!definitions.length) detail.append(make('p', 'field-help', text('missing')));
    for (const item of definitions.slice(0, 500)) detail.append(location(item));
    if (definitions.length > 500) detail.append(make('p', 'field-help', text('moreUses')));
    detail.append(make('h4', '', `${text('uses')} (${uses.length})`));
    if (!uses.length) detail.append(make('p', 'field-help', text('unused')));
    for (const item of uses.slice(0, 500)) detail.append(location(item));
    if (uses.length > 500) detail.append(make('p', 'field-help', text('moreUses')));
    const rename = make('section', 'reference-rename'); rename.append(make('h4', '', text('rename')));
    const form = make('form', 'reference-rename-form');
    const label = make('label', 'field-label', text('newKey')); label.htmlFor = 'reference-new-key';
    const input = make('input'); input.id = 'reference-new-key'; input.dataset.testid = 'reference-new-key'; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = plan?.[0]?.changes?.[0]?.insert || selected.key;
    const preview = make('button', 'button', text('preview')); preview.type = 'submit'; preview.dataset.testid = 'reference-preview-rename';
    preview.disabled = !complete || definitions.length !== 1 || busy;
    const error = make('p', 'form-error'); error.setAttribute('role', 'alert');
    if (definitions.length > 1) error.textContent = text('duplicate');
    form.append(label, input, preview, error); rename.append(form); detail.append(rename);
    form.addEventListener('submit', event => {
      event.preventDefault(); error.textContent = '';
      const nextKey = input.value.trim();
      if (!validReferenceKey(nextKey) || nextKey === selected.key) { error.textContent = text('invalid'); return; }
      if (tokens.some(item => item.kind === selected.kind && item.key === nextKey && item.role === 'definition')) { error.textContent = text('collision'); return; }
      try { plan = planReferenceRename(files, selected.kind, selected.key, nextKey); renderDetails({ focusChanges: true }); }
      catch (caught) { error.textContent = caught.message; }
    });
    if (plan) {
      const previewList = make('section', 'reference-change-list'); previewList.dataset.testid = 'reference-change-list';
      const changesTitle = make('h4', 'reference-change-title', text('changes'));
      changesTitle.id = 'reference-change-title'; changesTitle.tabIndex = -1; changesTitle.dataset.testid = 'reference-change-heading';
      previewList.setAttribute('aria-labelledby', changesTitle.id); previewList.append(changesTitle);
      const more = make('button', 'button button-small', text('moreChanges')); more.type = 'button';
      const changes = (function* () {
        for (const file of plan) {
          const before = file.before.split('\n'), after = file.content.split('\n');
          for (const line of new Set(file.changes.map(change => change.line))) yield { file, line, before: before[line - 1], after: after[line - 1] };
        }
      })();
      let shownFile = null;
      const showChanges = () => {
        for (let count = 0; count < 200; count++) {
          const next = changes.next();
          if (next.done) { more.hidden = true; break; }
          const { file, line, before, after } = next.value;
          if (shownFile !== file) { previewList.append(make('h4', '', `${file.path} (${file.changes.length})`)); shownFile = file; }
          const row = make('div', 'reference-change-row');
          row.append(make('span', 'field-help', String(line)), make('del', '', before), make('ins', '', after));
          previewList.append(row);
        }
      };
      more.addEventListener('click', showChanges); showChanges();
      const apply = make('button', 'button button-primary', text('apply')); apply.type = 'button'; apply.dataset.testid = 'reference-apply-rename';
      apply.addEventListener('click', () => perform(async () => {
        if (busy || !plan) return;
        busy = true; apply.disabled = true; refresh.disabled = true;
        try {
          const nextKey = plan[0].changes[0].insert;
          await onApply(plan);
          selected = { kind: selected.kind, key: nextKey };
          plan = null;
          await load();
          status.textContent = text('done');
        } finally { busy = false; apply.disabled = false; refresh.disabled = false; }
      }));
      rename.append(previewList, more, apply);
      if (focusChanges) requestAnimationFrame(() => {
        if (!dialog.open || !changesTitle.isConnected) return;
        changesTitle.focus({ preventScroll: true });
        const top = detail.scrollTop + changesTitle.getBoundingClientRect().top - detail.getBoundingClientRect().top - 8;
        detail.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      });
    }
  }

  async function load(preferred = null) {
    const request = ++generation; busy = true; refresh.disabled = true; complete = true; plan = null;
    status.classList.remove('error'); status.textContent = text('loading'); list.replaceChildren(); detail.replaceChildren();
    let bytes = 0; const loaded = [];
    files = []; tokens = [];
    try {
      const all = (await getFiles()).map(file => typeof file === 'string' ? { path: file } : file).filter(file => /\.(tex|bib|sty|cls|ltx)$/i.test(file.path));
      if (all.length > 1000) complete = false;
      for (const file of all.slice(0, 1000)) {
        if (request !== generation || !dialog.open) return;
        if (file.size > 2 * 1024 * 1024 || bytes >= 24 * 1024 * 1024) { complete = false; continue; }
        const data = await readFile(file.path), content = typeof data === 'string' ? data : data.content;
        if (typeof content !== 'string') { complete = false; continue; }
        if (content.length > 2 * 1024 * 1024) { complete = false; continue; }
        bytes += content.length;
        loaded.push({ path: file.path, content, revision: data.revision });
      }
      if (request !== generation || !dialog.open) return;
      files = loaded;
      tokens = files.flatMap(file => extractReferenceTokens(file.content, file.path));
      if (preferred) {
        const current = referenceAt(tokens.filter(item => item.path === preferred.path), preferred.position);
        if (current) selected = { kind: current.kind, key: current.key };
      }
      if (selected && !tokens.some(item => item.key === selected.key && item.kind === selected.kind)) selected = null;
    } catch (error) {
      complete = false;
      throw error;
    } finally {
      if (request === generation) { busy = false; refresh.disabled = false; language(); }
    }
  }

  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; busy = false; refresh.disabled = false; });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  search.addEventListener('input', renderKeys);
  refresh.addEventListener('click', () => perform(() => load()));
  const unsubscribe = onLanguageChange(language); language();
  return {
    async open(preferred = getCurrent?.()) {
      if (!dialog.open) dialog.showModal();
      search.focus();
      await perform(() => load(preferred));
    },
    close: () => dialog.close(),
    destroy: () => { generation++; unsubscribe(); dialog.remove(); },
  };
}
