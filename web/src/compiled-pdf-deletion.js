import { onLanguageChange, t } from './i18n.js';
import { compiledPDFName } from './compiled-pdfs.js';

export function createCompiledPDFDeletion({ api, getProjectRoot, isBlocked, begin, end, onChanged, onState, onNotice, getFallbackFocus = () => null }) {
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const dialog = make('dialog', 'dialog compiled-pdf-delete-dialog');
  dialog.id = 'compiled-pdf-delete-dialog'; dialog.setAttribute('aria-labelledby', 'compiled-pdf-delete-title');
  const form = make('form'), heading = make('div', 'dialog-heading'), title = make('h2');
  title.id = 'compiled-pdf-delete-title';
  const close = make('button', 'icon-button', '×'); close.type = 'button';
  heading.append(title, close);
  const body = make('div', 'compiled-pdf-delete-body');
  const name = make('p', 'compiled-pdf-delete-name'), source = make('p', 'compiled-pdf-delete-source');
  const help = make('p', 'field-help'), originals = make('p', 'field-help');
  const entries = make('details', 'compiled-pdf-delete-entries'), summary = make('summary'), list = make('ul');
  entries.append(summary, list);
  const error = make('p', 'form-error'); error.role = 'alert'; error.hidden = true;
  body.append(name, source, help, originals, entries, error);
  const footer = make('div', 'dialog-actions'), cancel = make('button', 'button'), submit = make('button', 'button button-stop');
  cancel.type = 'button'; submit.type = 'submit'; submit.id = 'compiled-pdf-delete-confirm';
  footer.append(cancel, submit); form.append(heading, body, footer); dialog.append(form); document.body.append(dialog);
  let inspection = null, projectRoot = '', busy = false, locked = false, settle = null, returnFocus = null;

  function language() {
    title.textContent = t('コンパイルした PDF を削除しますか？');
    close.ariaLabel = t('閉じる'); cancel.textContent = t('キャンセル'); submit.textContent = t('削除');
    if (!inspection) return;
    name.textContent = compiledPDFName(inspection);
    source.textContent = t('コンパイル元: {main}', { main: inspection.main });
    help.textContent = t('この TeX のコンパイル結果と補助ファイル，過去の結果を含む表示用の PDF を削除します．再コンパイルすると，PDF を作成できます．');
    originals.textContent = t('原稿と，通常のファイルとして保存・コピーした PDF はそのままです．');
    summary.textContent = t('削除するファイル: {count} 個', { count: inspection.fileCount });
    list.replaceChildren();
    for (const entry of inspection.entries || []) {
      const area = entry.area === 'build' ? t('コンパイル結果') : t('表示用キャッシュ');
      list.append(make('li', '', `${area}: ${entry.path}${entry.directory ? '/' : ''}`));
    }
  }
  function setBusy(value) {
    busy = value; dialog.setAttribute('aria-busy', String(value));
    for (const button of [close, cancel, submit]) button.disabled = value;
  }
  function finish() {
    if (dialog.open) dialog.close();
    inspection = null; projectRoot = '';
    if (locked) { locked = false; end(); }
    const resolve = settle; settle = null; resolve?.();
    const focus = returnFocus?.isConnected ? returnFocus : getFallbackFocus();
    focus?.focus({ preventScroll: true });
    returnFocus = null;
  }
  function cancelDialog() { if (!busy) finish(); }
  close.addEventListener('click', cancelDialog); cancel.addEventListener('click', cancelDialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancelDialog(); });
  dialog.addEventListener('close', () => { if (locked && !busy) finish(); });

  async function open(entry) {
    if (locked || isBlocked()) return;
    projectRoot = getProjectRoot(); if (!projectRoot) return;
    const root = projectRoot;
    returnFocus = document.activeElement;
    locked = true;
    try {
      await begin();
      let notice = '';
      try {
        inspection = await api(`/api/pdf/delete?main=${encodeURIComponent(entry.main)}&build=${encodeURIComponent(entry.buildId)}`, { projectRoot: root, timeout: 60000 });
      } catch (err) {
        if (!err?.data?.reviewRequired || err.data.inspection?.main !== entry.main || getProjectRoot() !== root) throw err;
        inspection = err.data.inspection; notice = err.message;
        if (err.data.state) await onState?.(err.data.state);
      }
      if (getProjectRoot() !== root) { finish(); return; }
      error.textContent = notice; error.hidden = !notice; entries.open = false; setBusy(false); language();
      const completion = new Promise(resolve => { settle = resolve; });
      dialog.showModal(); cancel.focus();
      return completion;
    } catch (err) { finish(); throw err; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !inspection || !projectRoot) return;
    if (getProjectRoot() !== projectRoot) { finish(); return; }
    setBusy(true); error.hidden = true;
    let reviewRequired = false;
    try {
      const result = await api('/api/pdf/delete', {
        method: 'DELETE', projectRoot, timeout: 60000,
        body: { main: inspection.main, buildId: inspection.buildId, revision: inspection.revision },
      });
      if (getProjectRoot() === projectRoot) {
        await onChanged(result);
        onNotice(t('コンパイルした PDF を削除しました．'));
      }
      finish();
    } catch (err) {
      if (err?.data?.state && getProjectRoot() === projectRoot) {
        try { await onState?.(err.data.state); } catch (stateError) { err = stateError; }
      }
      if (err?.data?.reviewRequired && err.data.inspection?.main === inspection?.main && getProjectRoot() === projectRoot) {
        inspection = err.data.inspection; language(); reviewRequired = true;
      }
      error.textContent = err?.message || String(err); error.hidden = false;
    } finally {
      setBusy(false);
      if (reviewRequired && dialog.open) cancel.focus();
    }
  });
  const stopLanguage = onLanguageChange(language);
  language();
  return { open, destroy() { finish(); stopLanguage(); dialog.remove(); } };
}
