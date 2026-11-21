import { parseTeXPackageNames } from './tex-packages.js';

export const isTeXSetupRunning = snapshot => ['running', 'cancelling'].includes(snapshot?.status);

export function teXEnvironment(snapshot) {
  if (snapshot?.environment) return snapshot.environment;
  const managed = !!snapshot?.managed;
  return { directory: managed ? snapshot.directory || '' : '', bin: managed ? snapshot.bin || '' : '', managed,
    canInstallPackages: managed, canRemovePackages: managed, canUninstall: managed, requiresElevation: false };
}

export function missingTeXPrograms(meta) {
  if (!meta) return [];
  const required = ['latexmk'];
  const mode = meta.project?.mode;
  if (['pdflatex', 'lualatex', 'xelatex'].includes(mode)) required.push(mode);
  else if (mode === 'uplatex') required.push('uplatex', 'dvipdfmx');
  return required.filter(name => {
    if (name === 'latexmk') return !meta.latexmk;
    const program = meta.texPackages?.programs?.find(value => value.name === name);
    return program && !program.available;
  });
}

export function texSetupProgress(snapshot) {
  const downloaded = Math.max(0, Number(snapshot?.downloadedBytes) || 0);
  const total = Math.max(0, Number(snapshot?.downloadTotal) || 0);
  return { downloaded, total, fraction: total > 0 ? Math.min(1, downloaded / total) : null };
}

// A browser tab observes a server-owned job. Closing the tab or aborting a GET
// does not stop installation; stopping always requires the dedicated POST.
export class TeXSetupSession {
  constructor({ api, onState = () => {}, onComplete = async () => {}, setTimer = setTimeout, clearTimer = clearTimeout, pollInterval = 1000 }) {
    Object.assign(this, { api, onState, onComplete, setTimer, clearTimer, pollInterval });
    this.snapshot = null;
    this.error = null;
    this.toolsError = null;
    this.pending = '';
    this.loading = false;
    this.checking = false;
    this.sequence = 0;
    this.timer = null;
    this.read = null;
    this.destroyed = false;
    this.hint = '';
    this.completed = new Set();
  }

  get busy() { return !!this.pending || isTeXSetupRunning(this.snapshot); }
  notify() { if (!this.destroyed) this.onState(this); }
  clearError() { this.error = null; this.notify(); }

