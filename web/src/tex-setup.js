import { t, onLanguageChange, translateElements } from './i18n.js';
import { createImportDialog, element, translated, labelledInput } from './import-dialog.js';
import { parseTeXPackageNames } from './tex-packages.js';
import { TeXSetupSession, isTeXSetupRunning, missingTeXPrograms, texSetupProgress, teXEnvironment } from './tex-setup-session.js';

export { isTeXSetupRunning, missingTeXPrograms, teXEnvironment } from './tex-setup-session.js';

export function formatTeXSetupBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return t('取得時に確認します');
  if (value === 0) return '0 B';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} kB`;
  return `${Math.ceil(value)} B`;
}

function sourceURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
}

const stages = {
  downloading: 'TeX をダウンロードしています…', verifying: 'ダウンロードしたファイルを確認しています…',
  extracting: 'TeX のファイルを展開しています…', packages: 'TeX パッケージを追加しています…',
  checking: '利用できるプログラムを確認しています…', complete: 'TeX のセットアップが完了しました．',
  removing: 'TeX パッケージを削除しています…', deleting: 'TeX の環境を削除しています…',
  elevating: '管理者の承認を待っています…',
};

export function createTeXSetup({ api, getMeta, home, indicator, getCompileTarget = () => null,
  onToolsChanged = async () => {}, onStateChange = () => {}, onCompile = async () => {},
  onCreateSample = () => {}, onManage = () => {}, isBlocked = () => false, getFallbackFocus = () => null, onClose = () => {} }) {
  const ui = createImportDialog('tex-setup-dialog', 'TeX をセットアップ');
  ui.dialog.classList.add('tex-setup-dialog');
  const introduction = translated('p', 'TeX の環境をこのアプリから導入できます．Markdown の編集には TeX は不要です．', { class: 'dialog-description' });
  const environment = element('section', { class: 'tex-setup-environment' });
  const environmentTitle = translated('h3', '現在の TeX');
  const environmentStatus = element('p', { id: 'tex-setup-environment-status' });
  const programs = element('ul', { class: 'tex-setup-programs' });
  environment.append(environmentTitle, environmentStatus, programs);
  const review = element('section', { id: 'tex-setup-review' });
  const contentsTitle = translated('h3', 'インストールするもの');
  const contents = element('p', { id: 'tex-setup-contents' });
  const release = element('p', { class: 'field-help', id: 'tex-setup-release' });
  const packageList = element('ul', { id: 'tex-setup-package-list', class: 'tex-setup-package-list' });
  const reinstallNote = translated('p', '選んだパッケージのファイルを再取得します．', { class: 'field-help', hidden: '' });
  const externalNote = translated('p', '現在の TeX と別のフォルダーに導入し，完了後はこのアプリで使います．', { class: 'field-help', hidden: '' });
  const sharedNote = translated('p', 'この TeX を使う他のアプリやユーザーにも変更が反映されます．', { class: 'field-help', hidden: '' });
  const elevationNote = translated('p', '開始すると，OS が管理者の承認を求めます．表示された TeX の保存先を確認して承認してください．', { class: 'field-help', hidden: '' });
  const sources = element('div', { class: 'tex-setup-sources' });
  const sourcesTitle = translated('h3', 'ダウンロードの取得元');
  const archiveLink = element('a', { target: '_blank', rel: 'noopener noreferrer', id: 'tex-setup-source' });
  const repositoryLink = element('a', { target: '_blank', rel: 'noopener noreferrer', id: 'tex-setup-repository' });
  const repositoryNote = translated('p', 'パッケージは，選択した TeX の tlmgr に設定された取得先からダウンロードします．', { class: 'field-help', hidden: '' });
  sources.append(sourcesTitle, archiveLink, repositoryLink, repositoryNote);
  const capacity = element('dl', { class: 'tex-setup-capacity' });
  const archiveRow = element('div');
  const archiveSize = element('dd', { id: 'tex-setup-archive-size' });
  archiveRow.append(translated('dt', 'アーカイブのダウンロード'), archiveSize);
  const extraRow = element('div');
  extraRow.append(translated('dt', '追加のダウンロードと展開後の容量'), translated('dd', '追加するパッケージと依存するパッケージによって変わります．保存先の空き容量を確認してください．'));
  capacity.append(archiveRow, extraRow);
  const estimate = element('p', { class: 'field-help', id: 'tex-setup-size-estimate' });
  const parent = labelledInput('tex-setup-parent', 'インストール先の親フォルダー', 'input', { autocomplete: 'off', spellcheck: 'false' });
  const pathField = element('div', { class: 'path-field' });
  const browse = translated('button', '参照…', { id: 'tex-setup-browse', type: 'button', class: 'button' });
  pathField.append(parent.input, browse); parent.group.append(pathField);
  parent.group.append(translated('p', 'このフォルダー内にアプリ用の TeX フォルダーを作ります．空欄の場合は推奨の場所を使います．', { class: 'field-help' }));
  const pickerStatus = translated('p', 'フォルダーの選択画面で選んでください．', { role: 'status', hidden: '' });
  const destination = element('p', { id: 'tex-setup-package-destination', class: 'tex-setup-path', hidden: '' });
  const reviewStatus = translated('p', '追加先の TeX の環境を確認しています…', { id: 'tex-setup-review-status', class: 'field-help', role: 'status', hidden: '' });
  const unsupported = translated('p', 'この環境ではアプリからの導入に対応していません．設定で既存の TeX を指定してください．', { class: 'field-help', hidden: '' });
  review.append(contentsTitle, contents, release, packageList, reinstallNote, externalNote, sharedNote, elevationNote, sources, capacity, estimate, parent.group, pickerStatus, destination, reviewStatus, unsupported);
  const progressPanel = element('section', { id: 'tex-setup-progress-panel', hidden: '' });
  const status = element('p', { id: 'tex-setup-stage', role: 'status', 'aria-live': 'polite' });
  const progress = element('progress', { id: 'tex-setup-progress', max: '1', 'aria-label': t('TeX のセットアップの進捗'), 'data-i18n-aria-label': 'TeX のセットアップの進捗' });
  const downloaded = element('p', { id: 'tex-setup-downloaded', class: 'field-help' });
  const location = element('p', { id: 'tex-setup-directory', class: 'tex-setup-path' });
  const continueNote = translated('p', 'この画面を閉じても処理は続きます．Markdown の編集や保存を続けられます．', { class: 'field-help' });
  const cannotStop = translated('p', '削除を実行しています．この処理の途中では停止できません．', { class: 'field-help', hidden: '' });
  const targetNote = element('p', { class: 'field-help' });
  const logDetails = element('details', { class: 'tex-setup-log' });
  const log = element('pre', { id: 'tex-setup-log', tabindex: '0', 'aria-label': t('セットアップのログ'), 'data-i18n-aria-label': 'セットアップのログ' });
  const copyLog = translated('button', 'ログをコピー', { type: 'button', class: 'button button-small' });
  const copyStatus = element('p', { role: 'status', class: 'field-help' });
  logDetails.append(translated('summary', 'セットアップのログ'), log, copyLog, copyStatus);
  progressPanel.append(status, progress, downloaded, location, continueNote, cannotStop, targetNote, logDetails);
  const recheck = translated('button', '環境を再確認', { id: 'tex-setup-recheck', type: 'button', class: 'button button-small' });
  ui.body.append(introduction, environment, review, progressPanel, recheck);
  const close = translated('button', 'キャンセル', { id: 'tex-setup-close', type: 'button', class: 'button' });
  const retry = translated('button', '内容を確認して再試行…', { id: 'tex-setup-retry', type: 'button', class: 'button', hidden: '' });
  const stop = translated('button', 'セットアップを停止', { id: 'tex-setup-stop', type: 'button', class: 'button button-stop', hidden: '' });
  const start = translated('button', 'ダウンロードしてインストール', { id: 'tex-setup-start', type: 'button', class: 'button button-primary' });
  const compile = translated('button', 'コンパイルする', { id: 'tex-setup-compile', type: 'button', class: 'button button-primary', hidden: '' });
  const sample = translated('button', 'サンプルを作成…', { id: 'tex-setup-sample', type: 'button', class: 'button button-primary', hidden: '' });
  ui.footer.append(close, retry, stop, start, compile, sample);

  const homeTitle = translated('h2', 'TeX の準備');
  const homeStatus = element('p', { id: 'tex-setup-home-status' });
  const homeNote = translated('p', 'Markdown は，TeX を導入せずに編集できます．', { class: 'field-help' });
  const homeOpen = translated('button', 'TeX をセットアップ…', { id: 'home-tex-setup', type: 'button', class: 'button' });
  if (home) { home.classList.add('tex-setup-home'); home.append(homeTitle, homeStatus, homeNote, homeOpen); }

  let session;
  let view = 'review';
  let context = { reason: 'settings', operation: 'install', packages: [], reinstall: false, target: null };
  let returnFocus = null;
  let parentEdited = false;
  let picker = null;
  let packageReader = null;
  let packageReviewLoading = false;
  let generation = 0;
  let programSignature = '';
  let packageSignature = '';
  let localError = null;
  let destroyed = false;

  function describeStatus() {
    const snapshot = session.snapshot;
    if (session.pending === 'start') return t('セットアップを開始しています…');
    if (session.pending === 'stop' || snapshot?.status === 'cancelling') return t('セットアップの停止を待っています…');
    if (snapshot?.status === 'succeeded') return session.checking ? t('利用できるプログラムを確認しています…')
      : t(snapshot.operation === 'uninstall' ? 'TeX の環境を削除しました．'
        : snapshot.operation === 'remove-packages' ? 'TeX パッケージの削除が完了しました．' : 'TeX のセットアップが完了しました．');
    if (snapshot?.status === 'cancelled') return t('TeX のセットアップを停止しました．');
    if (snapshot?.status === 'failed') return t('TeX のセットアップを完了できませんでした．');
    if (snapshot?.status === 'running') return t(stages[snapshot.stage] || 'TeX をセットアップしています…');
    return t('TeX の環境を確認します．');
  }

  function setLink(link, url, label) {
    const href = sourceURL(url);
    link.hidden = !href;
    if (href) { link.href = href; link.textContent = `${label}: ${href}`; }
    else link.removeAttribute('href');
  }

  function render() {
    if (!session || destroyed) return;
    const snapshot = session.snapshot;
    const selectedEnvironment = context.operation === 'packages' && context.environment ? context.environment : teXEnvironment(snapshot);
    const installation = snapshot?.install || snapshot;
    const meta = getMeta() || {};
    const working = session.busy;
    const locked = isBlocked();
    const packagesMode = context.operation === 'packages';
    if (working) view = 'progress';
    ui.dialog.querySelector('h2').textContent = t(view === 'progress' && ['uninstall', 'remove-packages'].includes(snapshot?.operation) ? 'TeX を管理' : 'TeX をセットアップ');
    review.hidden = view !== 'review'; progressPanel.hidden = view !== 'progress';
    environmentStatus.textContent = selectedEnvironment.bin || meta.latexmk ? t('利用中: {path}', { path: selectedEnvironment.bin || meta.texBin || meta.latexmk }) : t('TeX をコンパイルするための環境が見つかりません．');
    const list = meta.texPackages?.programs || [];
    const signature = JSON.stringify([document.documentElement.lang, list]);
    if (signature !== programSignature) {
      programSignature = signature;
      programs.replaceChildren(...list.map(program => {
        const item = element('li', { 'data-available': String(!!program.available), ...(program.path ? { title: program.path } : {}) });
        item.append(element('code', {}, program.name), element('span', {}, t(program.available ? '利用可能' : '見つかりません')));
        return item;
      }));
    }
    contentsTitle.textContent = t(packagesMode ? '追加するパッケージ' : 'インストールするもの');
    contents.textContent = packagesMode
      ? t('選んだパッケージと，それらが必要とするパッケージを，選択中の TeX の環境へ追加します．')
      : t('TinyTeX と基本ツールに，日本語の組版，数式，定理，相互参照，TikZ，tcolorbox，アルゴリズム，文献処理など，研究用の原稿で使うパッケージを追加します．');
    release.hidden = packagesMode || !installation?.release;
    release.textContent = installation?.release ? `TinyTeX ${installation.release}` : '';
    const names = packagesMode ? context.packages : snapshot?.install?.packages || (!snapshot?.operation || snapshot.operation === 'install' ? snapshot?.packages || [] : []);
    const namesSignature = JSON.stringify(names);
    if (namesSignature !== packageSignature) { packageSignature = namesSignature; packageList.replaceChildren(...names.map(name => element('li', {}, name))); }
    packageList.hidden = !names.length;
    reinstallNote.hidden = !packagesMode || !context.reinstall;
    externalNote.hidden = packagesMode || !meta.latexmk;
    sharedNote.hidden = !packagesMode || selectedEnvironment.managed;
    elevationNote.hidden = !packagesMode || !selectedEnvironment.requiresElevation;
    setLink(archiveLink, !packagesMode ? snapshot?.install?.source || (!snapshot?.operation || snapshot.operation === 'install' ? snapshot?.source : '') : '', 'TinyTeX');
    setLink(repositoryLink, packagesMode ? meta.texPackages?.repository || (snapshot?.operation === 'packages' ? snapshot.source : '') : 'https://mirror.ctan.org/systems/texlive/tlnet/', 'TeX Live');
    repositoryNote.hidden = !packagesMode || !repositoryLink.hidden;
    archiveRow.hidden = packagesMode;
    archiveSize.textContent = installation?.archiveBytes > 0 ? formatTeXSetupBytes(installation.archiveBytes) : t('取得時に確認します');
    estimate.hidden = packagesMode;
    estimate.textContent = t('標準構成の目安: ダウンロード約 {download} MB，インストール先約 1 GB．作業中は 2 GB 程度の空き容量を用意してください．取得する版や追加パッケージによって増減します．', { download: meta.platform === 'darwin' ? 300 : 250 });
    parent.group.hidden = packagesMode;
    if (!parentEdited && installation?.parent) parent.input.value = installation.parent;
    parent.input.placeholder = installation?.parent || '';
    parent.input.disabled = working || !!picker || locked;
    browse.disabled = working || !!picker || locked || !snapshot?.supported;
    pickerStatus.hidden = !picker;
    destination.hidden = !packagesMode;
    destination.textContent = t('追加先: {path}', { path: selectedEnvironment.directory || selectedEnvironment.bin || meta.texBin || '' });
    reviewStatus.hidden = !packageReviewLoading;
    unsupported.hidden = !snapshot || (packagesMode ? selectedEnvironment.canInstallPackages : snapshot.supported);
    const progressValue = texSetupProgress(snapshot);
    status.textContent = describeStatus();
    progress.hidden = !working;
    if (snapshot?.stage === 'downloading' && progressValue.fraction != null) progress.value = progressValue.fraction;
    else progress.removeAttribute('value');
    downloaded.hidden = snapshot?.stage !== 'downloading';
    downloaded.textContent = progressValue.total > 0
      ? `${formatTeXSetupBytes(progressValue.downloaded)} / ${formatTeXSetupBytes(progressValue.total)}`
      : progressValue.downloaded > 0 ? formatTeXSetupBytes(progressValue.downloaded) : t('ダウンロードを開始します…');
    location.hidden = !snapshot?.directory;
    location.textContent = snapshot?.directory ? t(snapshot.operation === 'uninstall' ? '対象のフォルダー: {path}' : '保存先: {path}', { path: snapshot.directory }) : '';
    continueNote.hidden = !working;
    cannotStop.hidden = !isTeXSetupRunning(snapshot) || snapshot?.operation !== 'uninstall' || snapshot.cancelable !== false;
    const currentTarget = getCompileTarget();
    const sameTarget = !!context.target && currentTarget?.root === context.target.root && currentTarget?.main === context.target.main;
    const done = snapshot?.status === 'succeeded' && !working && !session.checking;
    const actionContext = context.reason !== 'settings' && context.reason !== 'packages' && !['uninstall', 'remove-packages'].includes(snapshot?.operation);
    compile.hidden = !done || !actionContext || !context.target;
    compile.disabled = locked || !sameTarget || !!session.error;
    sample.hidden = !done || !actionContext || !!meta.project;
    sample.disabled = locked || !!session.error;
    targetNote.textContent = done && snapshot?.operation === 'uninstall'
      ? t('保存先に残った項目がある場合は，ログで確認できます．')
      : done && context.target && !sameTarget
        ? t('原稿を切り替えました．編集画面でコンパイルしてください．')
        : done && !['uninstall', 'remove-packages'].includes(snapshot?.operation) ? t('この TeX の環境を設定しました．アプリを再起動せずにコンパイルできます．') : '';
    targetNote.hidden = !targetNote.textContent;
    const nextLog = String(snapshot?.log || '');
    if (log.textContent !== nextLog) {
      const atBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 45;
      log.textContent = nextLog;
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    logDetails.hidden = !nextLog; copyLog.disabled = !nextLog;
    start.hidden = view !== 'review';
    start.textContent = t(packagesMode ? '確認したパッケージを追加' : 'ダウンロードしてインストール');
    start.disabled = locked || working || !!picker || session.loading || session.checking || packageReviewLoading || !!localError || !!session.error || !snapshot
      || (packagesMode ? !selectedEnvironment.canInstallPackages || !parseTeXPackageNames(context.packages.join(' ')) : !snapshot.supported);
    stop.hidden = !working || snapshot?.cancelable === false;
    stop.disabled = !!session.pending || snapshot?.status !== 'running';
    stop.textContent = t(snapshot?.status === 'cancelling' || session.pending === 'stop' ? '停止を待っています…' : 'セットアップを停止');
    retry.hidden = view !== 'progress' || !['failed', 'cancelled'].includes(snapshot?.status) || working;
    retry.disabled = locked || session.checking;
    close.textContent = t(working ? '閉じて編集を続ける' : view === 'review' ? 'キャンセル' : '閉じる');
    recheck.disabled = session.loading || session.checking || packageReviewLoading || !!session.pending || !!picker;
    const error = localError || session.error || (view === 'progress' ? snapshot?.error : '');
    if (error) ui.showError(error); else ui.clearError();
    if (home) {
      const missing = missingTeXPrograms(meta);
      home.hidden = !snapshot || (!working && !missing.length && !['failed', 'cancelled'].includes(snapshot.status));
      homeStatus.textContent = working || ['failed', 'cancelled'].includes(snapshot?.status) ? describeStatus()
        : t('必要なプログラムが見つかりません: {programs}', { programs: missing.join(', ') });
      homeOpen.textContent = t(working ? 'セットアップの進捗を見る' : 'TeX をセットアップ…');
      homeOpen.disabled = locked;
    }
    if (indicator) {
      indicator.hidden = !snapshot?.id || !snapshot || snapshot.status === 'idle';
      indicator.textContent = describeStatus();
      indicator.title = t('TeX のセットアップを開く');
      indicator.disabled = locked;
    }
  }

  session = new TeXSetupSession({ api,
    onState: () => { render(); onStateChange(session.snapshot, { busy: session.busy, checking: session.checking }); },
    onComplete: snapshot => onToolsChanged(snapshot),
  });

  async function loadPackageReview() {
    if (context.operation !== 'packages' || session.busy || !ui.dialog.open) return;
    const opened = generation;
    const controller = new AbortController();
    packageReader?.abort(); packageReader = controller; packageReviewLoading = true; localError = null; render();
    try {
      const inventory = await api('/api/tex/packages', { projectRoot: null, signal: controller.signal, timeout: 120000 });
      if (opened !== generation || controller.signal.aborted || !ui.dialog.open) return;
      context.directory = inventory.directory || inventory.environment?.directory || '';
      context.revision = inventory.revision || '';
      context.environment = inventory.environment || teXEnvironment(session.snapshot);
      if (!context.environment.managed && (!context.directory || !context.revision)) throw new Error(t('追加先の TeX を確認できませんでした．環境を再確認してください．'));
    } catch (error) { if (opened === generation && !controller.signal.aborted) localError = error; }
    finally { if (packageReader === controller) { packageReader = null; packageReviewLoading = false; render(); } }
  }

  async function open(options = {}) {
    if (destroyed || isBlocked()) return;
    returnFocus = document.activeElement;
    const opened = ++generation; localError = null; copyStatus.textContent = '';
    context = { reason: options.reason || 'settings', operation: options.operation || 'install',
      packages: parseTeXPackageNames(Array.isArray(options.packages) ? options.packages.join(' ') : options.packages) || [],
      reinstall: !!options.reinstall, target: options.target || getCompileTarget(), directory: '', revision: '', environment: null };
    parentEdited = false; parent.input.value = session.snapshot?.install?.parent || session.snapshot?.parent || '';
    view = options.progress || session.busy ? 'progress' : 'review';
    if (context.operation === 'packages' && !context.packages.length) localError = new Error(t('パッケージ名をスペースで区切って入力してください．例: latexmk synctex'));
    session.error = null;
    ui.open(); render(); close.focus();
    await session.refresh();
    if (opened === generation && ui.dialog.open && context.operation === 'packages' && view === 'review') await loadPackageReview();
  }

  parent.input.addEventListener('input', () => { parentEdited = true; localError = null; if (!session.toolsError) session.clearError(); });
  browse.addEventListener('click', async () => {
    if (picker || session.busy || isBlocked()) return;
    const controller = new AbortController(); const opened = generation;
    picker = controller; localError = null; render();
    try {
      const result = await api('/api/tex/setup/pick', { method: 'POST', body: {}, projectRoot: null, timeout: 0, signal: controller.signal });
      if (opened === generation && ui.dialog.open && !controller.signal.aborted && !result.cancelled && result.path) {
        parent.input.value = result.path; parentEdited = true;
      }
    } catch (error) { if (!controller.signal.aborted && opened === generation) localError = error; }
    finally { if (picker === controller) { picker = null; render(); if (ui.dialog.open) browse.focus(); } }
  });
  start.addEventListener('click', async () => {
    if (start.disabled) return;
    localError = null;
    const accepted = await session.start({ operation: context.operation, parent: parent.input.value, packages: context.packages,
      reinstall: context.reinstall, directory: context.directory, revision: context.revision });
    if (!accepted && !isTeXSetupRunning(session.snapshot)) view = 'review';
    render();
  });
  stop.addEventListener('click', () => { void session.stop(); });
  close.addEventListener('click', () => ui.close());
  retry.addEventListener('click', () => {
    if (['remove-packages', 'uninstall'].includes(session.snapshot?.operation)) { ui.close(); onManage(); return; }
    localError = null; session.clearError(); view = 'review'; render(); close.focus();
  });
  recheck.addEventListener('click', async () => {
    localError = null;
    const snapshot = await session.refresh();
    if (snapshot && !session.busy) await session.checkTools(snapshot);
    if (context.operation === 'packages' && view === 'review') await loadPackageReview();
    render();
  });
  copyLog.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(String(session.snapshot?.log || '')); copyStatus.textContent = t('コピーしました'); }
    catch { log.focus(); window.getSelection()?.selectAllChildren(log); copyStatus.textContent = t('ログを選択してコピーしてください．'); }
  });
  compile.addEventListener('click', async () => {
    if (compile.disabled) return;
    ui.close(); await onCompile(context.target);
  });
  sample.addEventListener('click', () => { if (!sample.disabled) { ui.close(); onCreateSample(); } });
  homeOpen.addEventListener('click', () => { void open({ reason: 'home', progress: session.busy }); });
  const openProgress = () => { void open({ reason: 'status', progress: true }); };
  indicator?.addEventListener('click', openProgress);
  ui.dialog.addEventListener('close', () => {
    ++generation; picker?.abort(); picker = null; packageReader?.abort(); packageReader = null; packageReviewLoading = false;
    if (returnFocus?.isConnected && !returnFocus.disabled && returnFocus.getClientRects().length) returnFocus.focus();
    else {
      const fallback = getFallbackFocus() || indicator;
      if (fallback?.isConnected && !fallback.disabled && fallback.getClientRects().length) fallback.focus();
    }
    onClose(); render();
  });
  const unsubscribe = onLanguageChange(() => { translateElements(ui.dialog); if (home) translateElements(home); render(); });
  render();
  return {
    open, refresh: () => session.refresh(),
    sync(snapshot) { session.sync(snapshot); render(); },
    update: render,
    get busy() { return session.busy; },
    get snapshot() { return session.snapshot; },
    setEnvironment(environment) {
      if (!environment || session.busy || JSON.stringify(environment) === JSON.stringify(session.snapshot?.environment)) return;
      session.accept({ ...(session.snapshot || { status: 'idle' }), environment });
    },
    async removePackages(plan) {
      const accepted = await session.start({ operation: 'remove-packages', packages: plan.packages, directory: plan.directory, revision: plan.revision });
      return { started: accepted || (!session.error && isTeXSetupRunning(session.snapshot)), error: session.error, operation: 'remove-packages' };
    },
    async uninstall(inspection, confirmation) {
      const accepted = await session.uninstall({ directory: inspection.directory, revision: inspection.revision, confirmation, expectedConfirmation: inspection.confirmation || 'TinyTeX' });
      return { started: accepted || (!session.error && isTeXSetupRunning(session.snapshot)), error: session.error, operation: 'uninstall' };
    },
    destroy() {
      destroyed = true; ++generation; picker?.abort(); packageReader?.abort(); session.destroy(); unsubscribe();
      indicator?.removeEventListener('click', openProgress); ui.destroy();
    },
  };
}
