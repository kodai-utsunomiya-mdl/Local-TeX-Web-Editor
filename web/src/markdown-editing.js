import katex from 'katex';
import { isInTable } from 'prosemirror-tables';
import { t, onLanguageChange, translateElements } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';
import { markdownEdit, markdownMathSource, selectedMarkdownMath, sameMarkdownSelection } from './markdown-editing-commands.js';
import { markdownFormattingState } from './markdown-toolbar-state.js';

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

export function createMarkdownEditing({ container, getDocument, applyEdit, getRichEditor = () => null, focusDocument = () => {}, onImage = () => {}, onTable = () => {}, onNewPage = () => {}, onError = () => {} }) {
  container.classList.add('markdown-editing');
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', t('Markdown の編集'));
  container.setAttribute('data-i18n-aria-label', 'Markdown の編集');
  let linkDocument = null, codeDocument = null, mathDocument = null;
  let mathPreference = { displayMode: false, delimiter: '$`' };
  let mathInTable = false;
  let lastFormattingState = null, formattingState = null;
  const formattingButtons = new Map();
  const snapshot = () => {
    const document = getDocument();
    if (!document || !isMarkdown(document.path)) throw new Error(t('編集する Markdown の原稿を開いてください．'));
    return { path: document.path, projectRoot: document.projectRoot, pane: document.pane, content: String(document.content || ''), anchor: document.anchor, head: document.head, richAnchor: document.richAnchor, richHead: document.richHead };
  };
  function commandError(error) {
    if (error.message === 'link-url') return new Error(t('リンク先には http・https・mailto の URL，またはプロジェクト内の相対パスを入力してください．'));
    if (error.message === 'code-language') return new Error(t('言語の名前は空白や backtick を含めずに入力してください．'));
    if (error.message === 'math-empty') return new Error(t('数式の TeX を入力してください．'));
    if (error.message === 'math-line') return new Error(t('行内数式は 1 行で入力してください．複数行では「独立した数式」を選んでください．'));
    if (error.message === 'math-delimiter') return new Error(t('数式の記法を選び直してください．'));
    return error;
  }
  async function apply(command, options, document = snapshot()) {
    if (!sameMarkdownSelection(getDocument(), document)) throw new Error(t('原稿や選択範囲が変わりました．挿入先を選び直して，もう一度開いてください．'));
    const rich = getRichEditor();
    if (rich) {
      try { rich.command(command, options); } catch (error) { throw commandError(error); }
      focusDocument(document); return;
    }
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
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', action);
    return button;
  }
  function formattingButton(command, key, caption, action, className = '') {
    const control = button(key, caption, action, className);
    control.dataset.markdownCommand = command;
    formattingButtons.set(command, control);
    return control;
  }
  const heading = element('select', { class: 'markdown-heading-select', 'aria-label': t('見出しの種類'), 'data-i18n-aria-label': '見出しの種類', title: t('見出しの種類'), 'data-i18n-title': '見出しの種類' });
  heading.append(translated('option', '本文', { value: '0' }));
  for (let level = 1; level <= 6; level++) heading.append(element('option', { value: String(level) }, `H${level}`));
  heading.addEventListener('change', () => run('heading', { level: Number(heading.value) }));
  const formatting = element('div', { class: 'markdown-edit-group' });
  formatting.append(heading,
    formattingButton('bold', '太字', 'B', () => run('bold', { placeholder: t('文字') }), 'markdown-edit-bold'),
    formattingButton('italic', '斜体', 'I', () => run('italic', { placeholder: t('文字') }), 'markdown-edit-italic'),
    formattingButton('strike', '取消線', 'S', () => run('strike', { placeholder: t('文字') }), 'markdown-edit-strike'));
  const blocks = element('div', { class: 'markdown-edit-group' });
  blocks.append(formattingButton('bullet', '箇条書き', '•', () => run('bullet')), formattingButton('ordered', '番号付きリスト', '1.', () => run('ordered')), formattingButton('task', 'チェックリスト', '☑', () => run('task')), formattingButton('quote', '引用', '❝', () => run('quote')));
  const insertions = element('div', { class: 'markdown-edit-group' });
  const mathButton = button('数式を挿入', '∑', () => openMath());
  mathButton.dataset.markdownCommand = 'math';
  insertions.append(formattingButton('inlineCode', '行内コード', '<>', () => run('inlineCode', { placeholder: t('コード') })), formattingButton('codeBlock', 'コードブロック', '{ }', () => openCode()), mathButton, button('リンクを挿入', '↗', () => openLink()));
  const files = element('div', { class: 'markdown-edit-group' });
  files.append(
    button('画像を挿入', insertionIcon('image'), onImage),
    button('表を挿入', insertionIcon('table'), onTable),
    button('新しい Markdown ページ', insertionIcon('page'), onNewPage));
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
      linkLabel.input.value = getRichEditor()?.selectedText() ?? linkDocument.content.slice(from, to);
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
      codeInput.input.value = getRichEditor()?.selectedText() ?? codeDocument.content.slice(from, to); codeLanguage.input.value = '';
      code.open(); codeInput.input.focus();
    } catch (error) { onError(error); }
  }

  const mathDialog = createImportDialog('markdown-math-dialog', '数式を挿入');
  const mathPlacement = labelledInput('markdown-math-placement', '数式の配置', 'select');
  const mathDisplayOption = translated('option', '独立した数式', { value: 'display' });
  mathPlacement.input.append(translated('option', '行内数式', { value: 'inline' }), mathDisplayOption);
  const mathDelimiter = labelledInput('markdown-math-delimiter', '行内数式の記法', 'select');
  mathDelimiter.input.append(translated('option', 'GitHub の形式 ($`...`$)', { value: '$`' }), element('option', { value: '$' }, '$...$'), element('option', { value: '\\(' }, '\\(...\\)'));
  const mathOptions = element('div', { class: 'markdown-math-options' });
  mathOptions.append(mathPlacement.group, mathDelimiter.group);
  const mathDisplayHelp = translated('p', '独立した数式は $$ で囲んで挿入します．', { class: 'field-help' });
  const mathTableHelp = translated('p', '表のセルではインライン数式を使います．', { class: 'field-help', id: 'markdown-math-table-help', hidden: '' });
  const mathInput = labelledInput('markdown-math-input', '数式の TeX', 'textarea', { rows: '4', spellcheck: 'false', placeholder: 'e^{i\\pi} + 1 = 0' });
  const mathPreview = labelledInput('markdown-math-source', '挿入する Markdown', 'textarea', { rows: '3', readonly: '', spellcheck: 'false' });
  const mathRendered = element('div', { class: 'markdown-math-preview', role: 'group', 'aria-label': t('数式のプレビュー'), 'data-i18n-aria-label': '数式のプレビュー' });
  const mathRenderGroup = element('div', { class: 'import-field' });
  mathRenderGroup.append(translated('p', '数式のプレビュー', { class: 'field-label' }), mathRendered);
  const mathInsert = translated('button', '数式を挿入', { class: 'button button-primary', type: 'button', id: 'markdown-math-confirm' });
  const mathCancel = translated('button', 'キャンセル', { class: 'button', type: 'button' });
  mathDialog.body.append(mathOptions, mathDisplayHelp, mathTableHelp, mathInput.group, mathRenderGroup, mathPreview.group);
  mathDialog.footer.append(mathCancel, mathInsert);
  mathCancel.onclick = () => mathDialog.close();
  mathDialog.dialog.addEventListener('close', () => { if (mathDocument) focusDocument(mathDocument); });
  function mathValues() {
    const displayMode = !mathInTable && mathPlacement.input.value === 'display';
    return { tex: mathInput.input.value.replace(/\r\n?/g, '\n').trim(), displayMode, delimiter: displayMode ? '$$' : mathDelimiter.input.value };
  }
  function updateMath() {
    if (mathInTable) mathPlacement.input.value = 'inline';
    mathDisplayOption.disabled = mathInTable;
    mathTableHelp.hidden = !mathInTable;
    if (mathInTable) mathPlacement.input.setAttribute('aria-describedby', mathTableHelp.id);
    else mathPlacement.input.removeAttribute('aria-describedby');
    const values = mathValues();
    mathDelimiter.group.hidden = values.displayMode;
    mathDisplayHelp.hidden = !values.displayMode;
    mathDialog.clearError();
    mathRendered.replaceChildren();
    try {
      mathPreview.input.value = markdownMathSource(values.tex, values);
      mathInsert.disabled = false;
      katex.render(values.tex, mathRendered, { displayMode: values.displayMode, trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: {} });
    } catch (error) {
      mathPreview.input.value = ''; mathInsert.disabled = true;
      if (values.tex) mathDialog.showError(commandError(error));
    }
  }
  mathInput.input.addEventListener('input', updateMath);
  for (const input of [mathPlacement.input, mathDelimiter.input]) input.addEventListener('change', () => {
    mathPreference = { displayMode: mathInTable ? mathPreference.displayMode : mathPlacement.input.value === 'display', delimiter: mathDelimiter.input.value };
    updateMath();
  });
  mathInsert.onclick = () => mathDialog.run(async () => {
    const values = mathValues();
    try { markdownMathSource(values.tex, values); } catch (error) { throw commandError(error); }
    await apply('math', values, mathDocument);
    return true;
  }).then(done => { if (done) mathDialog.dialog.close(); });
  function openMath() {
    try {
      mathDocument = snapshot();
      const rich = getRichEditor();
      mathInTable = Boolean(rich && isInTable(rich.view.state));
      const from = Math.min(mathDocument.anchor, mathDocument.head), to = Math.max(mathDocument.anchor, mathDocument.head);
      const selected = (rich?.selectedText() ?? mathDocument.content.slice(from, to)).trim();
      const selectedNode = rich?.view.state.selection.node;
      const existing = ['math_inline', 'math_block'].includes(selectedNode?.type.name) ? selectedNode.attrs : rich ? null : selectedMarkdownMath(mathDocument);
      mathPlacement.input.value = !mathInTable && (existing?.displayMode ?? mathPreference.displayMode) ? 'display' : 'inline';
      mathDelimiter.input.value = existing && !existing.displayMode && ['$`', '$', '\\('].includes(existing.delimiter) ? existing.delimiter : mathPreference.delimiter;
      mathInput.input.value = existing?.tex ?? selected;
      mathDialog.open(); updateMath(); mathInput.input.focus(); mathInput.input.select();
    } catch (error) { onError(error); }
  }

  function update() {
    const document = getDocument();
    container.hidden = !document || !isMarkdown(document.path);
    const rich = getRichEditor();
    const currentState = rich?.view.state || null;
    if (currentState !== lastFormattingState) {
      lastFormattingState = currentState;
      formattingState = currentState ? markdownFormattingState(currentState) : null;
    }
    for (const [command, control] of formattingButtons) {
      if (formattingState) control.setAttribute('aria-pressed', String(formattingState[command]));
      else control.removeAttribute('aria-pressed');
    }
    if (!container.hidden) {
      const position = Math.min(document.anchor, document.head);
      const start = position === 0 ? 0 : document.content.lastIndexOf('\n', position - 1) + 1;
      const match = document.content.slice(start).match(/^ {0,3}(#{1,6})(?:[ \t]|$)/);
      heading.value = String(rich ? rich.headingLevel() : match?.[1].length || 0);
    }
  }
  const stopLanguage = onLanguageChange(() => { translateElements(container); translateElements(mathDialog.dialog); if (mathDialog.dialog.open) updateMath(); update(); });
  update();
  return { update, openLink, openCode, openMath, destroy() { stopLanguage(); link.destroy(); code.destroy(); mathDialog.destroy(); container.replaceChildren(); } };
}
