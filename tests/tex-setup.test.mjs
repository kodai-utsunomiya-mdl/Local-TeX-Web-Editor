import test from 'node:test';
import assert from 'node:assert/strict';
import { TeXSetupSession, missingTeXPrograms, teXEnvironment, texSetupProgress } from '../web/src/tex-setup-session.js';
import { formatTeXSetupBytes } from '../web/src/tex-setup.js';
import { parseTeXPackageNames } from '../web/src/tex-packages.js';
import { filterTeXPackages, teXRemovalMethod } from '../web/src/tex-management.js';
import { setLanguage } from '../web/src/i18n.js';

const idle = { supported: true, status: 'idle', operation: '', id: '', parent: '/home/user/Applications', managed: false };
const running = { ...idle, status: 'running', operation: 'install', id: 'one', stage: 'downloading' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function createSession(api, options = {}) {
  const timers = new Map(); let id = 0;
  const session = new TeXSetupSession({ api,
    setTimer(callback) { const key = ++id; timers.set(key, callback); return key; },
    clearTimer(key) { timers.delete(key); }, ...options,
  });
  return { session, timers };
}

test('TeX availability checks the selected compiler and leaves other engines optional', () => {
  const meta = { latexmk: '/tex/latexmk', project: { mode: 'pdflatex' }, texPackages: { programs: [
    { name: 'pdflatex', available: true }, { name: 'synctex', available: false },
    { name: 'uplatex', available: false }, { name: 'dvipdfmx', available: false },
  ] } };
  assert.deepEqual(missingTeXPrograms(meta), []);
  assert.deepEqual(missingTeXPrograms({ ...meta, project: { mode: 'uplatex' } }), ['uplatex', 'dvipdfmx']);
  assert.deepEqual(missingTeXPrograms({ ...meta, latexmk: '', project: { mode: 'project' } }), ['latexmk']);
  assert.deepEqual(missingTeXPrograms(null), []);
});

test('the selected TeX environment supplies the current path after a job finishes or an environment is removed', () => {
  const previous = { ...idle, status: 'succeeded', operation: 'uninstall', directory: '/Applications/TinyTeX', bin: '/Applications/TinyTeX/bin' };
  const removed = teXEnvironment(previous);
  assert.equal(removed.directory, '');
  assert.equal(removed.bin, '');
  assert.equal(removed.managed, false);
  assert.equal(removed.canInstallPackages, false);
  assert.equal(removed.canRemovePackages, false);
  assert.equal(removed.canUninstall, false);

  const selected = { directory: '/usr/local/texlive/2026', bin: '/usr/local/texlive/2026/bin', managed: false,
    canInstallPackages: true, canRemovePackages: true, canUninstall: true };
  assert.equal(teXEnvironment({ ...previous, environment: selected }), selected);

  const managed = teXEnvironment({ ...idle, managed: true, directory: '/Applications/TinyTeX', bin: '/Applications/TinyTeX/bin' });
  assert.equal(managed.directory, '/Applications/TinyTeX');
  assert.equal(managed.bin, '/Applications/TinyTeX/bin');
  assert.equal(managed.canInstallPackages, true);
});

test('setup byte counts and download progress handle unknown totals and clamp a completed download', () => {
  setLanguage('en');
  assert.equal(formatTeXSetupBytes(0), '0 B');
  assert.equal(formatTeXSetupBytes(251_500_000), '251.5 MB');
  assert.equal(formatTeXSetupBytes(1_250_000_000), '1.25 GB');
  assert.deepEqual(texSetupProgress({ downloadedBytes: 50 }), { downloaded: 50, total: 0, fraction: null });
  assert.deepEqual(texSetupProgress({ downloadedBytes: 150, downloadTotal: 100 }), { downloaded: 150, total: 100, fraction: 1 });
});

test('opening or refreshing setup only reads the status; starting requires an explicit call with consent', async () => {
  const requests = [];
  const { session } = createSession(async (path, options) => { requests.push({ path, ...options }); return options.method === 'POST' ? running : idle; });
  session.sync(idle);
  assert.equal(requests.length, 0);
  await session.refresh();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, undefined);
  await session.start({ parent: '  /home/user/TeX files  ' });
  assert.deepEqual(requests[1].body, { consent: true, operation: 'install', parent: '/home/user/TeX files' });
  assert.equal(requests[1].projectRoot, null);
  assert.equal(session.snapshot.status, 'running');
  session.destroy();
});

