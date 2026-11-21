import { t } from './i18n.js';
const encoder = new TextEncoder();
const keepaliveLimit = 60 * 1024;

async function revisionOf(serialized) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(serialized));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Offsets use UTF-8 bytes. Move a boundary out of a surrogate pair before
// measuring it so both Go and the browser refer to the same text.
function changedRange(previous, next) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) ++prefix;
  const lowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;
  if (prefix > 0 && lowSurrogate(previous.charCodeAt(prefix))) --prefix;
  let oldEnd = previous.length, newEnd = next.length;
  while (oldEnd > prefix && newEnd > prefix && previous[oldEnd - 1] === next[newEnd - 1]) { --oldEnd; --newEnd; }
  if (lowSurrogate(previous.charCodeAt(oldEnd))) { ++oldEnd; ++newEnd; }
  return { from: prefix, to: oldEnd, insert: next.slice(prefix, newEnd) };
}

function jsonTokens(serialized) {
  return [...serialized.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)];
}

export function createStoragePatch(base, serialized) {
  const previous = jsonTokens(base.serialized), next = jsonTokens(serialized);
  let ranges = [];
  // A draft changes its text, timestamp and caret position together. Comparing
  // each JSON token lets all of those edits travel without resending the text
  // between them. A change to the JSON shape uses a single range instead.
  if (previous.length === next.length && previous.length) {
    for (let index = 0; index < previous.length; ++index) {
      if (previous[index][0] === next[index][0]) continue;
      const range = changedRange(previous[index][0], next[index][0]);
      ranges.push({ from: previous[index].index + range.from, to: previous[index].index + range.to, insert: range.insert });
      if (ranges.length > 256) break;
    }
  } else ranges = [changedRange(base.serialized, serialized)];
  if (!ranges.length || ranges.length > 256) ranges = [changedRange(base.serialized, serialized)];
  const totalBytes = encoder.encode(base.serialized).byteLength;
  let position = 0, bytes = 0;
  const edits = ranges.map(range => {
    bytes += encoder.encode(base.serialized.slice(position, range.from)).byteLength;
    const prefixBytes = bytes;
    bytes += encoder.encode(base.serialized.slice(range.from, range.to)).byteLength;
    position = range.to;
    return { prefixBytes, suffixBytes: totalBytes - bytes, insert: range.insert };
  });
  return { baseRevision: base.revision, edits };
}

function storedValue(response) {
  if (typeof response?.serialized !== 'string' || typeof response?.revision !== 'string') return null;
  return { serialized: response.serialized, revision: response.revision };
}

// Coalesce frequent editor changes and write each key in order. A conditional
// patch at pagehide sends a last short edit even when the full draft is large.
export class SessionStore {
  constructor(api, onStatus, { getDraftsGeneration = () => '' } = {}) {
    this.api = api;
    this.onStatus = onStatus;
    this.getDraftsGeneration = getDraftsGeneration;
    this.records = new Map();
    this.pauses = new Set();
    this.controllers = new Set();
    this.stopped = false;
    this.unloading = false;
    this.keepaliveBytes = 0;
    this.keepaliveRequests = new Set();
  }

