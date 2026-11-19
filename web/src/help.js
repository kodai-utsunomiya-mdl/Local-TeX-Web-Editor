import { t, getLanguage, onLanguageChange } from './i18n.js';
import { shortcutModifier } from './platform-keys.js';

const repository = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor';
const website = 'https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/';

export function getHelpLinks(language = 'en', storeEdition = false) {
  return {
    guide: website + (language === 'ja' ? 'ja/' : ''),
    releases: `${repository}/releases/latest`,
    issues: `${repository}/issues`,
    update: storeEdition ? `https://apps.microsoft.com/detail/9P6QF32N19HG?hl=${language === 'ja' ? 'ja-jp' : 'en-us'}` : `${repository}/releases/latest`,
  };
}

export function getHelpShortcuts(modifier = shortcutModifier) {
  return [
    ['F1', t('ヘルプを開く')],
    [`${modifier} + S`, t('現在のファイルを保存')],
    [`${modifier} + Shift + S`, t('開いているファイルをすべて保存')],
    [`${modifier} + Enter`, t('保存して TeX をコンパイル，または Markdown を更新')],
    [`${modifier} + F`, t('フォーカス中の原稿または PDF を検索')],
    [`${modifier} + Shift + F`, t('プロジェクト全体を検索・置換')],
    ['Alt + ← / →', t('移動した場所を戻る / 進む')],
    [`${modifier} + Z`, t('原稿の編集を元に戻す')],
    [modifier === 'Cmd' ? 'Cmd + Shift + Z' : 'Ctrl + Y', t('原稿の編集をやり直す')],
    [`${modifier} + /`, t('原稿のコメントを切り替える')],
    ['Ctrl + Space', t('原稿で補完を開く')],
    ['Tab / Shift + Tab', t('原稿のインデントを増減')],
    ['Enter / Shift + Enter', t('検索欄で次または前の結果へ移動')],
    [`${modifier} + Enter`, t('検索・置換欄に改行を入力')],
    ['Esc', t('検索欄やダイアログを閉じる')],
    [t('Ctrl + ホイール / ピンチ'), t('原稿の文字サイズまたは PDF の倍率を変更')],
    [t('{value0} + クリック', { value0: modifier }), t('原稿から PDF または Markdown の該当箇所へ移動')],
    [t('プレビューをダブルクリック'), t('PDF または Markdown から原稿の行へ移動')],
    ['← / → / ↑ / ↓', t('境界にフォーカスして幅または高さを変更')],
    [t('Enter / ダブルクリック'), t('境界の幅または高さを初期値に戻す')],
  ];
}

export function buildEnvironmentInfo(meta) {
  const unknown = t('未確認');
  const version = typeof meta?.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}$/.test(meta.version) ? meta.version : unknown;
  const platforms = { windows: 'Windows', darwin: 'macOS', linux: 'Linux', freebsd: 'FreeBSD' };
  const architectures = { amd64: 'x64 (amd64)', arm64: 'Arm64', '386': 'x86', arm: 'Arm' };
  const available = value => value ? t('利用可能') : t('見つからない');
  const year = meta?.texPackages?.year;
  const lines = [
    'Local TeX Web Editor',
    `${t('アプリのバージョン')}: ${version}`,
    `OS: ${Object.hasOwn(platforms, meta?.platform) ? platforms[meta.platform] : unknown}`,
    `${t('アプリのアーキテクチャ')}: ${Object.hasOwn(architectures, meta?.architecture) ? architectures[meta.architecture] : unknown}`,
    `${t('配布形態')}: ${meta ? meta.packageIdentity ? 'Microsoft Store (MSIX)' : 'ZIP / ' + t('直接起動') : unknown}`,
    `TeX Live: ${Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : unknown}`,
    `latexmk: ${typeof meta?.latexmk === 'string' ? available(meta.latexmk.length > 0) : unknown}`,
    `SyncTeX: ${typeof meta?.synctex === 'string' ? available(meta.synctex.length > 0) : unknown}`,
  ];
  const programs = Array.isArray(meta?.texPackages?.programs) ? meta.texPackages.programs : [];
  for (const name of ['pdflatex', 'lualatex', 'xelatex', 'uplatex', 'platex', 'dvipdfmx', 'bibtex', 'upbibtex', 'biber']) {
    const program = programs.find(item => item?.name === name);
    lines.push(`${name}: ${typeof program?.available === 'boolean' ? available(program.available) : unknown}`);
  }
  return lines.join('\n');
}

export function createHelp({ button, dialog, getMeta, getActions, onOpenSettings, onOpenLog, isClosed }) {
  const document = dialog.ownerDocument;
  const byId = id => dialog.querySelector(`#${id}`);
  const shortcuts = byId('help-shortcut-list');
  const information = byId('help-environment');
  let shortcutsLanguage = null;

  function refresh() {
    const meta = getMeta();
    const links = getHelpLinks(getLanguage(), !!meta?.packageIdentity);
    for (const [name, href] of Object.entries(links)) byId(`help-${name}`).href = href;
    byId('help-update').textContent = meta?.packageIdentity ? t('Microsoft Store で最新版を確認') : t('GitHub Releases で最新版を確認');
    const text = buildEnvironmentInfo(meta);
    if (information.value !== text) information.value = text;
    if (shortcutsLanguage !== getLanguage()) {
      shortcutsLanguage = getLanguage(); shortcuts.replaceChildren();
      for (const [keys, label] of getHelpShortcuts()) {
        const row = document.createElement('tr'), action = document.createElement('td'), keyCell = document.createElement('td'), shortcut = document.createElement('kbd');
        action.textContent = label; shortcut.textContent = keys;
        keyCell.append(shortcut); row.append(action, keyCell); shortcuts.append(row);
      }
    }
    const actions = getActions();
    byId('help-open-log').disabled = !actions.log;
    byId('help-open-settings').disabled = !actions.settings;
    byId('help-open-settings').textContent = actions.returnToSettings ? t('設定に戻る') : t('設定を開く');
    byId('help-action-note').hidden = !actions.blockedByDialog;
  }

  function show() {
    if (isClosed()) return;
    refresh(); byId('help-copy-status').textContent = '';
    if (!dialog.open) dialog.showModal();
    button.setAttribute('aria-expanded', 'true');
  }

  button.addEventListener('click', show);
  byId('help-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => button.setAttribute('aria-expanded', 'false'));
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'F1' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    event.preventDefault(); show();
  }, true);
  byId('help-open-log').addEventListener('click', () => { if (getActions().log) { dialog.close(); onOpenLog(); } });
  byId('help-open-settings').addEventListener('click', () => { if (getActions().settings) { dialog.close(); onOpenSettings(); } });
  byId('help-copy-environment').addEventListener('click', async () => {
    refresh();
    try {
      await document.defaultView.navigator.clipboard.writeText(information.value);
      byId('help-copy-status').textContent = t('環境情報をコピーしました．');
    } catch {
      information.focus(); information.select();
      byId('help-copy-status').textContent = t('下の環境情報を選択しました．コピーの操作で取得できます．');
    }
  });
  onLanguageChange(refresh);
  refresh();
  return { show, refresh };
}
