import { t, onLanguageChange, translateElements } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';
import { markdownEdit, sameMarkdownSelection } from './markdown-editing-commands.js';

const isMarkdown = path => /\.(md|markdown)$/i.test(path || '');

function insertionIcon(kind) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 20 20', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
  const grid = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const paths = {
    table: 'M3 3.5h14v13H3Z M3 8h14 M3 12.5h14 M7.5 3.5v13 M12.5 3.5v13',
    image: 'M3 3.5h14v13H3Z M3 13l4-4 4 4 2-2 4 4 M12 6.5h1',
    page: 'M4 2.5h7l5 5v10H4Z M11 2.5v5h5 M7 12h6 M10 9v6',
  };
  grid.setAttribute('d', paths[kind]);
  icon.append(grid);
  return icon;
}

export function createMarkdownEditing({ container, getDocument, applyEdit, focusDocument = () => {}, onImage = () => {}, onTable = () => {}, onNewPage = () => {}, onError = () => {} }) {
  container.classList.add('markdown-editing');
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', t('Markdown の編集'));
  container.setAttribute('data-i18n-aria-label', 'Markdown の編集');
  let linkDocument = null, codeDocument = null;
  const snapshot = () => {
    const document = getDocument();
    if (!document || !isMarkdown(document.path)) throw new Error(t('編集する Markdown の原稿を開いてください．'));
    return { path: document.path, projectRoot: document.projectRoot, pane: document.pane, content: String(document.content || ''), anchor: document.anchor, head: document.head };
  };
  function commandError(error) {
    if (error.message === 'link-url') return new Error(t('リンク先には http・https・mailto の URL，またはプロジェクト内の相対パスを入力してください．'));
    if (error.message === 'code-language') return new Error(t('言語の名前は空白や backtick を含めずに入力してください．'));
    return error;
  }
  async function apply(command, options, document = snapshot()) {
    if (!sameMarkdownSelection(getDocument(), document)) throw new Error(t('原稿や選択範囲が変わりました．挿入先を選び直して，もう一度開いてください．'));
    let edit;
    try { edit = markdownEdit(document, command, options); }
    catch (error) { throw commandError(error); }
    await applyEdit(edit, document);
  }
  function run(command, options = {}) {
    Promise.resolve().then(() => apply(command, options)).catch(onError);
  }
  function button(key, caption, action, className = '') {
    const button = element('button', { type: 'button', class: `markdown-edit-button ${className}`.trim(), title: t(key), 'aria-label': t(key), 'data-i18n-title': key, 'data-i18n-aria-label': key });
    button.append(typeof caption === 'string' ? element('span', { 'aria-hidden': 'true' }, caption) : caption);
    button.addEventListener('click', action);
    return button;
  }
  function insertionButton(key, label, icon, action) {
    const control = button(key, insertionIcon(icon), action, 'markdown-edit-labelled');
    control.append(translated('span', label));
    return control;
  }
  const heading = element('select', { class: 'markdown-heading-select', 'aria-label': t('見出しの種類'), 'data-i18n-aria-label': '見出しの種類', title: t('見出しの種類'), 'data-i18n-title': '見出しの種類' });
  heading.append(translated('option', '本文', { value: '0' }));
  for (let level = 1; level <= 6; level++) heading.append(element('option', { value: String(level) }, `H${level}`));
  heading.addEventListener('change', () => run('heading', { level: Number(heading.value) }));
  const formatting = element('div', { class: 'markdown-edit-group' });
  formatting.append(heading,
    button('太字', 'B', () => run('bold', { placeholder: t('文字') }), 'markdown-edit-bold'),
    button('斜体', 'I', () => run('italic', { placeholder: t('文字') }), 'markdown-edit-italic'),
    button('取消線', 'S', () => run('strike', { placeholder: t('文字') }), 'markdown-edit-strike'));
  const blocks = element('div', { class: 'markdown-edit-group' });
  blocks.append(button('箇条書き', '•', () => run('bullet')), button('番号付きリスト', '1.', () => run('ordered')), button('チェックリスト', '☑', () => run('task')), button('引用', '❝', () => run('quote')));
  const insertions = element('div', { class: 'markdown-edit-group' });
  insertions.append(button('行内コード', '<>', () => run('inlineCode', { placeholder: t('コード') })), button('コードブロック', '{ }', () => openCode()), button('リンクを挿入', '↗', () => openLink()));
  const files = element('div', { class: 'markdown-edit-group' });
  files.append(
    insertionButton('画像を挿入', '画像', 'image', onImage),
    insertionButton('表を挿入', '表', 'table', onTable),
    insertionButton('新しい Markdown ページ', '新規ページ', 'page', onNewPage));
  container.replaceChildren(formatting, blocks, insertions, files);

  const link = createImportDialog('markdown-link-dialog', 'リンクを挿入');
  const linkLabel = labelledInput('markdown-link-label', '表示する文字');
  const linkURL = labelledInput('markdown-link-url', 'リンク先', 'input', { placeholder: 'https://example.com/', spellcheck: 'false' });
  const linkPreview = labelledInput('markdown-link-source', '挿入する内容', 'textarea', { rows: '3', readonly: '' });
  const linkHelp = translated('p', 'Web の URL，メールアドレスへの mailto リンク，プロジェクト内の文書への相対パスを使えます．', { class: 'field-help' });
  const linkInsert = translated('button', 'リンクを挿入', { class: 'button button-primary', type: 'button', id: 'markdown-link-confirm' });
  const linkCancel = translated('button', 'キャンセル', { class: 'button', type: 'button' });
  link.body.append(linkLabel.group, linkURL.group, linkHelp, linkPreview.group); link.footer.append(linkCancel, linkInsert);
  linkCancel.onclick = () => link.close();
  link.dialog.addEventListener('close', () => { if (linkDocument) focusDocument(linkDocument); });
  function updateLink() {
    try { linkPreview.input.value = markdownEdit(linkDocument || {}, 'link', { label: linkLabel.input.value, url: linkURL.input.value, placeholder: t('リンクの文字') }).changes[0].insert; }
    catch { linkPreview.input.value = ''; }
  }
  for (const input of [linkLabel.input, linkURL.input]) input.addEventListener('input', updateLink);
  linkInsert.onclick = () => link.run(async () => {
    await apply('link', { label: linkLabel.input.value, url: linkURL.input.value, placeholder: t('リンクの文字') }, linkDocument);
    return true;
  }).then(done => { if (done) link.dialog.close(); });
  function openLink() {
    try {
      linkDocument = snapshot();
      const from = Math.min(linkDocument.anchor, linkDocument.head), to = Math.max(linkDocument.anchor, linkDocument.head);
      linkLabel.input.value = linkDocument.content.slice(from, to);
      linkURL.input.value = ''; linkPreview.input.value = '';
      link.open(); (linkLabel.input.value ? linkURL.input : linkLabel.input).focus();
    } catch (error) { onError(error); }
  }

  const code = createImportDialog('markdown-code-dialog', 'コードブロック');
  const codeLanguage = labelledInput('markdown-code-language', '言語 (省略可)', 'input', { placeholder: 'python, tex, javascript', maxlength: '50' });
  const codeInput = labelledInput('markdown-code-input', 'コード', 'textarea', { rows: '8', spellcheck: 'false' });
  const codeInsert = translated('button', 'コードブロックを挿入', { class: 'button button-primary', type: 'button', id: 'markdown-code-confirm' });
  const codeCancel = translated('button', 'キャンセル', { class: 'button', type: 'button' });
  code.body.append(codeLanguage.group, codeInput.group); code.footer.append(codeCancel, codeInsert);
  codeCancel.onclick = () => code.close();
  code.dialog.addEventListener('close', () => { if (codeDocument) focusDocument(codeDocument); });
  codeInsert.onclick = () => code.run(async () => {
    await apply('codeBlock', { language: codeLanguage.input.value, code: codeInput.input.value, placeholder: t('コード') }, codeDocument);
    return true;
  }).then(done => { if (done) code.dialog.close(); });
  function openCode() {
    try {
      codeDocument = snapshot();
      let from = Math.min(codeDocument.anchor, codeDocument.head), to = Math.max(codeDocument.anchor, codeDocument.head);
      if (from === to) {
        from = from === 0 ? 0 : codeDocument.content.lastIndexOf('\n', from - 1) + 1;
        const end = codeDocument.content.indexOf('\n', to);
        to = end < 0 ? codeDocument.content.length : end;
      }
      codeInput.input.value = codeDocument.content.slice(from, to); codeLanguage.input.value = '';
      code.open(); codeInput.input.focus();
    } catch (error) { onError(error); }
  }

  function update() {
    const document = getDocument();
    container.hidden = !document || !isMarkdown(document.path);
    if (!container.hidden) {
      const position = Math.min(document.anchor, document.head);
      const start = position === 0 ? 0 : document.content.lastIndexOf('\n', position - 1) + 1;
      const match = document.content.slice(start).match(/^ {0,3}(#{1,6})(?:[ \t]|$)/);
      heading.value = String(match?.[1].length || 0);
    }
  }
  const stopLanguage = onLanguageChange(() => { translateElements(container); update(); });
  update();
  return { update, openLink, openCode, destroy() { stopLanguage(); link.destroy(); code.destroy(); container.replaceChildren(); } };
}
