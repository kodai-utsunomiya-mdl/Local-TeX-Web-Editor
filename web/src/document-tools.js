import { t } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';
import { sameMarkdownSelection } from './markdown-editing-commands.js';
import { isMarkdownPath } from './markdown-preview.js';
import { documentDownloadName, extractPDFText, markdownPageDetails, suggestedMarkdownPagePath } from './document-conversion.js';
import { prepareMarkdownPrint } from './markdown-print.js';

function pageError(error) {
  if (error.message === 'markdown-page-title') return new Error(t('ページのタイトルを 200 文字以内で入力してください．'));
  if (error.message === 'markdown-page-path') return new Error(t('プロジェクト内の既存フォルダーに，拡張子が .md または .markdown の保存先を指定してください．'));
  return error;
}

export function createDocumentTools({ api, token, getDocument, getProject, getPDF, insertText, assertNewPath = () => {}, refreshProject = async () => {}, openFile = async () => {}, focusDocument = () => {}, onError = () => {} }) {
  const pageDialog = createImportDialog('markdown-page-dialog', '新しい Markdown ページ');
  const printDialog = createImportDialog('markdown-print-dialog', 'Markdown を PDF に保存');
  const textDialog = createImportDialog('pdf-text-dialog', 'PDF をテキストに変換');
  printDialog.dialog.classList.add('document-print-dialog');
  let pageDocument = null, createdPage = null, pathEdited = false, openingPage = false;
  let printDocument = null, printController = null, printGeneration = 0;
  let textController = null, textGeneration = 0;
  const printURLs = new Set();

  const title = labelledInput('markdown-page-title', 'ページのタイトル', 'input', { maxlength: '200', autocomplete: 'off' });
  const path = labelledInput('markdown-page-path', 'プロジェクト内の保存先', 'input', { maxlength: '240', autocomplete: 'off', spellcheck: 'false' });
  const source = labelledInput('markdown-page-link', '挿入するリンク', 'textarea', { rows: '3', readonly: '' });
  const openLabel = element('label', { class: 'checkbox-field' });
  const openCreated = element('input', { type: 'checkbox', id: 'markdown-page-open', checked: '' });
  openLabel.append(openCreated, translated('span', '作成したページを開く'));
  const create = translated('button', 'ページを作成してリンクを挿入', { id: 'markdown-page-confirm', type: 'button', class: 'button button-primary' });
  const pageCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  pageDialog.body.append(title.group, path.group,
    translated('p', '既存のフォルダー内に新しいページを作成します．現在の原稿には相対パスのリンクを挿入します．', { class: 'field-help' }), source.group, openLabel);
  pageDialog.footer.append(pageCancel, create);
  pageCancel.onclick = () => pageDialog.close();
  function updatePage() {
    if (createdPage) return;
    if (!pathEdited) path.input.value = suggestedMarkdownPagePath(title.input.value, pageDocument?.path, getProject()?.files || []);
    try { source.input.value = markdownPageDetails({ title: title.input.value, path: path.input.value, documentPath: pageDocument?.path }).link; }
    catch { source.input.value = ''; }
  }
  title.input.addEventListener('input', updatePage);
  path.input.addEventListener('input', () => { pathEdited = true; updatePage(); });
  pageDialog.dialog.addEventListener('close', () => { if (!openingPage) focusDocument(pageDocument); });
  create.onclick = () => pageDialog.run(async () => {
    if (!sameMarkdownSelection(getDocument(), pageDocument) || getProject()?.root !== pageDocument.projectRoot) {
      throw new Error(createdPage
        ? t('{path} を作成しました．原稿が変更されたため，表示中のリンクを挿入先にコピーしてください．', { path: createdPage.path })
        : t('原稿や選択範囲が変わりました．挿入先を選び直して，もう一度開いてください．'));
    }
    if (!createdPage) {
      let details;
      try { details = markdownPageDetails({ title: title.input.value, path: path.input.value, documentPath: pageDocument.path }); }
      catch (error) { throw pageError(error); }
      assertNewPath(details.path);
      title.input.disabled = path.input.disabled = true;
      try {
        await api('/api/file', { method: 'PUT', body: { path: details.path, content: details.content, revision: '' }, projectRoot: pageDocument.projectRoot });
        createdPage = details;
        source.input.value = details.link;
      } finally {
        if (!createdPage) title.input.disabled = path.input.disabled = false;
      }
    }
    try { await refreshProject(); }
    catch (error) { throw new Error(t('{path} を作成しましたが，ファイル一覧を更新できませんでした．{error}', { path: createdPage.path, error: error.message || error })); }
    try { await insertText(createdPage.link, pageDocument); }
    catch { throw new Error(t('{path} を作成しました．原稿が変更されたため，表示中のリンクを挿入先にコピーしてください．', { path: createdPage.path })); }
    return { path: createdPage.path, open: openCreated.checked, pane: pageDocument.pane };
  }).then(async result => {
    if (!result) return;
    openingPage = result.open;
    pageDialog.dialog.close();
    if (result.open) {
      try { await openFile(result.path, { pane: result.pane }); }
      catch (error) { onError(error); }
    }
  });

  const printName = labelledInput('markdown-print-name', 'PDF のファイル名', 'input', { maxlength: '200' });
  const printStatus = element('p', { class: 'document-conversion-status', role: 'status', 'aria-live': 'polite' });
  const printPreview = element('iframe', { id: 'markdown-print-preview', class: 'document-print-preview', sandbox: 'allow-same-origin allow-modals', title: t('PDF の印刷プレビュー'), 'data-i18n-title': 'PDF の印刷プレビュー' });
  const print = translated('button', '印刷画面で PDF に保存', { id: 'markdown-print-confirm', type: 'button', class: 'button button-primary' });
  const printCancel = translated('button', '閉じる', { type: 'button', class: 'button' });
  printDialog.body.append(translated('p', 'ブラウザの印刷画面で「PDF に保存」を選びます．未保存の編集内容も出力します．', { class: 'field-help' }), printName.group, printStatus, printPreview);
  printDialog.footer.append(printCancel, print);
  printCancel.onclick = () => printDialog.close();
  function clearPrint() {
    printGeneration++; printController?.abort(); printController = null;
    for (const url of printURLs) URL.revokeObjectURL(url);
    printURLs.clear(); printPreview.removeAttribute('srcdoc'); printPreview.src = 'about:blank'; print.disabled = true;
  }
  printDialog.dialog.addEventListener('close', () => { clearPrint(); focusDocument(printDocument); });
  print.onclick = () => {
    const document = printPreview.contentDocument;
    if (!document || print.disabled) return;
    document.title = documentDownloadName(printName.input.value || printDocument.path, 'pdf').replace(/\.pdf$/i, '');
    printPreview.contentWindow.focus();
    printPreview.contentWindow.print();
  };

  const textName = labelledInput('pdf-text-name', 'テキストのファイル名', 'input', { maxlength: '200' });
  const textStatus = element('p', { class: 'document-conversion-status', role: 'status', 'aria-live': 'polite' });
  const progress = element('progress', { class: 'document-conversion-progress', 'aria-label': t('PDF の変換状況'), 'data-i18n-aria-label': 'PDF の変換状況', max: '1', value: '0' });
  const textPreview = labelledInput('pdf-text-preview', '抽出したテキストの見本', 'textarea', { rows: '10', readonly: '', spellcheck: 'false' });
  textPreview.group.classList.add('document-text-preview');
  const download = translated('button', 'TXT をダウンロード', { id: 'pdf-text-download', type: 'button', class: 'button button-primary' });
  const textCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  textDialog.body.append(translated('p', 'PDF の文字をページ順に取り出します．画像内の文字を読み取る OCR は含まれません．', { class: 'field-help' }), textName.group, textStatus, progress, textPreview.group,
    translated('p', '見本には先頭の 20000 文字を表示します．ダウンロードする TXT には全文を含めます．', { class: 'field-help' }));
  textDialog.footer.append(textCancel, download);
  textCancel.onclick = () => textDialog.close();
  textDialog.dialog.addEventListener('close', () => { textGeneration++; textController?.abort(); textController = null; download.onclick = null; textPreview.input.value = ''; });

  function markdownDocument() {
    const current = getDocument();
    if (!current || !isMarkdownPath(current.path)) { onError(new Error(t('Markdown の原稿を開いてください．'))); return null; }
    return { ...current, content: String(current.content || ''), projectRoot: getProject()?.root };
  }
  function openMarkdownPage() {
    pageDocument = markdownDocument();
    if (!pageDocument) return;
    openingPage = false; createdPage = null; pathEdited = false;
    title.input.disabled = path.input.disabled = false;
    title.input.value = ''; path.input.value = ''; source.input.value = ''; openCreated.checked = true;
    pageDialog.open(); updatePage(); title.input.focus();
  }
  async function openMarkdownPDF() {
    printDocument = markdownDocument();
    if (!printDocument) return;
    clearPrint();
    const generation = printGeneration, snapshot = printDocument;
    printController = new AbortController();
    const signal = printController.signal;
    printName.input.value = documentDownloadName(snapshot.path, 'pdf');
    printStatus.textContent = t('印刷プレビューを準備しています…');
    printDialog.open(); printName.input.focus();
    try {
      const document = await prepareMarkdownPrint(printPreview, snapshot, { token, signal, urls: printURLs });
      if (generation !== printGeneration) return;
      document.title = documentDownloadName(snapshot.path, 'pdf').replace(/\.pdf$/i, '');
      printStatus.textContent = t('印刷プレビューを確認してから，PDF に保存してください．');
      print.disabled = false;
    } catch (error) {
      if (signal.aborted || generation !== printGeneration) return;
      printStatus.textContent = ''; printDialog.showError(error);
    }
  }
  async function openPDFText() {
    const current = getPDF();
    if (!current?.document) { onError(new Error(t('変換する PDF をプレビューに表示してください．'))); return; }
    textController?.abort(); textController = new AbortController();
    const signal = textController.signal, generation = ++textGeneration;
    textName.input.value = documentDownloadName(current.path, 'txt');
    textPreview.input.value = ''; download.disabled = true; download.onclick = null;
    progress.max = current.document.numPages; progress.value = 0; progress.hidden = false;
    textStatus.textContent = t('PDF の文字を読み取っています: {page} / {total} ページ', { page: 0, total: current.document.numPages });
    textDialog.open(); textCancel.focus();
    try {
      const result = await extractPDFText(current.document, {
        signal, isCurrent: () => getPDF()?.document === current.document,
        onProgress: (page, total) => {
          if (generation !== textGeneration) return;
          progress.value = page;
          textStatus.textContent = t('PDF の文字を読み取っています: {page} / {total} ページ', { page, total });
        },
      });
      if (generation !== textGeneration) return;
      if (getPDF()?.document !== current.document) throw new Error('pdf-document-changed');
      progress.hidden = true;
      textPreview.input.value = result.text.slice(0, 20_000);
      if (!result.text) { textStatus.textContent = t('この PDF に抽出できるテキストがありません．画像の文字には OCR が必要です．'); return; }
      textStatus.textContent = t('{pages} ページから {characters} 文字を抽出しました．', { pages: result.pages, characters: result.text.length });
      download.disabled = false;
      download.onclick = () => {
        if (signal.aborted || generation !== textGeneration || !textDialog.dialog.open) return;
        if (getPDF()?.document !== current.document) {
          download.disabled = true; download.onclick = null; textPreview.input.value = ''; textStatus.textContent = '';
          textDialog.showError(new Error(t('PDF が更新されました．変換を開き直してください．')));
          return;
        }
        const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }));
        const link = element('a', { href: url, download: documentDownloadName(textName.input.value || current.path, 'txt') });
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      };
    } catch (error) {
      if (signal.aborted || generation !== textGeneration) return;
      progress.hidden = true; textStatus.textContent = '';
      const messages = {
        'pdf-document-changed': 'PDF が更新されました．変換を開き直してください．',
        'pdf-text-too-large': 'テキストが 16 MiB を超えました．ページ数を減らした PDF でお試しください．',
      };
      textDialog.showError(new Error(getPDF()?.document !== current.document ? t(messages['pdf-document-changed']) : messages[error.message] ? t(messages[error.message]) : error.message || String(error)));
    }
  }
  return {
    openMarkdownPage, openMarkdownPDF, openPDFText,
    destroy() { clearPrint(); textController?.abort(); pageDialog.destroy(); printDialog.destroy(); textDialog.destroy(); },
  };
}
