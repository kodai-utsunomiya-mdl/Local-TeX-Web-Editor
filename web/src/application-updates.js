import { getLanguage, onLanguageChange, t } from './i18n.js';

const releases = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases';
const storeListing = 'https://apps.microsoft.com/detail/9P6QF32N19HG';

export function updateReleaseNotesURL(value) {
  try {
    const url = new URL(value);
    if (url.href === storeListing) return url.href;
    if (url.origin === 'https://github.com' && (url.pathname === releases.slice(url.origin.length) || url.pathname.startsWith(`${releases.slice(url.origin.length)}/`))) return url.href;
  } catch { /* Use the published release list until a specific release is available. */ }
  return `${releases}/latest`;
}

export function applicationUpdateMessage(state) {
  if (!state) return t('アプリの更新を確認中…');
  if (state.message) return state.message;
  if (!state.supported) return t('この起動方法では自動更新を利用できません．配布ページから新しい版を入手できます．');
  const version = state.latestVersion ? `v${state.latestVersion}` : '';
  switch (state.phase) {
    case 'checking': return t('新しいバージョンを確認しています…');
    case 'downloading': return t('アプリの更新をダウンロードしています…');
    case 'ready': return state.automatic
      ? version ? t('{version} への更新を準備しました．作業が落ち着くと自動で更新します．', { version })
        : t('アプリの更新を準備しました．作業が落ち着くと自動で更新します．')
      : version ? t('{version} への更新を準備しました．', { version }) : t('アプリの更新を準備しました．');
    case 'preparing': return t('開いている編集画面を確認し，更新の準備をしています…');
    case 'applying': return t('アプリを更新しています．再起動後に編集画面へ戻ります．');
    case 'waiting': return t('アプリの更新を待っています．保存や実行中の処理が済むと更新できます．');
    case 'up-to-date': return t('最新のバージョンを使用しています．');
    case 'error': return t('更新を完了できませんでした．編集を続けながら，後で再試行できます．');
    default: return state.automatic ? t('自動更新は有効です．起動後に新しいバージョンを確認します．') : t('自動更新は無効です．「今すぐ確認」から更新できます．');
  }
}

// A preparation belongs to one server attempt. Every participating editor
// acknowledges its completed writes before the server starts the replacement.
export class UpdatePreparation {
  constructor({ clientId, api, prepare, release, onApplying, onError, timeout = 45000, restartTimeout = 180000 }) {
    Object.assign(this, { clientId, api, prepare, release, onApplying, onError, timeout, restartTimeout });
    this.attempt = null;
    this.timer = null;
  }

  get prepared() { return this.attempt?.ready === true; }

  async handle(message) {
    if (!message) return;
    if (message.type === 'update-cancelled') {
      if (typeof message.attemptId === 'string' && message.attemptId) this.cancel(message.attemptId);
      else if (message.attemptId == null || message.attemptId === '') this.cancel();
      return;
    }
    if (typeof message.attemptId !== 'string' || !message.attemptId) return;
    if (message.type === 'applying-update') {
      if (this.attempt?.id !== message.attemptId || !this.attempt.ready) return;
      this.attempt.applying = true;
      this.armTimeout(this.attempt, this.restartTimeout);
      this.onApplying?.();
      return;
    }
    if (message.type !== 'prepare-update') return;
    if (this.attempt?.id === message.attemptId) return;
    if (this.attempt) this.cancel(this.attempt.id);
    const attempt = { id: message.attemptId, ready: false, applying: false };
    this.attempt = attempt;
    this.armTimeout(attempt, this.timeout);
    let result;
    try {
      result = await this.prepare({ automatic: message.automatic === true });
    } catch (error) {
      result = { ready: false, reason: error.message || String(error) };
    }
    if (this.attempt !== attempt) return;
    attempt.ready = result?.ready === true;
    try {
      await this.api('/api/updates/ready', { method: 'POST', projectRoot: null, body: {
        clientId: this.clientId, attemptId: attempt.id, ready: attempt.ready,
        reason: attempt.ready ? '' : result?.reason || t('編集画面の準備が整うまで，更新を待っています．'),
      } });
      if (!attempt.ready) this.cancel(attempt.id);
    } catch (error) {
      if (this.attempt !== attempt || attempt.applying) return;
      // The server can restart after accepting the acknowledgement but before
      // its response reaches this tab. Keep the completed editor writes ready
      // until reconnection or an explicit cancellation resolves that case.
      if (attempt.ready && !error.status) { this.onError?.(error); return; }
      this.cancel(attempt.id);
      this.onError?.(error);
    }
  }

  armTimeout(attempt, delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (this.attempt !== attempt) return;
      if (!attempt.applying) {
        try {
          await this.api('/api/updates/ready', { method: 'POST', projectRoot: null, body: {
            clientId: this.clientId, attemptId: attempt.id, ready: false,
            reason: t('更新の応答を待つ時間が長いため，編集を再開しました．'),
          } });
          if (this.attempt === attempt) this.cancel(attempt.id);
          return;
        } catch { /* A replacement may already be starting. Read its current state. */ }
      }
      try {
        const state = await this.api('/api/updates', { projectRoot: null });
        if (this.attempt !== attempt) return;
        if (!['preparing', 'applying'].includes(state?.phase)) this.cancel(attempt.id);
        else this.armTimeout(attempt, this.restartTimeout);
      } catch {
        if (this.attempt === attempt) this.armTimeout(attempt, 10000);
      }
    }, delay);
  }

  cancel(attemptId = this.attempt?.id) {
    if (!this.attempt || this.attempt.id !== attemptId) return;
    clearTimeout(this.timer); this.timer = null;
    this.attempt = null;
    this.release?.();
  }
}

