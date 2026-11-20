import { onLanguageChange, t } from './i18n.js';

const basename = value => String(value || '').split(/[\\/]/).at(-1) || '';

export function fileTemplatePathSuggestion({ current = '', folder = '', templatePath = '', previousSuggestion = '', edited = false } = {}) {
  if (edited || !templatePath) return current;
  const parent = String(folder).replace(/\\/g, '/').replace(/\/+$/, ''), prefix = parent ? `${parent}/` : '';
  if (current !== '' && current !== prefix && current !== previousSuggestion) return current;
  const name = basename(templatePath);
  return name ? prefix + name : current;
}

export function fileTemplatePreview(content, limit = 60_000) {
  const value = String(content ?? '');
  if (!Number.isFinite(limit) || limit < 1 || value.length <= limit) return { content: value, truncated: false };
  let end = Math.floor(limit);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { content: value.slice(0, end), truncated: true };
}

export function createFileTemplatePicker({ host, pathInput, api, onChange = () => {} }) {
  const document = host.ownerDocument, dialog = host.closest('dialog');
  const make = (tag, className = '', id = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (id) node.id = id;
    return node;
  };
  host.classList.add('file-template-picker');
  const templateLabel = make('label', 'field-label'), templateSelect = make('select', '', 'new-file-template');
  templateLabel.htmlFor = templateSelect.id;
  const fileGroup = make('div', 'file-template-file'), fileLabel = make('label', 'field-label'), fileSelect = make('select', '', 'new-file-template-file');
  fileLabel.htmlFor = fileSelect.id; fileGroup.append(fileLabel, fileSelect);
  const description = make('p', 'field-help file-template-description');
  const note = make('p', 'field-help', 'new-file-template-note');
  const status = make('p', 'field-help file-template-status', 'new-file-template-status'); status.setAttribute('role', 'status');
  const error = make('p', 'form-error file-template-error', 'new-file-template-error'); error.setAttribute('role', 'alert');
  const retry = make('button', 'button button-small file-template-retry', 'new-file-template-retry'); retry.type = 'button';
  const previewGroup = make('section', 'file-template-preview'), previewTitle = make('h3', '', 'new-file-template-preview-title');
  const preview = make('pre', '', 'new-file-template-preview'), code = make('code'); preview.append(code); preview.tabIndex = 0;
  preview.setAttribute('aria-labelledby', previewTitle.id);
  const previewNote = make('p', 'field-help file-template-preview-note');
  previewGroup.append(previewTitle, preview, previewNote);
  templateSelect.setAttribute('aria-describedby', `${note.id} ${status.id}`);
  fileSelect.setAttribute('aria-describedby', `${note.id} ${status.id}`);
  host.replaceChildren(templateLabel, templateSelect, description, fileGroup, note, status, error, retry, previewGroup);

  let templates = [], files = [], templateId = '', selectedPath = '', selectedDocument = null, details = null;
  let folder = '', edited = false, previousSuggestion = '', busy = false, active = false, disposed = false;
  let catalogLoading = false, filesLoading = false, contentLoading = false, catalogError = null, selectionError = null;
  let generation = 0, catalogSequence = 0, filesSequence = 0, contentSequence = 0;
  let catalogController = null, filesController = null, contentController = null;

  function state() {
    const loading = filesLoading || contentLoading;
    const ready = !templateId || !loading && !selectionError && selectedDocument?.path === selectedPath;
    return { ready: Boolean(ready) && !busy, loading, templateId, path: selectedPath };
  }

  function notify() { onChange(state()); }

  function renderCatalog() {
    templateSelect.replaceChildren();
    const blank = make('option'); blank.value = ''; blank.textContent = t('空のファイル'); templateSelect.append(blank);
    for (const builtin of [true, false]) {
      const group = make('optgroup'); group.label = t(builtin ? '標準のテンプレート' : '自分のテンプレート');
      for (const item of templates.filter(item => Boolean(item.builtin) === builtin)) {
        const option = make('option'); option.value = item.id; option.textContent = item.name; group.append(option);
      }
      if (group.children.length) templateSelect.append(group);
    }
    if (templateId && !templates.some(item => item.id === templateId)) {
      const option = make('option'); option.value = templateId; option.textContent = details?.name || templateId; templateSelect.append(option);
    }
    templateSelect.value = templateId;
  }

  function renderFiles() {
    fileSelect.replaceChildren();
    for (const file of files) {
      const option = make('option'); option.value = file.path; option.textContent = file.path; fileSelect.append(option);
    }
    fileSelect.value = selectedPath;
  }

  function render() {
    templateLabel.textContent = t('最初の内容'); fileLabel.textContent = t('テンプレート内のファイル');
    note.textContent = t('テンプレートから選んだテキストファイル 1 個を，入力したパスに作成します．');
    previewTitle.textContent = t('作成する原稿の内容'); retry.textContent = t('もう一度読み込む');
    templateSelect.disabled = busy || catalogLoading && templates.length === 0;
    fileGroup.hidden = !templateId; fileSelect.disabled = busy || filesLoading || files.length === 0;
    note.hidden = !templateId;
    const item = templates.find(item => item.id === templateId) || details;
    description.textContent = templateId ? item?.description || '' : ''; description.hidden = !description.textContent;
    if (filesLoading) status.textContent = t('テンプレート内のファイルを読み込み中…');
    else if (contentLoading) status.textContent = t('原稿の内容を読み込み中…');
    else if (templateId && !files.length && !selectionError) status.textContent = t('このテンプレートには編集できるテキストファイルがありません．');
    else if (!templateId) status.textContent = t('空のファイルを作成します．');
    else status.textContent = '';
    status.hidden = !status.textContent;
    const failure = selectionError || catalogError;
    error.textContent = failure ? failure.message || String(failure) : '';
    error.hidden = !failure; retry.hidden = !failure; retry.disabled = busy || filesLoading || contentLoading || catalogLoading;
    previewGroup.hidden = !selectedDocument;
    if (selectedDocument) {
      const sample = fileTemplatePreview(selectedDocument.content);
      code.textContent = sample.content;
      previewNote.hidden = !sample.truncated;
      previewNote.textContent = sample.truncated ? t('原稿の先頭 {count} 文字を表示しています．作成時は全文を使います．', { count: sample.content.length.toLocaleString() }) : '';
    } else { code.textContent = ''; previewNote.hidden = true; }
    host.setAttribute('aria-busy', String(filesLoading || contentLoading));
  }

  function abortSelection() {
    filesSequence++; contentSequence++;
    filesController?.abort(); contentController?.abort(); filesController = null; contentController = null;
    filesLoading = false; contentLoading = false;
  }

  function suggestPath() {
    const next = fileTemplatePathSuggestion({ current: pathInput.value, folder, templatePath: selectedPath, previousSuggestion, edited });
    if (next !== pathInput.value) { pathInput.value = next; previousSuggestion = next; }
  }

  async function loadContent(path) {
    contentController?.abort(); contentController = new AbortController();
    const controller = contentController, sequence = ++contentSequence, currentGeneration = generation, id = templateId;
    selectedPath = path; selectedDocument = null; selectionError = null; contentLoading = true;
    suggestPath(); renderFiles(); render(); notify();
    try {
      const result = await api(`/api/templates/files?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`, { signal: controller.signal, projectRoot: null, timeout: 30000 });
      if (!active || disposed || currentGeneration !== generation || sequence !== contentSequence || id !== templateId) return;
      if (result.id !== id || result.path !== path || typeof result.content !== 'string') throw new Error(t('テンプレートの内容を読み取れませんでした．'));
      selectedDocument = { templateId: id, templatePath: path, path, name: basename(result.name || path), content: result.content };
    } catch (error) {
      if (!active || disposed || currentGeneration !== generation || sequence !== contentSequence || controller.signal.aborted) return;
      selectionError = error;
    } finally {
      if (active && !disposed && currentGeneration === generation && sequence === contentSequence) {
        contentLoading = false; contentController = null; render(); notify();
      }
    }
  }

  async function loadFiles(id) {
    abortSelection();
    const controller = new AbortController(); filesController = controller;
    const sequence = ++filesSequence, currentGeneration = generation;
    selectedDocument = null; selectedPath = ''; files = []; details = null; selectionError = null; filesLoading = true;
    renderFiles(); render(); notify();
    try {
      const result = await api(`/api/templates/files?id=${encodeURIComponent(id)}`, { signal: controller.signal, projectRoot: null, timeout: 30000 });
      if (!active || disposed || currentGeneration !== generation || sequence !== filesSequence || id !== templateId) return;
      files = (result.files || []).filter(file => typeof file?.path === 'string' && file.path);
      details = result.template || null; filesLoading = false; filesController = null;
      selectedPath = files.find(file => file.path === details?.main)?.path || files[0]?.path || '';
      if (selectedPath) { await loadContent(selectedPath); return; }
    } catch (error) {
      if (!active || disposed || currentGeneration !== generation || sequence !== filesSequence || controller.signal.aborted) return;
      selectionError = error;
    } finally {
      if (active && !disposed && currentGeneration === generation && sequence === filesSequence) {
        filesLoading = false; filesController = null; renderFiles(); render(); notify();
      }
    }
  }

  async function loadCatalog() {
    catalogController?.abort();
    const controller = new AbortController(); catalogController = controller;
    const sequence = ++catalogSequence, currentGeneration = generation;
    catalogLoading = true; catalogError = null; render(); notify();
    try {
      const result = await api('/api/templates', { signal: controller.signal, projectRoot: null, timeout: 30000 });
      if (!active || disposed || currentGeneration !== generation || sequence !== catalogSequence) return;
      templates = (result.templates || []).filter(item => typeof item?.id === 'string' && item.id && typeof item.name === 'string');
      renderCatalog();
    } catch (error) {
      if (!active || disposed || currentGeneration !== generation || sequence !== catalogSequence || controller.signal.aborted) return;
      catalogError = new Error(t('テンプレートを読み込めませんでした．空のファイルは作成できます．') + ' ' + (error.message || String(error)));
    } finally {
      if (active && !disposed && currentGeneration === generation && sequence === catalogSequence) {
        catalogLoading = false; catalogController = null; render(); notify();
      }
    }
  }

  function selectTemplate() {
    if (busy) return;
    templateId = templateSelect.value; selectedPath = ''; selectedDocument = null; selectionError = null; details = null; files = [];
    abortSelection();
    if (templateId) void loadFiles(templateId);
    else { renderFiles(); render(); notify(); }
  }

  function selectFile() { if (!busy && fileSelect.value) void loadContent(fileSelect.value); }
  function editPath() { edited = true; }
  function retryLoad() {
    if (busy) return;
    if (selectionError && templateId) { if (selectedPath) void loadContent(selectedPath); else void loadFiles(templateId); }
    else void loadCatalog();
  }
  function close() {
    active = false; generation++; catalogSequence++;
    catalogController?.abort(); catalogController = null; catalogLoading = false; abortSelection();
  }
  function onDialogClose() { if (!dialog?.open) close(); }

  templateSelect.addEventListener('change', selectTemplate); fileSelect.addEventListener('change', selectFile);
  pathInput.addEventListener('input', editPath); retry.addEventListener('click', retryLoad); dialog?.addEventListener('close', onDialogClose);
  const removeLanguageListener = onLanguageChange(() => { renderCatalog(); render(); if (active) void loadCatalog(); });
  renderCatalog(); render();
  return {
    reset({ folder: nextFolder = '' } = {}) {
      close(); active = true; busy = false; folder = nextFolder;
      templateId = ''; selectedPath = ''; selectedDocument = null; details = null; files = []; templates = []; catalogError = null; selectionError = null;
      const prefix = folder ? `${String(folder).replace(/\\/g, '/').replace(/\/+$/, '')}/` : '';
      edited = pathInput.value !== '' && pathInput.value !== prefix;
      previousSuggestion = pathInput.value; renderCatalog(); renderFiles(); render(); notify();
      void loadCatalog();
    },
    getValue() {
      if (!templateId) return { content: '', templateId: '', templatePath: '', name: '' };
      if (filesLoading || contentLoading) throw new Error(t('テンプレートの読込みが終わってから作成してください．'));
      if (selectionError) throw selectionError;
      if (!selectedDocument || selectedDocument.path !== selectedPath) throw new Error(t('作成するテキストファイルを選んでください．'));
      return { ...selectedDocument };
    },
    getState: state,
    setBusy(value) { busy = Boolean(value); render(); notify(); },
    destroy() {
      if (disposed) return;
      close(); disposed = true; removeLanguageListener();
      templateSelect.removeEventListener('change', selectTemplate); fileSelect.removeEventListener('change', selectFile);
      pathInput.removeEventListener('input', editPath); retry.removeEventListener('click', retryLoad); dialog?.removeEventListener('close', onDialogClose);
      host.replaceChildren();
    },
  };
}
