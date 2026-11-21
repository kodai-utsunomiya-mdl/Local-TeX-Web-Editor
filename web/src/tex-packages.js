import { getLanguage } from './i18n.js';

const labels = {
  en: {
    title: 'Add TeX packages', intro: 'You can start with a small TeX installation and add the packages your documents use.',
    available: 'Available', missing: 'Not found', folder: 'TeX folder', manager: 'Package manager', year: 'TeX Live',
    unknown: 'Year not found; commands use your configured repository.',
    unavailable: 'Select a TeX Live folder containing tlmgr to prepare commands here.',
    packages: 'Packages to add', basic: 'latexmk and SyncTeX', japanese: 'Japanese typesetting',
    japaneseHelp: 'collection-langjapanese includes Japanese engines, classes and fonts, with their dependencies.',
    reinstall: 'Download these packages again if their files are missing', administrator: 'Use sudo for installation',
    terminalWindows: 'Copy these commands into PowerShell and run them in order. Close any running compilation first.',
    terminalMac: 'Copy these commands into Terminal and run them in order. Close any running compilation first.',
    copied: 'Copied', copy: 'Copy commands', copyError: 'Select the commands below and copy them.',
    invalidPackages: 'Enter package names separated by spaces, for example: latexmk synctex.',
    search: 'Find a package from a missing file', filename: 'Missing file name',
    searchHelp: 'If the log says a .sty or .cls file is missing, search for its package. Enter the package name from the result above.',
    invalidFilename: 'Enter only the file name, for example: siunitx.sty.',
    after: 'After installation, reopen Settings to refresh the available programs, then compile again.',
    docs: 'Installation and package guide', docsURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor#start-with-a-smaller-tex-installation',
    addInApp: 'Add with the app…', managedHelp: 'Review the packages and the selected TeX environment before downloading.',
  },
  ja: {
    title: 'TeX パッケージを追加', intro: '小さめの TeX の構成から始め，原稿が使うパッケージを後から追加できます．',
    available: '利用可能', missing: '見つかりません', folder: 'TeX のフォルダー', manager: 'パッケージ管理', year: 'TeX Live',
    unknown: '年度を確認できないため，設定済みの取得先を使うコマンドを表示します．',
    unavailable: 'tlmgr がある TeX Live のフォルダーを指定すると，追加用のコマンドを表示します．',
    packages: '追加するパッケージ', basic: 'latexmk と SyncTeX', japanese: '日本語の組版',
    japaneseHelp: 'collection-langjapanese には，日本語のエンジン，文書クラス，フォントと，それらが使うパッケージが含まれます．',
    reinstall: 'ファイルが欠けている場合は，同じパッケージを再取得する', administrator: 'インストールに sudo を使う',
    terminalWindows: 'PowerShell にコピーし，上から順に実行してください．実行中のコンパイルは先に終了してください．',
    terminalMac: 'ターミナルにコピーし，上から順に実行してください．実行中のコンパイルは先に終了してください．',
    copied: 'コピーしました', copy: 'コマンドをコピー', copyError: '下のコマンドを選択してコピーしてください．',
    invalidPackages: 'パッケージ名をスペースで区切って入力してください．例: latexmk synctex',
    search: '不足しているファイルからパッケージを探す', filename: '不足しているファイル名',
    searchHelp: '.sty や .cls が見つからない場合は，このコマンドで収録先を探します．結果に出たパッケージ名を上の欄へ入力してください．',
    invalidFilename: 'ファイル名だけを入力してください．例: siunitx.sty',
    after: '追加後は設定を開き直すと，利用できるプログラムを再確認します．その後にコンパイルしてください．',
    docs: 'TeX の導入とパッケージの追加手順', docsURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.ja.md#小さめの構成から始める',
    addInApp: 'アプリで追加…', managedHelp: '追加するパッケージと，選択中の TeX の環境を確認してからダウンロードします．',
  },
};

export function parseTeXPackageNames(input) {
  const names = [...new Set(String(input || '').trim().split(/\s+/))];
  return !names.length || names.length > 128 || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/.test(name)) ? null : names;
}

export function packageInstallCommands(info, input, { reinstall = false, administrator = info?.shell === 'posix' } = {}) {
  if (!info?.commandPrefix) return '';
  const names = parseTeXPackageNames(input);
  if (!names) return '';
  const prefix = `${administrator && info.shell === 'posix' ? 'sudo ' : ''}${info.commandPrefix}`;
  return `${prefix} update --self\n${prefix} install${reinstall ? ' --reinstall' : ''} ${names.join(' ')}`;
}

export function packageSearchCommand(info, input) {
  if (!info?.commandPrefix) return '';
  const filename = String(input || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,149}$/.test(filename)) return '';
  const pattern = `/${filename.replace(/[.+]/g, '\\$&')}$`;
  return `${info.commandPrefix} search --global --file '${pattern}'`;
}