test('late status reads cannot replace a newly started job and a double start sends one POST', async () => {
  const read = deferred(), start = deferred(); const requests = [];
  const { session } = createSession((path, options) => { requests.push({ path, ...options }); return options.method === 'POST' ? start.promise : read.promise; });
  session.sync(idle);
  const reading = session.refresh();
  const starting = session.start();
  assert.equal(await session.start(), false);
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(requests[0].signal.aborted, true);
  start.resolve(running); await starting;
  read.resolve(idle); await reading;
  assert.equal(session.snapshot.id, 'one');
  assert.equal(session.busy, true);
  session.destroy();
});

test('a lost start response is reconciled with the server without repeating installation', async () => {
  const requests = [];
  const { session } = createSession(async (path, options) => {
    requests.push({ path, ...options });
    if (options.method === 'POST') throw new Error('The response was lost');
    return running;
  });
  session.sync(idle);
  await session.start();
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(session.snapshot.status, 'running');
  assert.equal(session.error, null);
  session.destroy();
});

test('stopping is explicit, sends the observed job id once, and waits for a terminal status', async () => {
  const stopping = deferred(); const requests = [];
  const { session, timers } = createSession(async (path, options) => {
    requests.push({ path, ...options });
    return path.endsWith('/stop') ? stopping.promise : { ...running, status: 'cancelled', stage: '' };
  });
  session.sync(running);
  assert.equal(timers.size, 1);
  const result = session.stop(); await session.stop();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/tex/setup/stop');
  assert.deepEqual(requests[0].body, { id: 'one' });
  assert.equal(requests[0].projectRoot, null);
  stopping.resolve({ ...running, status: 'cancelling' }); await result;
  assert.equal(session.busy, true);
  await session.refresh(); await tick();
  assert.equal(session.busy, false);
  assert.equal(session.snapshot.status, 'cancelled');
  assert.equal(timers.size, 0);
  session.destroy();
});

test('a new browser session observes a running job and stopping observation leaves the server job alone', async () => {
  const requests = [];
  const { session, timers } = createSession(async (path, options) => { requests.push({ path, ...options }); return running; });
  session.sync(running);
  assert.equal(timers.size, 1);
  await session.refresh();
  session.destroy();
  assert.equal(timers.size, 0);
  assert.ok(requests.every(request => request.method !== 'POST'));
});

test('completion rechecks tools once and a failed recheck can be retried without installing again', async () => {
  let checks = 0; const requests = [];
  const finished = { ...running, status: 'succeeded', stage: 'complete', managed: true, bin: '/tex/bin' };
  const { session } = createSession(async (path, options) => { requests.push({ path, ...options }); return finished; }, {
    onComplete: async () => { if (++checks === 1) throw new Error('Reconnect to read the new path'); },
  });
  session.sync(finished); await tick();
  assert.equal(checks, 1); assert.match(session.error.message, /Reconnect/);
  await session.refresh(); await tick();
  assert.equal(checks, 1);
  assert.match(session.error.message, /Reconnect/);
  await session.checkTools();
  assert.equal(checks, 2);
  assert.equal(session.error, null);
  assert.ok(requests.every(request => request.method !== 'POST'));
  session.destroy();
});

test('package installation validates names and requires permission for the selected TeX environment', async () => {
  const requests = [];
  const { session } = createSession(async (path, options) => { requests.push({ path, ...options }); return { ...running, operation: 'packages' }; });
  session.sync(idle);
  assert.equal(await session.start({ operation: 'packages', packages: ['siunitx'] }), false);
  session.accept({ ...idle, managed: true });
  for (const input of ['', '--all', 'foo;rm', 'foo/bar', 'foo $(id)', "foo'"]) {
    assert.equal(parseTeXPackageNames(input), null);
    assert.equal(await session.start({ operation: 'packages', packages: input }), false);
  }
  assert.equal(requests.length, 0);
  await session.start({ operation: 'packages', packages: ['siunitx', 'siunitx', 'latexmk'], reinstall: true });
  assert.deepEqual(requests[0].body, { consent: true, operation: 'packages', packages: ['siunitx', 'latexmk'], reinstall: true });
  session.destroy();
});

