const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const byID = id => document.getElementById(id);
const translations = {
  en: {
    title: 'Update Local TeX Editor', language: 'Language',
    currentVersion: 'Running version', requestedVersion: 'Version being opened',
    checking: 'Checking…', checkingApp: 'Checking the running app.',
    instructions: 'Save your documents in the running editor, then use its Exit button in the upper right to open this version.',
    openCurrent: 'Open the running editor',
    closedTab: 'If you already closed the old tab, confirm below that your work is saved. Any running compile will stop.',
    saved: 'I have saved all open documents.',
    switchVersion: 'Close the old version and open the new one', cancel: 'Cancel',
    executable: 'Executable being opened',
    shortcuts: 'If you created shortcuts, the installed app and its existing shortcuts will also be updated.',
    ready: 'Opening the updated editor…', starting: 'Starting the updated app…',
    cancelled: 'Update cancelled. You can close this tab.',
    stopping: 'Waiting for the running app to close…', waiting: 'Waiting for v{version} to close.',
    nextUnavailable: 'Could not connect to the updated app. Open its executable again.',
    appUnavailable: 'Could not connect to the app. Open its executable again.',
    updateUnavailable: 'Could not connect to the update page. Open the executable again.',
    missingToken: 'Use the URL opened when the app started.',
  },
  ja: {
    title: 'Local TeX Editor を更新', language: '表示言語',
    currentVersion: '起動中のバージョン', requestedVersion: '開こうとしているバージョン',
    checking: '確認中…', checkingApp: '起動中のアプリを確認しています．',
    instructions: '起動中の編集画面で原稿を保存し，右上の「終了」を押すと，今回のバージョンが開きます．',
    openCurrent: '起動中の編集画面を開く',
    closedTab: '旧版のタブをすでに閉じた場合は，下で保存を確認してから切り替えられます．実行中のコンパイルは停止します．',
    saved: '開いている原稿をすべて保存しました．',
    switchVersion: '旧版を終了して今回のバージョンを開く', cancel: '取り消す',
    executable: '今回開こうとしている実行ファイル',
    shortcuts: 'ショートカットを作成済みの場合は，配置済みのアプリと既存のショートカットも更新されます．',
    ready: '更新後の編集画面を開いています…', starting: '更新後のアプリを起動しています…',
    cancelled: '更新を取り消しました．このタブを閉じてください．',
    stopping: '起動中のアプリの終了を待っています…', waiting: 'v{version} の終了を待っています．',
    nextUnavailable: '更新後のアプリへ接続できません．実行ファイルを開き直してください．',
    appUnavailable: 'アプリに接続できません．実行ファイルを開き直してください．',
    updateUnavailable: '更新画面に接続できません．実行ファイルを開き直してください．',
    missingToken: '起動時に開いた URL を使用してください．',
  },
};
let language = document.documentElement.lang === 'ja' ? 'ja' : 'en';
let state = null;
let working = false;
let closed = false;
let hidden = false;
let navigating = false;
let stream = null;
let retry = null;

function t(key, values = {}) {
  return translations[language][key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('title');
  byID('update-language').value = language;
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  if (state) render(state);
  else {
    byID('update-current-version').textContent = t('checking');
    byID('update-requested-version').textContent = t('checking');
    byID('update-status').textContent = t('checkingApp');
  }
}

function showError(message) {
  byID('update-error').textContent = message;
  byID('update-error').hidden = !message;
}

function render(value) {
  state = value;
  byID('update-current-version').textContent = `v${value.currentVersion}`;
  byID('update-requested-version').textContent = `v${value.requestedVersion}`;
  byID('update-executable').textContent = value.executable;
  byID('update-open-current').href = value.currentURL;
  const phase = value.phase;
  byID('update-status').textContent = phase === 'ready' ? t('ready')
    : phase === 'starting' ? t('starting')
      : phase === 'cancelled' ? t('cancelled')
        : value.stopping ? t('stopping')
          : t('waiting', { version: value.currentVersion });
  byID('update-options').hidden = phase === 'ready' || phase === 'starting' || phase === 'cancelled';
  byID('update-stop-current').disabled = working || value.stopping || phase !== 'waiting' || !byID('update-saved').checked;
  byID('update-saved').disabled = working || value.stopping || phase !== 'waiting';
  showError(value.error || '');
  if (phase === 'cancelled') { closed = true; stream?.abort(); }
  if (phase === 'ready' && value.readyURL && !navigating) {
    const next = new URL(value.readyURL);
    if (next.protocol !== 'http:' || !(next.hostname.startsWith('127.') || next.hostname === '[::1]')) {
      showError(t('nextUnavailable'));
      return;
    }
    navigating = true;
    location.replace(value.readyURL);
  }
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'X-Local-Token': token, 'Accept-Language': language, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || t('appUnavailable'));
  return data;
}

async function connect() {
  if (closed || hidden || navigating || stream) return;
  const controller = new AbortController();
  const streamLanguage = language;
  stream = controller;
  try {
    const response = await fetch('/api/update/events', {
      headers: { 'X-Local-Token': token, 'Accept-Language': streamLanguage }, cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(t('updateUnavailable'));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (!closed && !hidden && !navigating && streamLanguage === language) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const message = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = message.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (data && streamLanguage === language) render(JSON.parse(data));
      }
    }
    await reader.cancel().catch(() => {});
  } catch (error) {
    if (!closed && !hidden && !navigating && streamLanguage === language && error.name !== 'AbortError') showError(error.message);
  } finally {
    if (stream === controller) stream = null;
    if (!closed && !hidden && !navigating) retry = setTimeout(connect, streamLanguage === language ? 700 : 0);
  }
}

byID('update-language').addEventListener('change', () => {
  language = byID('update-language').value === 'ja' ? 'ja' : 'en';
  // The next event stream supplies any server explanation in this language.
  if (state) state = { ...state, error: '' };
  showError('');
  applyLanguage();
  clearTimeout(retry);
  if (stream) stream.abort();
  else if (token) connect();
  if (!token) showError(t('missingToken'));
});

byID('update-saved').addEventListener('change', () => { if (state) render(state); });
byID('update-stop-current').addEventListener('click', async () => {
  if (working || !byID('update-saved').checked) return;
  working = true; if (state) render(state);
  let failure = '';
  try { await request('/api/update/stop', { saved: true }); }
  catch (error) { failure = error.message; }
  finally {
    working = false;
    if (state && !closed && !navigating) {
      render(state);
      if (failure) showError(failure);
    }
  }
});
byID('update-cancel').addEventListener('click', async () => {
  if (closed || navigating) return;
  try {
    await request('/api/update/cancel', {});
    closed = true; stream?.abort(); clearTimeout(retry);
    byID('update-options').hidden = true;
    if (state) state = { ...state, phase: 'cancelled', error: '' };
    byID('update-status').textContent = t('cancelled');
    showError('');
    try { window.close(); } catch { /* The message remains available in tabs the browser keeps open. */ }
  } catch (error) { showError(error.message); }
});
window.addEventListener('pagehide', () => { hidden = true; clearTimeout(retry); stream?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) { hidden = false; connect(); } });

applyLanguage();
if (!token) showError(t('missingToken'));
else connect();