export function createApplicationUpdates({ api, onInstall, onOpenSettings, onState, document = globalThis.document }) {
  const byId = id => document.getElementById(id);
  const section = byId('application-updates');
  const checkbox = byId('application-updates-automatic');
  const status = byId('application-updates-status');
  const checked = byId('application-updates-checked');
  const progress = byId('application-updates-progress');
  const error = byId('application-updates-error');
  const check = byId('application-updates-check');
  const install = byId('application-updates-install');
  const banner = byId('application-update-banner');
  const bannerText = byId('application-update-message');
  const bannerInstall = byId('application-update-install');
  const postpone = byId('application-update-defer');
  const indicator = byId('application-update-open');
  let state = null, busy = false, reading = false, started = false, timer = null, localError = '', pendingAutomatic = null, revision = 0;

  function render() {
    const supported = state?.supported === true;
    const changing = ['checking', 'downloading', 'preparing', 'applying'].includes(state?.phase);
    const preparing = ['preparing', 'applying'].includes(state?.phase);
    const available = supported && ['ready', 'waiting', 'preparing', 'applying', 'downloading'].includes(state?.phase);
    const deferred = Date.parse(state?.deferredUntil || '') > Date.now();
    section.setAttribute('aria-busy', String(busy));
    checkbox.checked = pendingAutomatic === null ? state?.automatic !== false : pendingAutomatic;
    checkbox.disabled = busy || !supported || preparing;
    status.textContent = applicationUpdateMessage(state);
    status.dataset.phase = state?.phase || 'loading';
    check.disabled = busy || !supported || changing;
    install.hidden = !state?.canInstall;
    install.disabled = busy || preparing;
    checked.hidden = !state?.lastCheckedAt;
    const date = new Date(state?.lastCheckedAt || '');
    checked.textContent = Number.isNaN(date.valueOf()) ? '' : t('最終確認: {time}', { time: date.toLocaleString(getLanguage() === 'ja' ? 'ja-JP' : 'en-US') });
    progress.hidden = state?.phase !== 'downloading';
    if (Number.isFinite(state?.progress) && state.progress > 0) progress.value = Math.max(0, Math.min(1, state.progress));
    else progress.removeAttribute('value');
    error.textContent = localError || state?.error || '';
    error.hidden = !error.textContent;
    for (const id of ['application-updates-notes', 'application-update-notes']) byId(id).href = updateReleaseNotesURL(state?.releaseNotesURL);
    byId('application-updates-store-note').hidden = state?.channel !== 'store';
    banner.hidden = !available || deferred;
    bannerText.textContent = applicationUpdateMessage(state);
    bannerInstall.hidden = !state?.canInstall;
    bannerInstall.disabled = busy || preparing;
    postpone.hidden = !available || !state?.automatic || preparing;
    postpone.disabled = busy;
    indicator.hidden = !available;
    indicator.disabled = preparing;
    onState?.(state);
  }

  function schedule() {
    clearTimeout(timer);
    if (!started) return;
    const delay = ['checking', 'downloading', 'preparing', 'applying'].includes(state?.phase) ? 3000
      : ['ready', 'waiting'].includes(state?.phase) ? 10000 : 60000;
    timer = setTimeout(() => { void refresh(); }, delay);
  }

  async function refresh({ reportError = false } = {}) {
    if (reading || busy) { schedule(); return; }
    reading = true;
    const requestedRevision = revision;
    try {
      const result = await api('/api/updates', { projectRoot: null });
      if (requestedRevision === revision && result && typeof result === 'object') state = result;
      if (reportError && requestedRevision === revision) localError = '';
    } catch (cause) {
      if (reportError && requestedRevision === revision) localError = cause.message || String(cause);
    } finally { reading = false; render(); schedule(); }
  }

  async function perform(action) {
    if (busy) return;
    busy = true; ++revision; localError = ''; render();
    try {
      const result = await action();
      if (result && typeof result === 'object' && typeof result.phase === 'string') state = result;
    } catch (cause) { localError = cause.message || String(cause); }
    finally { busy = false; render(); void refresh(); }
  }

  check.addEventListener('click', () => perform(() => api('/api/updates/check', { method: 'POST', projectRoot: null, body: {} })));
  checkbox.addEventListener('change', () => {
    if (busy) { render(); return; }
    const automatic = checkbox.checked;
    pendingAutomatic = automatic;
    void perform(async () => {
      try { return await api('/api/updates/settings', { method: 'POST', projectRoot: null, body: { automatic } }); }
      finally { pendingAutomatic = null; }
    });
  });
  for (const button of [install, bannerInstall]) button.addEventListener('click', () => perform(onInstall));
  postpone.addEventListener('click', () => perform(() => api('/api/updates/defer', { method: 'POST', projectRoot: null, body: { minutes: 60 } })));
  indicator.addEventListener('click', onOpenSettings);
  const removeLanguage = onLanguageChange(() => { render(); if (started) void refresh(); });
  render();
  return {
    refresh,
    start() { if (started) return; started = true; void refresh(); },
    stop() { started = false; clearTimeout(timer); },
    destroy() { started = false; clearTimeout(timer); removeLanguage(); },
    get snapshot() { return state; },
  };
}
