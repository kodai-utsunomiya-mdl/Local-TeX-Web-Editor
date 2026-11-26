export const browserTokenKey = 'local-tex-editor-token';
export const browserLanguageKey = 'local-tex-editor-language';

export function restoreBrowserToken(fragmentToken, storage = globalThis) {
  let token = fragmentToken || '';
  if (!token) {
    try { token = storage.localStorage.getItem(browserTokenKey) || ''; } catch { /* Browser storage is optional. */ }
    if (!token) {
      try { token = storage.sessionStorage.getItem(browserTokenKey) || ''; } catch { /* The launch URL can still provide the key. */ }
    }
  }
  if (token) {
    try { storage.sessionStorage.setItem(browserTokenKey, token); } catch { /* Continue with the launch key. */ }
    try { storage.localStorage.setItem(browserTokenKey, token); } catch { /* The current browser session can still reconnect. */ }
  }
  return token;
}

export function rememberBrowserLanguage(language) {
  try { localStorage.setItem(browserLanguageKey, language); } catch { /* The waiting page can use the browser language. */ }
}

export async function registerConnectionPage() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }); }
  catch { /* Editing remains available when this browser does not allow offline pages. */ }
}