const views = new WeakMap();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderTeXPackagesHelp(container, info, { managed = false, canInstall = managed, busy = false, onInstall } = {}) {
  if (!container) return;
  const language = getLanguage();
  const fingerprint = JSON.stringify([language, info, managed, canInstall, busy, !!onInstall]);
  const previous = views.get(container);
  if (previous?.fingerprint === fingerprint) return;
  const saved = previous?.read?.() || {};
  const text = labels[language] || labels.en;
  const details = element('details', undefined, 'tex-packages');
  details.dataset.testid = 'tex-packages';
  details.open = saved.open || false;
  details.append(element('summary', text.title), element('p', text.intro));
  const guide = element('a', text.docs);
  guide.href = text.docsURL;
  guide.target = '_blank'; guide.rel = 'noreferrer';
  const programs = element('ul', undefined, 'tex-package-programs');
  for (const program of info?.programs || []) {
    const item = element('li');
    item.append(element('code', program.name), element('span', program.available ? text.available : text.missing));
    item.dataset.available = String(!!program.available);
    if (program.path) item.title = program.path;
    programs.append(item);
  }
  details.append(programs);
  if (!info?.commandPrefix) {
    details.append(element('p', text.unavailable), guide);
    container.replaceChildren(details);
    views.set(container, { fingerprint, read: () => ({ open: details.open }) });
    return;
  }
  const location = element('p', undefined, 'tex-package-location');
  location.append(element('span', info.year ? `${text.year} ${info.year} · ` : ''), element('code', info.manager));
  details.append(location);
  if (!info.year) details.append(element('p', text.unknown));

  const basePackages = info.shell === 'powershell' ? 'latexmk synctex synctex.windows' : 'latexmk synctex';
  const defaults = [...new Set((info.programs || []).filter(program => !program.available && ['latexmk', 'synctex'].includes(program.name)).flatMap(program => program.packages || []))].join(' ');
  const packagesLabel = element('label', text.packages);
  const packages = element('input');
  packages.type = 'text'; packages.value = saved.packages ?? (defaults || basePackages);
  packages.placeholder = 'latexmk synctex'; packages.spellcheck = false;
  packages.dataset.testid = 'tex-package-names';
  packagesLabel.append(packages);
  const presets = element('div', undefined, 'tex-package-presets');
  const basic = element('button', text.basic, 'button'); basic.type = 'button';
  const japanese = element('button', text.japanese, 'button'); japanese.type = 'button';
  presets.append(basic, japanese);
  const reinstallLabel = element('label', undefined, 'tex-package-check');
  const reinstall = element('input'); reinstall.type = 'checkbox'; reinstall.checked = saved.reinstall ?? !!defaults;
  reinstallLabel.append(reinstall, element('span', text.reinstall));
  const adminLabel = element('label', undefined, 'tex-package-check');
  const administrator = element('input'); administrator.type = 'checkbox'; administrator.checked = saved.administrator ?? !managed;
  adminLabel.hidden = info.shell !== 'posix';
  adminLabel.append(administrator, element('span', text.administrator));
  details.append(packagesLabel, presets, element('p', text.japaneseHelp), reinstallLabel, adminLabel);
  let addInApp = null;
  if (canInstall && onInstall) {
    addInApp = element('button', text.addInApp, 'button'); addInApp.type = 'button'; addInApp.dataset.testid = 'tex-package-add';
    addInApp.addEventListener('click', () => {
      const names = parseTeXPackageNames(packages.value);
      if (names && !busy) onInstall({ packages: names, reinstall: reinstall.checked });
    });
    details.append(element('p', text.managedHelp), addInApp);
  }
  details.append(element('p', info.shell === 'powershell' ? text.terminalWindows : text.terminalMac));

  function commandBox(testid) {
    const wrapper = element('div', undefined, 'tex-package-command');
    const output = element('textarea');
    output.readOnly = true; output.spellcheck = false; output.rows = 3;
    output.dataset.testid = testid; output.setAttribute('aria-label', text.copy);
    const error = element('p'); error.setAttribute('role', 'status');
    const copy = element('button', text.copy, 'button'); copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(output.value);
        error.textContent = text.copied;
      } catch {
        output.focus(); output.select(); error.textContent = text.copyError;
      }
    });
    wrapper.append(output, copy, error);
    return { wrapper, output, error, copy };
  }
  const installBox = commandBox('tex-package-install-command');
  details.append(installBox.wrapper);
  const searchDetails = element('details', undefined, 'tex-package-search');
  searchDetails.open = saved.searchOpen || false;
  searchDetails.append(element('summary', text.search), element('p', text.searchHelp));
  const filenameLabel = element('label', text.filename);
  const filename = element('input'); filename.type = 'text'; filename.value = saved.filename || '';
  filename.placeholder = 'siunitx.sty'; filename.spellcheck = false;
  filename.dataset.testid = 'tex-package-filename';
  filenameLabel.append(filename); searchDetails.append(filenameLabel);
  const searchBox = commandBox('tex-package-search-command');
  searchDetails.append(searchBox.wrapper);
  details.append(searchDetails, element('p', text.after), guide);

  function updateInstall() {
    const command = packageInstallCommands(info, packages.value, { reinstall: reinstall.checked, administrator: administrator.checked });
    installBox.output.value = command; installBox.copy.disabled = !command;
    installBox.error.textContent = command ? '' : text.invalidPackages;
    if (addInApp) addInApp.disabled = busy || !parseTeXPackageNames(packages.value);
  }
  function updateSearch() {
    const command = packageSearchCommand(info, filename.value);
    searchBox.output.value = command; searchBox.copy.disabled = !command;
    searchBox.error.textContent = command || !filename.value ? '' : text.invalidFilename;
  }
  packages.addEventListener('input', updateInstall);
  reinstall.addEventListener('change', updateInstall);
  administrator.addEventListener('change', updateInstall);
  filename.addEventListener('input', updateSearch);
  basic.addEventListener('click', () => { packages.value = basePackages; reinstall.checked = true; updateInstall(); });
  japanese.addEventListener('click', () => { packages.value = `collection-langjapanese ${basePackages}`; reinstall.checked = false; updateInstall(); });
  updateInstall(); updateSearch();
  container.replaceChildren(details);
  views.set(container, { fingerprint, read: () => ({
    open: details.open, packages: packages.value, reinstall: reinstall.checked,
    administrator: administrator.checked, searchOpen: searchDetails.open, filename: filename.value,
  }) });
}
