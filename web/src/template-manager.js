import { t, getLanguage } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';

function eligibleFiles(project) {
  const files = project?.files || [];
  const texNames = new Set(files.filter(file => /\.tex$/i.test(file.path)).map(file => file.path.slice(0, -4).toLowerCase()));
  return files.filter(file => {
    if (file.size > 8 * 1024 * 1024) return false;
    if (file.kind === 'text') return true;
    if (/\.pdf$/i.test(file.path) && texNames.has(file.path.slice(0, -4).toLowerCase())) return false;
    return file.kind === 'image' || file.kind === 'pdf' || /\.eps$/i.test(file.path);
  });
}

export function createTemplateManager({ api, getProject, saveAll, openProject, onError = () => {} }) {
  const ui = createImportDialog('template-dialog', 'テンプレートから始める');
  ui.dialog.classList.add('template-dialog');
  let templates = [], selected = '', deleteReady = false, picker = null, captureRoot = '';
  const list = element('div', { class: 'template-list', id: 'template-list', role: 'listbox', 'aria-label': t('テンプレート'), 'data-i18n-aria-label': 'テンプレート' });
  const description = element('p', { class: 'dialog-description', id: 'template-description' });
  const parent = labelledInput('template-parent', '保存先のフォルダー');
  const browse = translated('button', 'フォルダーを選ぶ', { type: 'button', class: 'button' });
  const folderRow = element('div', { class: 'template-folder-row' }); folderRow.append(parent.input, browse); parent.group.append(folderRow);
  const name = labelledInput('template-project-name', '新しいプロジェクトのフォルダー名', 'input', { value: 'new-project', maxlength: '120' });
  const create = translated('button', '作成して開く', { type: 'button', class: 'button button-primary', id: 'template-create-project' });
  const cancel = translated('button', '閉じる', { type: 'button', class: 'button' });
  ui.footer.append(cancel, create);
  cancel.onclick = () => ui.close();
  const userDetails = element('details', { class: 'template-section', id: 'template-manage' });
  userDetails.append(translated('summary', '選んだテンプレートを編集する'));
  const editName = labelledInput('template-edit-name', 'テンプレートの名前', 'input', { maxlength: '80' });
  const editDescription = labelledInput('template-edit-description', '説明 (省略可)', 'textarea', { rows: '2', maxlength: '1000' });
  const update = translated('button', '名前と説明を保存', { type: 'button', class: 'button', id: 'template-update' });
  const remove = translated('button', 'テンプレートを削除', { type: 'button', class: 'button button-stop', id: 'template-delete' });
  const deleteNote = translated('p', 'もう一度押すと，選んだテンプレートの登録を削除します．', { class: 'field-help', hidden: '' });
  const editActions = element('div', { class: 'template-actions' }); editActions.append(update, remove);
  userDetails.append(editName.group, editDescription.group, editActions, deleteNote);

  const captureDetails = element('details', { class: 'template-section', id: 'template-capture' });
  captureDetails.append(translated('summary', '現在のプロジェクトをテンプレートに追加する'));
  const captureHelp = translated('p', '保存した原稿と，選んだ画像を登録します．生成した PDF，補助ファイル，編集履歴は含めません．1 個あたり 200 ファイル・合計 32 MiB，登録数は 20 個までです．', { class: 'field-help' });
  const captureName = labelledInput('template-capture-name', 'テンプレートの名前', 'input', { maxlength: '80' });
  const captureDescription = labelledInput('template-capture-description', '説明 (省略可)', 'textarea', { rows: '2', maxlength: '1000' });
  const captureFiles = element('div', { class: 'template-files', id: 'template-files' });
  const captureCount = element('p', { class: 'field-help', id: 'template-file-count', role: 'status' });
  const selectAll = translated('button', 'すべて選ぶ', { type: 'button', class: 'button button-small' });
  const selectNone = translated('button', '選択を解除する', { type: 'button', class: 'button button-small' });
  const fileActions = element('div', { class: 'template-actions' }); fileActions.append(selectAll, selectNone);
  const capture = translated('button', '保存してテンプレートに追加', { type: 'button', class: 'button', id: 'template-save-current' });
  captureDetails.append(captureHelp, captureName.group, captureDescription.group, fileActions, captureCount, captureFiles, capture);
  ui.body.append(list, description, parent.group, name.group, userDetails, captureDetails);

  const entry = () => templates.find(item => item.id === selected);
  const selectedPaths = () => [...captureFiles.querySelectorAll('input:checked')].map(input => input.value);
  function countFiles() {
    const paths = selectedPaths();
    captureCount.textContent = t('{count} 個のファイルを選択しています', { count: paths.length });
    capture.disabled = paths.length === 0 || paths.length > 200;
  }
  function renderSelection() {
    const item = entry();
    description.textContent = item ? `${item.description}\n${t('{count} ファイル', { count: item.fileCount })} · ${(item.bytes / 1024).toFixed(0)} KiB` : '';
    userDetails.hidden = !item || item.builtin;
    editName.input.value = item?.name || ''; editDescription.input.value = item?.description || '';
    deleteReady = false; deleteNote.hidden = true;
    for (const button of list.querySelectorAll('[data-template-id]')) {
      const active = button.dataset.templateId === selected;
      button.classList.toggle('selected', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    }
    create.disabled = !item;
  }
  function renderList() {
    list.replaceChildren();
    if (!templates.some(item => item.id === selected)) selected = templates[0]?.id || '';
    for (const item of templates) {
      const button = element('button', { type: 'button', class: 'template-card', 'data-template-id': item.id, role: 'option' });
      button.append(element('strong', {}, item.name), translated('span', item.builtin ? '標準のテンプレート' : '自分のテンプレート', { class: 'field-help' }));
      button.onclick = () => { selected = item.id; renderSelection(); };
      list.append(button);
    }
    renderSelection();
  }
  list.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let index = templates.findIndex(item => item.id === selected);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = templates.length - 1;
    else index = Math.max(0, Math.min(templates.length - 1, index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)));
    selected = templates[index]?.id || ''; renderSelection(); list.querySelector('[aria-selected="true"]')?.focus();
  });
  function renderFiles() {
    const project = getProject();
    captureRoot = project?.root || '';
    captureDetails.hidden = !project;
    captureFiles.replaceChildren();
    if (!project) return;
    const files = eligibleFiles(project);
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const row = element('label', { class: 'checkbox-field' });
      const input = element('input', { type: 'checkbox', value: file.path, ...(files.length <= 200 ? { checked: '' } : {}) });
      row.append(input, element('span', {}, file.path)); fragment.append(row);
    }
    captureFiles.append(fragment);
    selectAll.disabled = files.length > 200;
    captureName.input.value = project.root.split(/[\\/]/).filter(Boolean).pop() || '';
    captureDescription.input.value = '';
    countFiles();
  }
  captureFiles.addEventListener('change', countFiles);
  selectAll.onclick = () => { for (const input of captureFiles.querySelectorAll('input')) input.checked = true; countFiles(); };
  selectNone.onclick = () => { for (const input of captureFiles.querySelectorAll('input')) input.checked = false; countFiles(); };
  async function load() {
    const result = await api('/api/templates');
    templates = result.templates || []; renderList();
  }

  browse.onclick = async () => {
    if (picker) { picker.abort(); return; }
    picker = new AbortController();
    browse.textContent = t('フォルダーの選択を取り消す');
    ui.clearError();
    try {
      const result = await api('/api/project/pick', { method: 'POST', body: {}, timeout: 0, signal: picker.signal });
      if (result?.path) parent.input.value = result.path;
    } catch (error) { if (error.name !== 'AbortError') ui.showError(error); }
    finally { picker = null; browse.textContent = t('フォルダーを選ぶ'); }
  };
  ui.dialog.addEventListener('close', () => { picker?.abort(); });
  create.onclick = () => ui.run(async () => {
    if (picker) throw new Error(t('フォルダーの選択を終えてから作成してください．'));
    if (!entry()) return false;
    if (!parent.input.value.trim() || !name.input.value.trim()) throw new Error(t('保存先と新しいフォルダー名を入力してください．'));
    const result = await api('/api/templates/create-project', { method: 'POST', body: { id: selected, parent: parent.input.value.trim(), name: name.input.value.trim() }, timeout: 30000 });
    ui.dialog.close();
    try { await openProject(result.path); }
    catch (error) { onError(error); }
    return true;
  });
  capture.onclick = () => ui.run(async () => {
    const paths = selectedPaths();
    if (!paths.length || paths.length > 200) throw new Error(t('登録するファイルを 1〜200 個選んでください．'));
    if (!captureName.input.value.trim()) throw new Error(t('テンプレートの名前を入力してください．'));
    await saveAll();
    const item = await api('/api/templates', { method: 'POST', body: { name: captureName.input.value.trim(), description: captureDescription.input.value, paths }, timeout: 30000, projectRoot: captureRoot });
    selected = item.id; await load(); captureDetails.open = false;
  });
  update.onclick = () => ui.run(async () => {
    if (!entry() || entry().builtin) return;
    await api('/api/templates', { method: 'PATCH', body: { id: selected, name: editName.input.value.trim(), description: editDescription.input.value }, timeout: 30000 });
    await load(); userDetails.open = false;
  });
  remove.onclick = () => {
    if (!deleteReady) { deleteReady = true; deleteNote.hidden = false; return; }
    ui.run(async () => {
      await api('/api/templates', { method: 'DELETE', body: { id: selected } });
      selected = ''; await load(); userDetails.open = false;
    });
  };
  async function open() {
    ui.open(); renderFiles(); userDetails.open = false; captureDetails.open = false;
    const root = getProject()?.root || '';
    parent.input.value = root ? root.replace(/[\\/][^\\/]+[\\/]?$/, '') : '';
    if (/^[A-Za-z]:$/.test(parent.input.value)) parent.input.value += '\\';
    if (root.startsWith('/') && !parent.input.value) parent.input.value = '/';
    name.input.value = getLanguage() === 'ja' ? '新しい原稿' : 'new-project';
    await ui.run(load);
  }
  return { open, destroy() { picker?.abort(); ui.destroy(); } };
}
