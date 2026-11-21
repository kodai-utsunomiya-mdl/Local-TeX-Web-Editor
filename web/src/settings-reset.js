import { t } from './i18n.js';
import { createImportDialog, element, translated } from './import-dialog.js';

const choices = [
  ['settings', '設定と記憶した操作', '外観，編集の設定，最近開いたプロジェクト，タブと編集位置，TeX の選択を初期値に戻します．'],
  ['drafts', '未保存の草稿', 'ファイルへ保存していない本文のコピーを削除します．'],
  ['history', '編集履歴', '以前の本文を復元するために記録した履歴を削除します．'],
  ['templates', '自作テンプレート', '自分で追加したテンプレートを削除します．'],
  ['cache', 'PDF と SyncTeX のキャッシュ', 'プレビュー用にアプリへ保存した PDF と SyncTeX のコピーを削除します．'],
];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createSettingsReset({ api, onReset, reload }) {
  const view = createImportDialog('settings-reset-dialog', '設定と記憶した情報を初期化');
  view.dialog.classList.add('settings-reset-dialog');
  view.body.append(translated('p', '初期化する内容を選びます．設定以外の項目には，原稿や自作の内容が含まれます．', { class: 'field-help' }));
  const fields = element('fieldset', { class: 'settings-reset-options', disabled: '' });
  fields.append(translated('legend', '初期化する内容', { class: 'visually-hidden' }));
  const inputs = new Map(), sizes = new Map();
  for (const [key, title, description] of choices) {
    const row = element('label', { class: 'settings-reset-option', for: `reset-${key}` });
    const input = element('input', { id: `reset-${key}`, type: 'checkbox', name: key });
    const text = element('span', { class: 'settings-reset-option-text' });
    const size = element('span', { class: 'settings-reset-size' });
    text.append(translated('strong', title), translated('span', description, { class: 'field-help' }), size);
    row.append(input, text); fields.append(row); inputs.set(key, input); sizes.set(key, size);
  }
  const directoryLabel = translated('p', 'アプリの保存先', { class: 'field-label' });
  const directory = element('code', { class: 'settings-reset-directory' });
  const confirmationLabel = element('label', { class: 'settings-reset-confirmation' });
  const confirmation = element('input', { id: 'reset-confirmation', type: 'checkbox', disabled: '' });
  confirmationLabel.append(confirmation, translated('span', '選んだ内容を初期化することを確認しました．'));
  view.body.append(fields,
    translated('p', 'プロジェクトのファイルと導入した TeX は引き続き使用できます．初期化が終わるとアプリを開き直します．', { class: 'field-help' }),
    directoryLabel, directory, confirmationLabel);
  const cancel = translated('button', 'キャンセル', { type: 'button', class: 'button' });
  const submit = translated('button', '選んだ内容を初期化', { id: 'settings-reset-submit', type: 'button', class: 'button button-danger', disabled: '' });
  view.footer.append(cancel, submit);
  let loaded = false, complete = false;
  const update = () => {
    fields.disabled = !loaded || view.busy || complete;
    confirmation.disabled = !loaded || view.busy || complete;
    submit.disabled = !loaded || view.busy || complete || !confirmation.checked || ![...inputs.values()].some(input => input.checked);
  };
  fields.addEventListener('change', update);
  confirmation.addEventListener('change', update);
  cancel.addEventListener('click', () => view.close());
  submit.addEventListener('click', () => {
    if (submit.disabled) return;
    const selection = Object.fromEntries([...inputs].map(([key, input]) => [key, input.checked]));
    const task = view.run(async () => {
      const result = await onReset({ ...selection, confirmation: true });
      if (!result) return;
      complete = true;
      if (!result.warning) { reload(); return; }
      view.body.replaceChildren(translated('p', '初期化が完了しました．'), element('p', { class: 'field-help' }, result.warning));
      const open = translated('button', 'アプリを開き直す', { id: 'settings-reset-reload', type: 'button', class: 'button button-primary' });
      open.addEventListener('click', reload);
      view.footer.replaceChildren(open);
      view.dialog.addEventListener('cancel', event => event.preventDefault());
      view.dialog.addEventListener('close', reload, { once: true });
    });
    update(); task.finally(update);
  });

  let notice = null;
  const downloads = [];
  return {
    async open() {
      if (complete) return;
      loaded = false; confirmation.checked = false;
      for (const [key, input] of inputs) { input.checked = key === 'settings'; sizes.get(key).textContent = ''; }
      directory.textContent = t('読み込み中…'); update(); view.open();
      await view.run(async () => {
        const summary = await api('/api/settings/reset');
        directory.textContent = summary.directory || '';
        for (const [key, size] of sizes) size.textContent = t('ファイル数: {files}，容量: {size}', { files: summary[key]?.files || 0, size: formatBytes(summary[key]?.bytes || 0) });
        loaded = true;
      });
      update();
    },
    showNotice(documents) {
      if (notice) return;
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      notice = element('dialog', { id: 'settings-reset-notice', class: 'dialog settings-reset-dialog', 'aria-labelledby': 'settings-reset-notice-title' });
      notice.append(translated('h2', 'アプリの情報が初期化されました', { id: 'settings-reset-notice-title' }),
        translated('p', '初期化後の状態を読み込むため，このタブを開き直してください．', { class: 'field-help' }));
      if (documents.length) {
        notice.append(translated('p', 'このタブの未保存の原稿をダウンロードできます．必要なファイルを保存してから，アプリを開き直してください．', { class: 'field-help' }));
        const list = element('ul', { class: 'settings-reset-downloads' });
        for (const doc of documents) {
          const url = URL.createObjectURL(new Blob([doc.content], { type: 'text/plain;charset=utf-8' }));
          downloads.push(url);
          const item = element('li');
          item.append(element('a', { href: url, download: doc.name }, doc.path)); list.append(item);
        }
        notice.append(list);
      }
      const actions = element('div', { class: 'dialog-actions' });
      const open = translated('button', 'アプリを開き直す', { id: 'settings-reset-reload', class: 'button button-primary', type: 'button' });
      open.addEventListener('click', reload); actions.append(open); notice.append(actions);
      notice.addEventListener('cancel', event => event.preventDefault());
      document.body.append(notice); notice.showModal();
    },
    destroy() { view.destroy(); notice?.remove(); for (const url of downloads) URL.revokeObjectURL(url); },
  };
}
