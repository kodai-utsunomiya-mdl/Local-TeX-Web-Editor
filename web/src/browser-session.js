import { getLanguage } from './i18n.js';

// Observe the local application's availability while the editor is open.
// Freezing, discarding or closing a tab does not end the local application.
export class BrowserSession {
  constructor({ token, clientId = '', fetch: request = globalThis.fetch.bind(globalThis), onConnectionChange, onMessage, retryDelays = [250, 500, 1000] }) {
    this.token = token;
    this.clientId = clientId;
    this.request = request;
    this.onConnectionChange = onConnectionChange;
    this.onMessage = onMessage;
    this.retryDelays = retryDelays;
    this.retry = 0;
    this.controller = null;
    this.timer = null;
    this.active = false;
  }

  start() {
    if (!this.token) return;
    this.active = true;
    if (!this.controller && !this.timer) this.connect();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer); this.timer = null;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    this.retry = 0;
  }

  resume() {
    // A sleeping page can return with a stream whose close callback has not
    // run yet. Replacing it also skips any retry left waiting by that page.
    this.stop();
    this.start();
  }

  async connect() {
    if (!this.active || this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    let reader;
    try {
      const response = await this.request(`/api/session${this.clientId ? `?clientId=${encodeURIComponent(this.clientId)}` : ''}`, {
        headers: { 'X-Local-Token': this.token, Accept: 'text/event-stream', 'Accept-Language': getLanguage() },
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('The browser session could not connect.');
      if (this.controller !== controller || !this.active) { await response.body.cancel(); return; }
      this.retry = 0;
      this.onConnectionChange?.(true);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (this.controller === controller && this.active) {
        const { value, done } = await reader.read();
        if (done || this.controller !== controller || !this.active) break;
        pending = (pending + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { Promise.resolve(this.onMessage?.(JSON.parse(data))).catch(() => {}); }
          catch { /* A malformed event does not interrupt the connection. */ }
        }
        if (pending.length > 65536) throw new Error('The browser session event is too large.');
      }
    } catch { /* A short retry covers a temporary interruption on the loopback connection. */ }
    finally {
      reader?.releaseLock();
      if (this.controller !== controller) return;
      this.controller = null;
      if (!this.active || controller.signal.aborted) return;
      this.onConnectionChange?.(false);
      const delay = this.retryDelays[Math.min(this.retry++, this.retryDelays.length - 1)] ?? 1000;
      this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    }
  }
}
