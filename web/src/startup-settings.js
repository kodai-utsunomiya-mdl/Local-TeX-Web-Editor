import { onLanguageChange, t } from './i18n.js';

export function createStartupSettings({ api }) {
  const section = document.getElementById('startup-settings');
  const status = document.getElementById('startup-status');
  const enable = document.getElementById('startup-enable');
  const disable = document.getElementById('startup-disable');
  const system = document.getElementById('startup-system-settings');
  const error = document.getElementById('startup-error');
  let state = null, busy = false, sequence = 0, refreshQueued = false;

  function render() {
    section.setAttribute('aria-busy', String(busy));
    enable.disabled = busy || !state?.canEnable;
    disable.disabled = busy || !state?.canDisable;
    system.hidden = !state?.canOpenSettings;
    system.disabled = busy;
    status.textContent = busy ? t('ログイン時の起動設定を確認中…') : state?.message || '';
    status.dataset.status = state?.status || 'loading';
  }

  async function perform(action) {
    if (busy) return;
    const request = ++sequence;
    busy = true; error.hidden = true; render();
    try {
      const result = await action();
      if (request === sequence && result?.status) state = result;
    } catch (cause) {
      if (request === sequence) {
        error.textContent = cause.message || String(cause);
        error.hidden = false;
      }
    } finally {
      if (request === sequence) {
        busy = false; render();
        if (refreshQueued) {
          refreshQueued = false;
          if (document.getElementById('settings-dialog').open) void refresh();
        }
      }
    }
  }

  function refresh() {
    if (busy) { refreshQueued = true; return; }
    return perform(() => api('/api/startup'));
  }
  enable.addEventListener('click', () => perform(() => api('/api/startup', { method: 'POST', body: { enabled: true }, timeout: 20000 })));
  disable.addEventListener('click', () => perform(() => api('/api/startup', { method: 'POST', body: { enabled: false }, timeout: 20000 })));
  system.addEventListener('click', () => perform(() => api('/api/startup/settings', { method: 'POST', body: {} })));
  window.addEventListener('focus', () => { if (document.getElementById('settings-dialog').open) void refresh(); });
  onLanguageChange(() => { if (document.getElementById('settings-dialog').open) void refresh(); });
  render();
  return { refresh };
}