  schedule() {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.destroyed && isTeXSetupRunning(this.snapshot) && !this.pending) {
      this.timer = this.setTimer(() => { this.timer = null; void this.refresh(); }, this.pollInterval);
    }
  }

  accept(snapshot) {
    if (this.destroyed || !snapshot || typeof snapshot.status !== 'string') return;
    this.snapshot = snapshot;
    this.notify();
    const key = `${snapshot.id}:${snapshot.status}`;
    if (snapshot.id && ['succeeded', 'failed', 'cancelled'].includes(snapshot.status) && !this.completed.has(key)) {
      this.completed.add(key);
      void this.checkTools(snapshot);
    }
    this.schedule();
  }

  async checkTools(snapshot = this.snapshot) {
    if (this.destroyed) return;
    this.pendingTools = snapshot;
    if (this.checking) return;
    this.checking = true; this.error = null; this.toolsError = null; this.notify();
    try {
      do {
        const current = this.pendingTools; this.pendingTools = null;
        await this.onComplete(current);
      } while (this.pendingTools && !this.destroyed);
    }
    catch (error) { if (!this.destroyed) { this.error = error; this.toolsError = error; } }
    finally { this.checking = false; this.notify(); }
  }

  sync(snapshot) {
    if (!snapshot || this.destroyed) return;
    const hint = JSON.stringify([snapshot.id, snapshot.status, snapshot.stage, snapshot.managed, snapshot.bin, snapshot.directory, snapshot.environment]);
    if (hint === this.hint) return;
    this.hint = hint;
    if (!this.snapshot) this.accept(snapshot);
    else if (!this.pending && (snapshot.id !== this.snapshot.id || snapshot.status !== this.snapshot.status || snapshot.managed !== this.snapshot.managed
      || snapshot.bin !== this.snapshot.bin || snapshot.directory !== this.snapshot.directory
      || JSON.stringify(snapshot.environment) !== JSON.stringify(this.snapshot.environment))) void this.refresh();
  }

  abortRead() {
    ++this.sequence;
    this.read?.controller.abort();
    this.read = null; this.loading = false;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (this.destroyed || this.pending) return this.snapshot;
    if (this.read) return this.read.promise;
    const controller = new AbortController();
    const sequence = ++this.sequence;
    this.loading = true;
    const request = { controller, promise: null };
    this.read = request; this.notify();
    request.promise = (async () => {
      try {
        const snapshot = await this.api('/api/tex/setup', { projectRoot: null, signal: controller.signal, timeout: 60000 });
        if (this.destroyed || sequence !== this.sequence) return this.snapshot;
        this.error = this.toolsError; this.accept(snapshot);
        return snapshot;
      } catch (error) {
        if (!this.destroyed && sequence === this.sequence && !controller.signal.aborted) { this.error = error; this.notify(); }
        return null;
      } finally {
        if (this.read === request) { this.read = null; this.loading = false; this.notify(); this.schedule(); }
      }
    })();
    return request.promise;
  }

  async start({ operation = 'install', parent = '', packages = [], reinstall = false, revision = '', directory = '' } = {}) {
    if (this.destroyed || this.busy || this.checking || !this.snapshot) return false;
    const body = { consent: true, operation };
    if (['packages', 'remove-packages'].includes(operation)) {
      const names = parseTeXPackageNames(Array.isArray(packages) ? packages.join(' ') : packages);
      const environment = teXEnvironment(this.snapshot);
      if (!(operation === 'packages' ? environment.canInstallPackages : environment.canRemovePackages) || !names) return false;
      body.packages = names;
      if (!environment.managed && (!directory || !revision)) return false;
      if (directory) body.directory = directory;
      if (revision) body.revision = revision;
      if (operation === 'packages') body.reinstall = !!reinstall;
      else if (!revision) return false;
    } else if (operation === 'install') {
      if (!this.snapshot.supported) return false;
      if (String(parent).trim()) body.parent = String(parent).trim();
    } else return false;
    return this.perform('/api/tex/setup', 'POST', body);
  }

  async uninstall({ directory, revision, confirmation, expectedConfirmation = 'TinyTeX' }) {
    if (this.destroyed || this.busy || this.checking || !teXEnvironment(this.snapshot).canUninstall || !directory || !revision || !expectedConfirmation || confirmation !== expectedConfirmation) return false;
    return this.perform('/api/tex/setup/delete', 'DELETE', { directory, revision, confirmation });
  }

  async perform(path, method, body) {
    this.abortRead(); this.pending = 'start'; this.error = null; this.notify();
    let accepted = false;
    try {
      const snapshot = await this.api(path, { method, body, projectRoot: null, timeout: method === 'DELETE' ? 660000 : 120000 });
      if (!this.destroyed) { this.accept(snapshot); accepted = true; }
    } catch (error) { if (!this.destroyed) this.error = error; }
    finally { this.pending = ''; this.notify(); this.schedule(); }
    // A lost start response can still leave a running job. Discover it before
    // presenting another start button, without sending a second POST.
    if (!accepted && !this.destroyed) {
      const error = this.error;
      await this.refresh();
      if (!isTeXSetupRunning(this.snapshot)) { this.error = error || this.error; this.notify(); }
    }
    return accepted;
  }

  async stop() {
    if (this.destroyed || this.pending || this.snapshot?.status !== 'running' || this.snapshot.cancelable === false || !this.snapshot.id) return;
    const id = this.snapshot.id;
    this.abortRead(); this.pending = 'stop'; this.error = null; this.notify();
    try {
      const snapshot = await this.api('/api/tex/setup/stop', { method: 'POST', body: { id }, projectRoot: null, timeout: 30000 });
      if (!this.destroyed) this.accept(snapshot);
    } catch (error) { if (!this.destroyed) this.error = error; }
    finally { this.pending = ''; this.notify(); this.schedule(); }
  }

  destroy() { this.destroyed = true; this.abortRead(); }
}