test('package names accept the backend character and count limits, including names with capital letters', () => {
  assert.deepEqual(parseTeXPackageNames('ETbb TeXGyre ETbb'), ['ETbb', 'TeXGyre']);
  assert.equal(parseTeXPackageNames(Array.from({ length: 128 }, (_, index) => `package-${index}`).join(' ')).length, 128);
  assert.equal(parseTeXPackageNames(Array.from({ length: 129 }, (_, index) => `package-${index}`).join(' ')), null);
  assert.ok(parseTeXPackageNames('a'.repeat(128)));
  assert.equal(parseTeXPackageNames('a'.repeat(129)), null);
});

test('an external TeX environment uses its capabilities and the reviewed directory and revision', async () => {
  const requests = [];
  const environment = { directory: '/usr/local/texlive/2026', bin: '/usr/local/texlive/2026/bin', managed: false,
    canInstallPackages: true, canRemovePackages: true, canUninstall: true, requiresElevation: true };
  const { session } = createSession(async (path, options) => { requests.push({ path, ...options }); return { ...running, environment }; });
  session.sync({ ...idle, supported: false, environment });
  assert.equal(await session.start({ operation: 'packages', packages: ['siunitx'] }), false);
  assert.equal(await session.start(), false);
  await session.start({ operation: 'packages', packages: ['siunitx'], directory: environment.directory, revision: 'external-one' });
  assert.deepEqual(requests[0].body, { consent: true, operation: 'packages', packages: ['siunitx'], directory: environment.directory, revision: 'external-one', reinstall: false });
  session.accept({ ...idle, environment: { ...environment, canInstallPackages: false, canRemovePackages: false } });
  assert.equal(await session.start({ operation: 'packages', packages: ['siunitx'], directory: environment.directory, revision: 'external-one' }), false);
  assert.equal(requests.length, 1);
  session.destroy();
});

test('package search matches all words against the package name and its description', () => {
  const packages = [{ name: 'siunitx', description: 'Typeset quantities and units' }, { name: 'latexmk', description: 'Build TeX documents' }];
  assert.deepEqual(filterTeXPackages(packages, 'SIUNI units'), [packages[0]]);
  assert.deepEqual(filterTeXPackages(packages, 'quantities latexmk'), []);
  assert.deepEqual(filterTeXPackages(packages, ''), packages);
});

test('environment removal describes the managed deletion, Trash, official uninstaller, or Windows Settings path', () => {
  assert.equal(teXRemovalMethod({ environment: { managed: true } }), 'delete');
  assert.equal(teXRemovalMethod({ environment: { managed: false, format: 'mactex' } }), 'trash');
  assert.equal(teXRemovalMethod({ environment: { managed: false, uninstaller: '/tex/uninstall.exe' } }), 'uninstaller');
  assert.equal(teXRemovalMethod({ environment: { managed: false, uninstaller: '/tex/uninstall.exe', uninstallInSettings: true } }), 'settings');
});

test('package removal sends the reviewed revision and environment removal uses its own DELETE', async () => {
  const requests = [];
  const { session } = createSession(async (path, options) => {
    requests.push({ path, ...options });
    return { ...running, managed: true, operation: options.method === 'DELETE' ? 'uninstall' : 'remove-packages', stage: 'deleting', cancelable: false };
  });
  session.sync({ ...idle, managed: true });
  assert.equal(await session.start({ operation: 'remove-packages', packages: ['siunitx'] }), false);
  await session.start({ operation: 'remove-packages', packages: ['siunitx'], revision: 'reviewed-one' });
  assert.deepEqual(requests[0].body, { consent: true, operation: 'remove-packages', packages: ['siunitx'], revision: 'reviewed-one' });
  session.accept({ ...idle, managed: true });
  assert.equal(await session.uninstall({ directory: '/tex', revision: 'files-one', confirmation: 'tinytex' }), false);
  await session.uninstall({ directory: '/tex', revision: 'files-one', confirmation: 'TinyTeX' });
  assert.equal(requests[1].path, '/api/tex/setup/delete');
  assert.equal(requests[1].method, 'DELETE');
  assert.equal(requests[1].projectRoot, null);
  assert.deepEqual(requests[1].body, { directory: '/tex', revision: 'files-one', confirmation: 'TinyTeX' });
  await session.stop();
  assert.equal(requests.length, 2);
  session.destroy();
});
