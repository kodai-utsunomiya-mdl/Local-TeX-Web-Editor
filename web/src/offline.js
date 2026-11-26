const text = {
  en: {
    title: 'Waiting for the application',
    description: 'This tab will reopen your editor when Local TeX Web Editor starts on this computer.',
    help: 'Open the application from its icon. You can also enable automatic startup in Settings to reconnect after signing in to your computer.',
    checking: 'Checking the connection…', waiting: 'Waiting for Local TeX Web Editor to start…',
    key: 'Open Local TeX Web Editor from its icon to reconnect this browser.', retry: 'Check again',
  },
  ja: {
    title: 'アプリへの接続を待っています',
    description: 'この PC で Local TeX Web Editor が起動すると，このタブに編集画面が戻ります．',
    help: 'アプリのアイコンから起動してください．設定で自動起動を有効にすると，PC へのログイン後に接続できます．',
    checking: '接続を確認しています…', waiting: 'Local TeX Web Editor の起動を待っています…',
    key: 'アプリのアイコンから Local TeX Web Editor を開き，ブラウザを再接続してください．', retry: '接続を確認',
  },
};
let language = navigator.language?.startsWith('ja') ? 'ja' : 'en';
try { const saved = localStorage.getItem('local-tex-editor-language'); if (text[saved]) language = saved; } catch { /* Use the browser language. */ }
const labels = text[language];
document.documentElement.lang = language;
for (const [id, key] of [['title', 'title'], ['description', 'description'], ['help', 'help'], ['retry', 'retry']]) document.getElementById(`connection-${id}`).textContent = labels[key];
const status = document.getElementById('connection-state');
let pending = false, timer;

async function reconnect() {
  if (pending) return;
  clearTimeout(timer);
  pending = true;
  let token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  if (!token) try { token = localStorage.getItem('local-tex-editor-token') || sessionStorage.getItem('local-tex-editor-token') || ''; } catch { /* A normal launch supplies a fresh connection. */ }
  status.textContent = labels.checking;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    if (!token) { status.textContent = labels.key; return; }
    const response = await fetch('/api/session', { headers: { 'X-Local-Token': token, 'Accept-Language': language, Accept: 'text/event-stream' }, cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (response.ok && response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
      controller.abort();
      location.reload();
      return;
    }
    status.textContent = response.status === 401 ? labels.key : labels.waiting;
  } catch { status.textContent = labels.waiting; }
  finally {
    controller.abort(); clearTimeout(timeout); pending = false;
    timer = setTimeout(reconnect, 1500);
  }
}

document.getElementById('connection-retry').addEventListener('click', reconnect);
window.addEventListener('online', reconnect);
window.addEventListener('storage', reconnect);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconnect(); });
reconnect();