  async request(url, options) {
    const stopped = () => new DOMException('Settings storage has stopped.', 'AbortError');
    if (this.stopped) throw stopped();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.api(url, { ...options, signal: controller.signal });
      if (this.stopped) throw stopped();
      return response;
    } catch (error) {
      if (this.stopped) throw stopped();
      throw error;
    } finally { this.controllers.delete(controller); }
  }

  async read(key) {
    const response = await this.request(`/api/storage?key=${encodeURIComponent(key)}`, { projectRoot: null });
    if (this.stopped) throw new DOMException('Settings storage has stopped.', 'AbortError');
    const { value } = response;
    if (this.isPaused(key)) return value;
    const record = this.record(key);
    if (!record.running && record.saved === record.version) record.base = storedValue(response);
    let backup = null;
    try { backup = JSON.parse(localStorage.getItem(`local-tex-editor-backup:${key}`) || 'null'); } catch { /* The PC copy remains available when browser storage is disabled. */ }
    if (backup && (backup.draftsGeneration ?? '') !== this.getDraftsGeneration()) {
      try { localStorage.removeItem(`local-tex-editor-backup:${key}`); } catch { /* Browser storage is optional. */ }
      backup = null;
    }
    if (backup?.value && backup.updatedAt > (Number(value?.updatedAt) || 0)) {
      this.write(key, backup.value, 0);
      return backup.value;
    }
    return value;
  }

  record(key) {
    let record = this.records.get(key);
    if (!record) {
      record = { serialized: '', base: null, version: 0, saved: 0, timer: null, running: null, inFlight: null, closeWrites: new Map(), conflict: null };
      this.records.set(key, record);
    }
    return record;
  }

  isPaused(key) { return [...this.pauses].some(pause => pause.matches(key)); }

  // A reset can discard selected records without first resaving them. Requests
  // already sent still finish, and releasing the pause resumes queued changes.
  pauseKeys(predicate) {
    if (this.stopped) return () => {};
    const pause = { matches: predicate };
    this.pauses.add(pause);
    for (const [key, record] of this.records) {
      if (predicate(key)) { clearTimeout(record.timer); record.timer = null; }
    }
    return () => {
      if (!this.pauses.delete(pause) || this.stopped) return;
      for (const [key, record] of this.records) {
        if (!predicate(key) || this.isPaused(key)) continue;
        if (record.version && record.saved === record.version && record.base) {
          this.acknowledge(key, record, record.base, record.saved);
        } else if (!this.unloading) {
          clearTimeout(record.timer);
          record.timer = setTimeout(() => {
            record.timer = null;
            if (this.stopped || this.unloading || this.isPaused(key) || this.records.get(key) !== record) return;
            if (record.conflict) { this.onStatus?.('error', key, record.conflict); return; }
            this.flushKey(key).catch(() => {});
          }, 0);
        }
      }
    };
  }

  write(key, value, delay = 500) {
    if (this.stopped) return;
    const record = this.record(key);
    const serialized = JSON.stringify(value);
    if (record.version && serialized === record.serialized) return;
    record.serialized = serialized;
    ++record.version;
    clearTimeout(record.timer);
    if (key.startsWith('drafts:')) {
      try { localStorage.setItem(`local-tex-editor-backup:${key}`, JSON.stringify({ value, updatedAt: value.updatedAt || Date.now(), draftsGeneration: this.getDraftsGeneration() })); } catch { /* The server write below is independent of browser quota. */ }
    }
    this.onStatus?.('saving', key);
    if (!this.stopped && !this.unloading && !this.isPaused(key)) record.timer = setTimeout(() => this.flushKey(key).catch(() => {}), delay);
  }

  acknowledge(key, record, response, version) {
    if (this.stopped || this.records.get(key) !== record || version < record.saved) return;
    record.base = storedValue(response);
    record.conflict = null;
    record.saved = version;
    if (record.saved === record.version && !this.isPaused(key)) {
      try {
        const backupKey = `local-tex-editor-backup:${key}`;
        const backup = JSON.parse(localStorage.getItem(backupKey) || 'null');
        if (backup && JSON.stringify(backup.value) === record.serialized && (backup.draftsGeneration ?? '') === this.getDraftsGeneration()) localStorage.removeItem(backupKey);
      } catch { /* Optional cache. */ }
      this.onStatus?.('saved', key);
    }
  }

  async flushKey(key) {
    if (this.stopped) return;
    const record = this.records.get(key);
    if (!record) return;
    clearTimeout(record.timer); record.timer = null;
    if (record.running) {
      try { return await record.running; }
      catch (error) { if (!this.stopped && !this.isPaused(key)) throw error; return; }
    }
    if (this.isPaused(key)) return;
    if (record.saved === record.version || this.unloading) return;
    if (record.conflict) throw record.conflict;
    const work = (async () => {
      while (!this.stopped && !this.unloading && !this.isPaused(key) && this.records.get(key) === record && record.saved < record.version) {
        const isDraft = key.startsWith('drafts:');
        if (isDraft && !record.base) {
          const response = await this.request(`/api/storage?key=${encodeURIComponent(key)}`, { projectRoot: null });
          if (this.stopped || this.isPaused(key) || this.records.get(key) !== record) return;
          record.base = storedValue(response);
          if (!record.base) throw new Error(t("草稿の保存先から版の情報を取得できませんでした．"));
        }
        const version = record.version;
        const serialized = record.serialized;
        const baseRevision = record.base?.revision;
        const revision = isDraft ? await revisionOf(serialized) : '';
        if (this.stopped || this.unloading || this.isPaused(key) || this.records.get(key) !== record) return;
        if (record.saved >= version) continue;
        record.inFlight = { serialized, revision };
        try {
          const response = await this.request('/api/storage', { method: 'PUT', body: { key, value: JSON.parse(serialized), ...(isDraft ? { baseRevision } : {}) }, projectRoot: null, timeout: 20000 });
          this.acknowledge(key, record, response, version);
        } catch (error) {
          if (this.stopped || this.records.get(key) !== record) return;
          // The pagehide patch can finish before this earlier PUT returns.
          if (record.saved >= version) continue;
          const current = isDraft && error.status === 409 && storedValue(error.data);
          if (current) {
            const ownVersion = current.serialized === record.serialized ? record.version :
              [...record.closeWrites].find(([, text]) => text === current.serialized)?.[0];
            if (ownVersion !== undefined) { this.acknowledge(key, record, error.data, ownVersion); continue; }
            record.conflict = error;
          }
          throw error;
        } finally {
          record.inFlight = null;
        }
      }
    })();
    record.running = work;
    try { await work; }
    catch (error) { if (this.stopped || this.isPaused(key)) return; if (!this.unloading) this.onStatus?.('error', key, error); throw error; }
    finally { record.running = null; }
  }

  async flush({ retryConflicts = false } = {}) {
    if (this.stopped) return;
    if (retryConflicts) {
      for (const [key, record] of this.records) {
        if (!record.conflict || this.isPaused(key)) continue;
        record.base = storedValue(record.conflict.data);
        record.conflict = null;
      }
    }
    const keys = [...this.records.keys()];
    const failures = await Promise.allSettled(keys.map(key => this.flushKey(key)));
    if (this.stopped) return;
    const error = failures.find((result, index) => result.status === 'rejected' && !this.isPaused(keys[index]));
    if (error) throw error.reason;
  }

  async settle() {
    if (this.stopped) return;
    await this.flush();
    if (this.stopped) return;
    await Promise.allSettled([...this.keepaliveRequests]);
    await this.flush();
  }

  forget(key) {
    if (this.stopped) return;
    const record = this.records.get(key);
    if (record) { clearTimeout(record.timer); record.saved = record.version; this.records.delete(key); }
    try { localStorage.removeItem(`local-tex-editor-backup:${key}`); } catch { /* Browser storage is optional. */ }
  }

  flushOnHide() {
    if (this.stopped || this.unloading) return;
    this.unloading = true;
    let available = keepaliveLimit - this.keepaliveBytes;
    const records = [...this.records].sort(([a], [b]) => Number(b.startsWith('drafts:')) - Number(a.startsWith('drafts:')));
    for (const [key, record] of records) {
      if (this.stopped) return;
      clearTimeout(record.timer); record.timer = null;
      if (this.isPaused(key)) continue;
      const isDraft = key.startsWith('drafts:');
      if (record.saved === record.version || (isDraft && (!record.base || record.conflict))) continue;
      const bases = isDraft ? [record.base, record.inFlight].filter((base, index, all) => base && all.findIndex(item => item?.revision === base.revision) === index) : [];
      const body = isDraft ? { key, patches: bases.map(base => createStoragePatch(base, record.serialized)) } : { key, value: JSON.parse(record.serialized) };
      const size = encoder.encode(JSON.stringify(body)).byteLength;
      // The browser shares a 64 KiB limit across all pending keepalive requests.
      // Large new pastes use ordinary writes while the tab is open. The editor
      // also asks before leaving a document with unsaved changes.
      if (size > available) continue;
      available -= size; this.keepaliveBytes += size;
      const version = record.version;
      if (isDraft) record.closeWrites.set(version, record.serialized);
      const request = this.request('/api/storage', { method: isDraft ? 'PATCH' : 'PUT', body, keepalive: true, projectRoot: null, timeout: 0 })
        .then(response => this.acknowledge(key, record, response, version))
        .catch(error => {
          if (this.stopped || this.records.get(key) !== record) return;
          if (isDraft && error.status === 409 && record.saved < version) record.conflict = error;
          if (!this.unloading && !this.isPaused(key)) this.onStatus?.('error', key, error);
        })
        .finally(() => { this.keepaliveBytes -= size; record.closeWrites.delete(version); this.keepaliveRequests.delete(request); });
      this.keepaliveRequests.add(request);
    }
  }

  resume() {
    if (this.stopped) return Promise.resolve();
    this.unloading = false;
    return this.flush();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.unloading = true;
    for (const record of this.records.values()) { clearTimeout(record.timer); record.timer = null; }
    this.records.clear();
    this.pauses.clear();
    for (const controller of this.controllers) controller.abort();
  }

  get pending() { return [...this.records.values()].some(record => record.saved < record.version); }
}
