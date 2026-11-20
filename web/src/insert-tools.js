import { t } from './i18n.js';
import { createImportDialog, element, labelledInput, translated } from './import-dialog.js';
import { assetInsertion, suggestedAssetName, parseTable, tableInsertion, tableToTSV } from './insert-content.js';

const MAX_IMAGE = 8 * 1024 * 1024;
const isMarkdown = path => /\.(md|markdown)$/i.test(path || '');
const canInsert = doc => doc && /\.(tex|md|markdown)$/i.test(doc.path || '');

function imageFile(file) {
  return !!file && (/\.(png|jpe?g|pdf)$/i.test(file.name || '') || ['image/png', 'image/jpeg', 'application/pdf'].includes(file.type));
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function createInsertTools({ api, getDocument, getProject = () => null, insertText, refreshProject = async () => {}, focusDocument = () => {}, onError = () => {} }) {
  const imageDialog = createImportDialog('insert-image-dialog', '画像を挿入');
  const tableDialog = createImportDialog('insert-table-dialog', '表を挿入');
  let imageDocument = null, tableDocument = null, chosenFile = null, previewURL = '';

  const imageFileInput = labelledInput('insert-image-file', '画像または PDF', 'input', { type: 'file', accept: '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf' });
  const destination = labelledInput('insert-image-path', 'プロジェクト内の保存先', 'input', { placeholder: 'figures/image.png', maxlength: '220' });
  const caption = labelledInput('insert-image-caption', '図の説明 (省略可)');
  const label = labelledInput('insert-image-label', 'ラベル (省略可)', 'input', { placeholder: 'fig:result' });
  const width = labelledInput('insert-image-width', '本文の幅に対する割合', 'input', { type: 'number', min: '0.05', max: '1', step: '0.05', value: '0.8' });
  const filePreview = element('div', { class: 'import-image-preview' });
  const imageSource = labelledInput('insert-image-source', '挿入する内容', 'textarea', { rows: '7', readonly: '' });
  const imageHelp = translated('p', 'PNG・JPEG・PDF を 8 MiB まで取り込めます．同じ名前がある場合は，末尾に番号を付けて保存します．', { class: 'field-help' });
  const texHelp = translated('p', 'TeX の画像には graphicx が必要です．プリアンブルに \\usepackage{graphicx} を追加してください．', { class: 'field-help' });
  const imageInsert = translated('button', '取り込んで挿入', { type: 'button', class: 'button button-primary', id: 'insert-image-confirm' });
  const imageCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const imageRow = element('div', { class: 'import-columns' }); imageRow.append(label.group, width.group);
  imageDialog.body.append(imageFileInput.group, imageHelp, filePreview, destination.group, caption.group, imageRow, texHelp, imageSource.group);
  imageDialog.footer.append(imageCancel, imageInsert);
  imageCancel.onclick = () => imageDialog.close();

  function imageText(path = destination.input.value) {
    return assetInsertion({ documentPath: imageDocument?.path || '', assetPath: path, caption: caption.input.value, label: label.input.value, width: width.input.value });
  }
  function updateImageSource() {
    try { imageSource.input.value = imageDocument && destination.input.value ? imageText() : ''; }
    catch { imageSource.input.value = ''; }
  }
  function clearPreview() {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = ''; filePreview.replaceChildren();
  }
  function chooseImage(file) {
    imageDialog.clearError(); clearPreview(); chosenFile = null;
    if (!file) return;
    if (!imageFile(file) || file.size <= 0 || file.size > MAX_IMAGE) {
      imageDialog.showError(t('PNG・JPEG・PDF を 8 MiB 以内で選んでください．'));
      return;
    }
    chosenFile = file;
    destination.input.value = `figures/${suggestedAssetName(file.name, file.type)}`;
    const pdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (pdf) filePreview.append(element('p', {}, `${file.name} · ${(file.size / 1024).toFixed(0)} KiB`));
    else {
      previewURL = URL.createObjectURL(file);
      filePreview.append(element('img', { src: previewURL, alt: file.name || t('画像') }));
    }
    updateImageSource();
  }
  imageFileInput.input.addEventListener('change', () => chooseImage(imageFileInput.input.files[0]));
  for (const field of [destination, caption, label, width]) field.input.addEventListener('input', updateImageSource);
  imageDialog.dialog.addEventListener('close', clearPreview);
  imageDialog.dialog.addEventListener('close', () => { if (imageDocument) focusDocument(imageDocument); });
  tableDialog.dialog.addEventListener('close', () => { if (tableDocument) focusDocument(tableDocument); });
  imageInsert.onclick = () => imageDialog.run(async () => {
    checkDocument(imageDocument);
    if (!chosenFile) throw new Error(t('取り込む画像を選んでください．'));
    if (!destination.input.value.trim()) throw new Error(t('画像の保存先を入力してください．'));
    if (!width.input.checkValidity()) throw new Error(t('図の幅は 0 より大きく，1 以下にしてください．'));
    if (!isMarkdown(imageDocument.path) && label.input.value && !/^[A-Za-z][A-Za-z0-9:._/-]*$/.test(label.input.value)) throw new Error(t('ラベルには英字，数字，コロン，ハイフン，ピリオド，アンダースコア，スラッシュを使ってください．'));
    if (/[{}%#&$^~]/.test(destination.input.value)) throw new Error(t('画像の保存先に使用できない文字があります．'));
    imageText();
    const imported = await api('/api/assets/import', { method: 'POST', body: { path: destination.input.value.trim(), data: await fileBase64(chosenFile) }, timeout: 30000, projectRoot: imageDocument.projectRoot });
    await refreshProject();
    checkDocument(imageDocument);
    await insertText(imageText(imported.path), { ...imageDocument });
    return true;
  }).then(done => { if (done) imageDialog.dialog.close(); });

  const tableInput = labelledInput('insert-table-input', 'コピーした表を貼り付けてください', 'textarea', { rows: '6', spellcheck: 'false' });
  const newRows = labelledInput('insert-table-rows', '行数', 'input', { type: 'number', min: '1', max: '500', value: '3' });
  const newColumns = labelledInput('insert-table-columns', '列数', 'input', { type: 'number', min: '1', max: '50', value: '3' });
  const newTable = translated('button', '新しい表を作る', { type: 'button', class: 'button', id: 'insert-table-new' });
  const gridRow = element('div', { class: 'import-new-table' }); gridRow.append(newRows.group, newColumns.group, newTable);
  const format = labelledInput('insert-table-format', '挿入する形式', 'select');
  format.input.append(element('option', { value: 'tex' }, 'TeX'), element('option', { value: 'markdown' }, 'Markdown'));
  const delimiter = labelledInput('insert-table-delimiter', '区切り文字', 'select');
  delimiter.input.append(translated('option', '自動', { value: 'auto' }), translated('option', 'タブ', { value: 'tab' }), translated('option', 'カンマ', { value: 'comma' }));
  const headerLabel = element('label', { class: 'checkbox-field' });
  const header = element('input', { type: 'checkbox', checked: '', id: 'insert-table-header' });
  headerLabel.append(header, translated('span', '先頭の行を見出しにする'));
  const tablePreview = element('div', { class: 'import-table-preview', id: 'insert-table-preview' });
  const tableCount = element('p', { class: 'field-help', role: 'status' });
  const tableSource = labelledInput('insert-table-source', '挿入する内容', 'textarea', { rows: '7', readonly: '' });
  const tableHelp = translated('p', 'タブまたはカンマで区切った表を読み取ります．最大 500 行・50 列・合計 10000 セルです．Markdown ではセル内の改行を空白にします．', { class: 'field-help' });
  const tableInsert = translated('button', '表を挿入', { type: 'button', class: 'button button-primary', id: 'insert-table-confirm' });
  const tableCancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const tableRow = element('div', { class: 'import-columns' }); tableRow.append(format.group, delimiter.group);
  tableDialog.body.append(gridRow, tableInput.group, tableHelp, tableRow, headerLabel, tableCount, translated('p', '見本のセルを直接編集できます．', { class: 'field-help' }), tablePreview, tableSource.group);
  tableDialog.footer.append(tableCancel, tableInsert);
  tableCancel.onclick = () => tableDialog.close();
  let tableTimer = null, rows = [];
  function updateTable() {
    clearTimeout(tableTimer); tableDialog.clearError(); tablePreview.replaceChildren(); rows = [];
    try {
      rows = parseTable(tableInput.input.value, delimiter.input.value);
      tableSource.input.value = tableInsertion(rows, { format: format.input.value, header: header.checked });
      tableInsert.disabled = !rows.length;
      tableCount.textContent = rows.length ? t('{rows} 行，{columns} 列', { rows: rows.length, columns: rows[0].length }) : '';
      if (!rows.length) return;
      const table = element('table');
      for (const [index, row] of rows.slice(0, 30).entries()) {
        const tr = element('tr');
        for (const [column, cell] of row.slice(0, 12).entries()) {
          const td = element(header.checked && index === 0 ? 'th' : 'td');
          const input = element('textarea', { class: 'import-table-cell', rows: '1', 'aria-label': t('{row} 行 {column} 列', { row: index + 1, column: column + 1 }) });
          input.value = cell;
          input.addEventListener('input', () => {
            rows[index][column] = input.value;
            tableInput.input.value = tableToTSV(rows); delimiter.input.value = 'tab';
            tableSource.input.value = tableInsertion(rows, { format: format.input.value, header: header.checked });
          });
          td.append(input); tr.append(td);
        }
        table.append(tr);
      }
      tablePreview.append(table);
      if (rows.length > 30 || rows[0].length > 12) tablePreview.append(translated('p', '見本には先頭の 30 行・12 列を表示しています．挿入する内容には表全体が含まれます．', { class: 'field-help' }));
    } catch (error) {
      tableSource.input.value = ''; tableInsert.disabled = true;
      tableDialog.showError(t(error.message === 'table-quotes' ? '引用符が閉じているか，区切り文字が合っているか確認してください．' : '表が大きすぎます．500 行・50 列・合計 10000 セル以内にしてください．'));
    }
  }
  tableInput.input.addEventListener('input', () => { clearTimeout(tableTimer); tableTimer = setTimeout(updateTable, 180); });
  newTable.onclick = () => {
    const rowCount = Number(newRows.input.value), columnCount = Number(newColumns.input.value);
    if (!Number.isInteger(rowCount) || !Number.isInteger(columnCount) || rowCount < 1 || rowCount > 500 || columnCount < 1 || columnCount > 50 || rowCount * columnCount > 10_000) {
      tableDialog.showError(t('表が大きすぎます．500 行・50 列・合計 10000 セル以内にしてください．'));
      return;
    }
    const created = Array.from({ length: rowCount }, (_, row) => Array.from({ length: columnCount }, (_, column) => row === 0 ? t('列 {number}', { number: column + 1 }) : ''));
    tableInput.input.value = tableToTSV(created); delimiter.input.value = 'tab'; header.checked = true; updateTable();
    tablePreview.querySelector('textarea')?.focus();
  };
  for (const field of [format.input, delimiter.input, header]) field.addEventListener('change', updateTable);
  tableInsert.onclick = () => tableDialog.run(async () => {
    updateTable();
    if (!rows.length) return false;
    checkDocument(tableDocument);
    await insertText(tableInsertion(rows, { format: format.input.value, header: header.checked }), { ...tableDocument });
    return true;
  }).then(done => { if (done) tableDialog.dialog.close(); });

  function currentDocument() {
    const doc = getDocument();
    if (!canInsert(doc)) { onError(new Error(t('画像や表を挿入する TeX または Markdown の原稿を開いてください．'))); return null; }
    return { path: doc.path, content: String(doc.content || ''), projectRoot: getProject()?.root, pane: doc.pane, anchor: doc.anchor, head: doc.head, richAnchor: doc.richAnchor, richHead: doc.richHead };
  }
  function checkDocument(snapshot) {
    const current = getDocument();
    if (!current || !snapshot || getProject()?.root !== snapshot.projectRoot || current.path !== snapshot.path || current.pane !== snapshot.pane || String(current.content || '') !== snapshot.content || current.anchor !== snapshot.anchor || current.head !== snapshot.head || current.richAnchor !== snapshot.richAnchor || current.richHead !== snapshot.richHead) {
      throw new Error(t('原稿や選択範囲が変わりました．挿入先を選び直して，もう一度開いてください．'));
    }
  }
  function openImage(file) {
    imageDocument = currentDocument();
    if (!imageDocument) return;
    imageDialog.open();
    imageFileInput.input.value = ''; destination.input.value = ''; caption.input.value = ''; label.input.value = ''; width.input.value = '0.8';
    label.group.hidden = width.group.hidden = texHelp.hidden = isMarkdown(imageDocument.path);
    chosenFile = null; clearPreview(); imageSource.input.value = '';
    if (file) chooseImage(file);
    else imageFileInput.input.focus();
  }
  function openTable(text = '') {
    tableDocument = currentDocument();
    if (!tableDocument) return;
    tableDialog.open(); tableInput.input.value = text; format.input.value = isMarkdown(tableDocument.path) ? 'markdown' : 'tex'; delimiter.input.value = 'auto'; header.checked = true;
    updateTable(); tableInput.input.focus();
  }
  function handleFiles(event, files) {
    const available = [...(files || [])].filter(imageFile);
    if (!available.length || !canInsert(getDocument())) return false;
    event.preventDefault(); event.stopPropagation();
    if (available.length > 1) { onError(new Error(t('画像は 1 枚ずつ挿入してください．'))); return true; }
    openImage(available[0]); return true;
  }
  return {
    openImage, openTable,
    handlePaste: event => handleFiles(event, event.clipboardData?.files),
    handleDrop: event => handleFiles(event, event.dataTransfer?.files),
    destroy() { clearTimeout(tableTimer); clearPreview(); imageDialog.destroy(); tableDialog.destroy(); },
  };
}
