import { getLanguage } from './i18n.js';

const labels = {
  en: {
    title: 'Add TeX packages', intro: 'Add the packages your documents use to the selected TeX installation.',
    available: 'Available', missing: 'Not found', year: 'TeX Live',
    unavailable: 'Set up TeX first, or select an existing TeX Live, MacTeX or TinyTeX installation in Settings.',
    external: 'Add packages with the official management tool for this TeX installation. Refresh the package list after making changes.',
    unsupported: 'This installation cannot be changed from the app. Use its distribution’s management tool or select another TeX installation in Settings.',
    check: 'Open TeX management to check the selected installation and add packages.', manage: 'Manage TeX…',
    setup: 'Set up TeX…', openManager: 'Open the TeX management tool',
    packages: 'Packages to add', basic: 'latexmk and SyncTeX', japanese: 'Japanese typesetting',
    japaneseHelp: 'collection-langjapanese includes Japanese engines, classes and fonts, with their dependencies.',
    reinstall: 'Download these packages again if their files are missing',
    invalidPackages: 'Enter package names separated by spaces, for example: latexmk synctex.',
    docs: 'Installation and package guide', docsURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor#manage-tex-packages-and-installations',
    addInApp: 'Review packages to add…', managedHelp: 'Review the packages and the selected TeX environment before downloading.',
  },
  ja: {
    title: 'TeX パッケージを追加', intro: '原稿で使うパッケージを，選択中の TeX の環境へ追加できます．',
    available: '利用可能', missing: '見つかりません', year: 'TeX Live',
    unavailable: 'TeX を導入するか，設定で既存の TeX Live，MacTeX，TinyTeX を指定してください．',
    external: 'この TeX の公式管理ツールでパッケージを追加できます．変更後はパッケージ一覧を更新してください．',
    unsupported: 'この環境はアプリから変更できません．配布元の管理ツールを使うか，設定で別の TeX を選んでください．',
    check: 'TeX の管理画面で，選択中の環境を確認してパッケージの追加へ進めます．', manage: 'TeX を管理…',
    setup: 'TeX をセットアップ…', openManager: 'TeX の管理ツールを開く',
    packages: '追加するパッケージ', basic: 'latexmk と SyncTeX', japanese: '日本語の組版',
    japaneseHelp: 'collection-langjapanese には，日本語のエンジン，文書クラス，フォントと，それらが使うパッケージが含まれます．',
    reinstall: 'ファイルが欠けている場合は，同じパッケージを再取得する',
    invalidPackages: 'パッケージ名をスペースで区切って入力してください．例: latexmk synctex',
    docs: 'TeX の導入とパッケージの追加手順', docsURL: 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/blob/main/README.ja.md#tex-のパッケージと環境を管理する',
    addInApp: '追加する内容を確認…', managedHelp: '追加するパッケージと，選択中の TeX の環境を確認してからダウンロードします．',
  },
};

export function parseTeXPackageNames(input) {
  const names = [...new Set(String(input || '').trim().split(/\s+/))];
  return !names.length || names.length > 128 || names.some(name => !/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/.test(name)) ? null : names;
}

export function teXPackagePresets(info) {
  const basic = ['latexmk', 'synctex', ...(info?.shell === 'powershell' ? ['synctex.windows'] : [])];
  const missing = [...new Set((info?.programs || []).filter(program => !program.available && ['latexmk', 'synctex'].includes(program.name))
    .flatMap(program => program.packages || []))];
  return { basic, japanese: ['collection-langjapanese', ...basic], suggested: missing.length ? missing : basic, reinstall: missing.length > 0 };
}

