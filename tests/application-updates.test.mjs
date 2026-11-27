import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { UpdatePreparation, applicationUpdateMessage, createApplicationUpdates, updateReleaseNotesURL } from '../web/src/application-updates.js';
import { setLanguage } from '../web/src/i18n.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function preparation(options = {}) {
  const requests = [], releases = [], applying = [], failures = [];
  const session = new UpdatePreparation({
    clientId: 'editor-one', api: async (url, options) => { requests.push({ url, ...options }); return {}; },
    prepare: async () => ({ ready: true }), release: () => releases.push(true),
    onApplying: () => applying.push(true), onError: error => failures.push(error), ...options,
  });
  return { session, requests, releases, applying, failures };
}

test('an editor acknowledges an update only after its writes finish', async () => {
  const written = deferred(), inputs = [];
  const { session, requests, releases } = preparation({ prepare: value => { inputs.push(value); return written.promise; } });
  try {
    const pending = session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
    await delay(0);
    assert.deepEqual(inputs, [{ automatic: true }]);
    assert.equal(requests.length, 0);
    assert.equal(session.prepared, false);
    written.resolve({ ready: true }); await pending;
    assert.equal(session.prepared, true);
    assert.deepEqual(requests, [{ url: '/api/updates/ready', method: 'POST', projectRoot: null, body: {
      clientId: 'editor-one', attemptId: 'first', ready: true, reason: '',
    } }]);
    assert.equal(releases.length, 0);
  } finally { session.cancel(); }
});

test('an unsaved editor declines the attempt and continues editing', async () => {
  const { session, requests, releases } = preparation({ prepare: async () => ({ ready: false, reason: 'Unsaved document' }) });
  await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  assert.equal(session.prepared, false);
  assert.equal(requests[0].body.ready, false);
  assert.equal(requests[0].body.reason, 'Unsaved document');
  assert.equal(releases.length, 1);
});

test('a failed settings or draft write declines the update', async () => {
  const { session, requests } = preparation({ prepare: async () => { throw new Error('Disk is full'); } });
  await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  assert.equal(requests[0].body.ready, false);
  assert.equal(requests[0].body.reason, 'Disk is full');
  assert.equal(session.prepared, false);
});

test('a cancelled attempt cannot acknowledge a write that finishes later', async () => {
  const written = deferred();
  const { session, requests, releases } = preparation({ prepare: () => written.promise });
  const pending = session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  await session.handle({ type: 'update-cancelled', attemptId: 'first' });
  written.resolve({ ready: true }); await pending;
  assert.equal(session.prepared, false);
  assert.equal(requests.length, 0);
  assert.equal(releases.length, 1);
});

test('an old cancellation does not release another attempt', async () => {
  const { session, requests, releases } = preparation();
  try {
    await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: false });
    await session.handle({ type: 'prepare-update', attemptId: 'second', automatic: false });
    await session.handle({ type: 'update-cancelled', attemptId: 'first' });
    assert.equal(requests.length, 2);
    assert.equal(releases.length, 1);
    assert.equal(session.prepared, true);
  } finally { session.cancel(); }
});

test('a cancellation after installation failure releases the current attempt', async () => {
  const { session, releases } = preparation();
  await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  await session.handle({ type: 'applying-update', attemptId: 'first' });
  await session.handle({ type: 'update-cancelled', message: 'The installer could not finish.' });
  assert.equal(session.prepared, false);
  assert.equal(releases.length, 1);
});

test('manual preparation works when the server omits its false automatic field', async () => {
  const values = [];
  const { session } = preparation({ prepare: async value => { values.push(value); return { ready: false }; } });
  await session.handle({ type: 'prepare-update', attemptId: 'manual' });
  assert.deepEqual(values, [{ automatic: false }]);
});

test('an unresponsive update releases the editor and withdraws readiness', async () => {
  const { session, requests, releases } = preparation({ timeout: 5 });
  await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  await delay(20);
  assert.equal(session.prepared, false);
  assert.deepEqual(requests.map(request => request.body.ready), [true, false]);
  assert.equal(releases.length, 1);
});

test('applying keeps a prepared editor ready for reconnection and ignores other attempts', async () => {
  const { session, applying } = preparation();
  try {
    await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
    await session.handle({ type: 'applying-update', attemptId: 'other' });
    assert.equal(applying.length, 0);
    await session.handle({ type: 'applying-update', attemptId: 'first' });
    assert.equal(applying.length, 1);
    assert.equal(session.prepared, true);
  } finally { session.cancel(); }
});