const views = new WeakMap();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function renderTeXPackagesHelp(container, info, { managed = false, canInstall = managed, canSetup = true, managerApplication = '', environmentKnown = true,
  busy = false, onInstall, onSetup, onOpenManager, onManage } = {}) {
  if (!container) return;
  const language = getLanguage();
  const fingerprint = JSON.stringify([language, info, canInstall, canSetup, managerApplication, environmentKnown, busy, !!onInstall, !!onSetup, !!onOpenManager, !!onManage]);
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
  if (info?.manager) {
    const location = element('p', undefined, 'tex-package-location');
    location.append(element('span', info.year ? `${text.year} ${info.year} · ` : ''), element('code', info.manager));
    details.append(location);
  }
  if (!canInstall || !onInstall) {
    const canOpenManager = !!managerApplication && !!onOpenManager;
    const canCheck = !environmentKnown && !!info?.manager && !!onManage;
    details.append(element('p', canOpenManager ? text.external : canCheck ? text.check : info?.manager ? text.unsupported : text.unavailable));
    const actions = element('div', undefined, 'tex-package-actions');
    if (canOpenManager) {
      const openManager = element('button', text.openManager, 'button'); openManager.type = 'button';
      openManager.dataset.testid = 'tex-package-open-manager'; openManager.disabled = busy;
      openManager.addEventListener('click', () => { if (!busy) onOpenManager(); });
      actions.append(openManager);
    } else if (canCheck) {
      const manage = element('button', text.manage, 'button'); manage.type = 'button';
      manage.dataset.testid = 'tex-package-manage'; manage.disabled = busy;
      manage.addEventListener('click', () => { if (!busy) onManage(); });
      actions.append(manage);
    }
    if (canSetup && onSetup) {
      const setup = element('button', text.setup, 'button'); setup.type = 'button';
      setup.dataset.testid = 'tex-package-setup'; setup.disabled = busy;
      setup.addEventListener('click', () => { if (!busy) onSetup(); });
      actions.append(setup);
    }
    if (actions.childElementCount) details.append(actions);
    details.append(guide);
    container.replaceChildren(details);
    views.set(container, { fingerprint, read: () => ({ ...saved, open: details.open }) });
    return;
  }

  const choices = teXPackagePresets(info);
  const packagesLabel = element('label', text.packages);
  const packages = element('input');
  packages.type = 'text'; packages.value = saved.packages ?? choices.suggested.join(' ');
  packages.placeholder = 'latexmk synctex'; packages.spellcheck = false; packages.disabled = busy;
  packages.dataset.testid = 'tex-package-names';
  packagesLabel.append(packages);
  const presets = element('div', undefined, 'tex-package-presets');
  const basic = element('button', text.basic, 'button'); basic.type = 'button'; basic.disabled = busy;
  const japanese = element('button', text.japanese, 'button'); japanese.type = 'button'; japanese.disabled = busy;
  presets.append(basic, japanese);
  const reinstallLabel = element('label', undefined, 'tex-package-check');
  const reinstall = element('input'); reinstall.type = 'checkbox'; reinstall.checked = saved.reinstall ?? choices.reinstall; reinstall.disabled = busy;
  reinstallLabel.append(reinstall, element('span', text.reinstall));
  const error = element('p', undefined, 'tex-package-error'); error.setAttribute('role', 'status');
  const add = element('button', text.addInApp, 'button'); add.type = 'button'; add.dataset.testid = 'tex-package-add';
  const actions = element('div', undefined, 'tex-package-actions'); actions.append(add);
  details.append(packagesLabel, presets, element('p', text.japaneseHelp), reinstallLabel, element('p', text.managedHelp), error, actions, guide);

  function update() {
    const names = parseTeXPackageNames(packages.value);
    add.disabled = busy || !names;
    error.textContent = packages.value.trim() && !names ? text.invalidPackages : '';
  }
  add.addEventListener('click', () => {
    const names = parseTeXPackageNames(packages.value);
    if (names && !busy) onInstall({ packages: names, reinstall: reinstall.checked });
  });
  packages.addEventListener('input', update);
  reinstall.addEventListener('change', update);
  basic.addEventListener('click', () => { packages.value = choices.basic.join(' '); reinstall.checked = true; update(); });
  japanese.addEventListener('click', () => { packages.value = choices.japanese.join(' '); reinstall.checked = false; update(); });
  update();
  container.replaceChildren(details);
  views.set(container, { fingerprint, read: () => ({ open: details.open, packages: packages.value, reinstall: reinstall.checked }) });
}