test('a slow native installation keeps editing frozen until the server releases it', async () => {
  const requests = [];
  const { session, releases } = preparation({ restartTimeout: 5, api: async (url, options) => {
    requests.push({ url, ...options });
    return { phase: 'applying' };
  } });
  try {
    await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
    await session.handle({ type: 'applying-update', attemptId: 'first' });
    await delay(20);
    assert.ok(requests.some(request => request.url === '/api/updates'));
    assert.equal(session.prepared, true);
    assert.equal(releases.length, 0);
    await session.handle({ type: 'update-cancelled' });
    assert.equal(session.prepared, false);
    assert.equal(releases.length, 1);
  } finally { session.cancel(); }
});

test('a failed acknowledgement resumes editing', async () => {
  const { session, releases, failures } = preparation({ api: async () => { throw Object.assign(new Error('Attempt expired'), { status: 409 }); } });
  await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
  assert.equal(session.prepared, false);
  assert.equal(releases.length, 1);
  assert.equal(failures[0].message, 'Attempt expired');
});

test('an interrupted acknowledgement waits for the restarting server', async () => {
  const { session, releases } = preparation({ api: async () => { throw new Error('Connection interrupted'); } });
  try {
    await session.handle({ type: 'prepare-update', attemptId: 'first', automatic: true });
    assert.equal(session.prepared, true);
    assert.equal(releases.length, 0);
    await session.handle({ type: 'update-cancelled', attemptId: 'first' });
    assert.equal(session.prepared, false);
    assert.equal(releases.length, 1);
  } finally { session.cancel(); }
});

test('release notes link to published releases of this application', () => {
  const base = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases';
  assert.equal(updateReleaseNotesURL(`${base}/tag/v0.1.17`), `${base}/tag/v0.1.17`);
  assert.equal(updateReleaseNotesURL('https://example.org/releases'), `${base}/latest`);
  assert.equal(updateReleaseNotesURL('javascript:alert(1)'), `${base}/latest`);
  assert.equal(updateReleaseNotesURL(`${base}-elsewhere`), `${base}/latest`);
});

test('Store update details link to this application in the Microsoft Store', () => {
  const listing = 'https://apps.microsoft.com/detail/9P6QF32N19HG';
  const fallback = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/latest';
  assert.equal(updateReleaseNotesURL(listing), listing);
  assert.equal(updateReleaseNotesURL('https://apps.microsoft.com/detail/another-application'), fallback);
  assert.equal(updateReleaseNotesURL(`${listing}?next=https://example.org/`), fallback);
});

test('an automatic update choice stays visible while saving and after an older read finishes', async () => {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, events: {},
      addEventListener(event, callback) { this.events[event] = callback; },
      setAttribute() {}, removeAttribute() {},
    });
    return elements.get(id);
  } };
  const initial = { supported: true, automatic: true, phase: 'idle' };
  const oldRead = deferred(), saved = deferred();
  let reads = 0;
  const updates = createApplicationUpdates({ document, api: async (url, options) => {
    if (url === '/api/updates/settings') {
      assert.equal(options.body.automatic, false);
      return saved.promise;
    }
    return ++reads === 1 ? initial : oldRead.promise;
  } });
  try {
    await updates.refresh();
    const pendingRead = updates.refresh();
    const checkbox = document.getElementById('application-updates-automatic');
    checkbox.checked = false;
    checkbox.events.change();
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, true);
    saved.resolve({ ...initial, automatic: false });
    await delay(0);
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, false);
    oldRead.resolve(initial);
    await pendingRead;
    assert.equal(checkbox.checked, false);
    assert.equal(updates.snapshot.automatic, false);
  } finally { updates.destroy(); }
});

test('update messages follow the current language and automatic update setting', () => {
  try {
    setLanguage('en');
    assert.match(applicationUpdateMessage({ supported: true, phase: 'ready', automatic: true, latestVersion: '0.1.17' }), /automatically/);
    assert.doesNotMatch(applicationUpdateMessage({ supported: true, phase: 'ready', automatic: false, latestVersion: '0.1.17' }), /automatically/);
    assert.equal(applicationUpdateMessage({ supported: true, phase: 'ready', automatic: false, latestVersion: '' }), 'The app update is ready.');
    setLanguage('ja');
    assert.match(applicationUpdateMessage({ supported: true, phase: 'ready', automatic: true, latestVersion: '0.1.17' }), /v0\.1\.17.*自動/);
    assert.equal(applicationUpdateMessage({ supported: true, phase: 'waiting', message: '別の編集画面で保存中です．' }), '別の編集画面で保存中です．');
  } finally { setLanguage('en'); }
});
