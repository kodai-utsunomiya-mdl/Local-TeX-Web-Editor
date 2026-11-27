import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertSuccessfulMainRun, createStoreMetadata, findReleaseRuns, lastCompletedRun,
} from '../scripts/prepare-store-release.mjs';

const repository = 'kodai-utsunomiya-mdl/Local-TeX-Web-Editor';
const sha = 'a'.repeat(40);
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const document = readFileSync(new URL('../docs/microsoft-store-listing.md', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');
const releaseBody = readFileSync(new URL(`../release-notes/v${appVersion}.md`, import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n');

function metadata(source = document) {
  return createStoreMetadata(source, releaseBody, appVersion, sha, repository);
}

test('the Store listing uses the prepared short release notes and all installed-app images', () => {
  const result = metadata();
  assert.equal(result.productId, '9P6QF32N19HG');
  assert.equal(result.appVersion, appVersion);
  assert.deepEqual(Object.keys(result.listings), ['en-us', 'ja-jp']);
  for (const listing of Object.values(result.listings)) {
    assert.ok(listing.description.length > 1000);
    assert.ok(listing.releaseNotes.length <= 1500);
    assert.ok(listing.releaseNotes.includes(appVersion));
    assert.equal(listing.features.length, 20);
    assert.equal(listing.screenshots.length, 8);
    assert.equal(listing.screenshots[1].fileName, 'editor-markdown-light.png');
    assert.deepEqual(listing.icon, { fileName: 'store-logo-300.png' });
  }
  assert.match(result.notesForCertification, new RegExp(`/blob/${sha}/`));
});

test('Windows line endings produce the same Store listing', () => {
  assert.deepEqual(metadata(document.replaceAll('\n', '\r\n')), metadata());
});

test('release notes for an earlier app version stop preparation', () => {
  assert.throws(() => metadata(document.replace(`Version ${appVersion}\n`, 'Version 0.0.1\n')), /another version/);
  assert.throws(() => metadata(document.replace(`バージョン ${appVersion}\n`, 'バージョン 0.0.1\n')), /another version/);
});

test('a missing translated screenshot caption stops preparation', () => {
  const withoutImage = document.replace(/^\| `editor-markdown-light\.png` .*\n/m, '');
  assert.throws(() => metadata(withoutImage), /Missing screenshot caption/);
});

function run(overrides = {}) {
  return {
    id: 1, path: '.github/workflows/microsoft-store.yml', head_branch: 'main',
    event: 'push', status: 'completed', conclusion: 'success', head_sha: sha,
    head_repository: { full_name: repository }, updated_at: '2026-11-26T14:00:00Z',
    ...overrides,
  };
}

test('only a successful run on main in the expected repository is eligible', () => {
  assert.doesNotThrow(() => assertSuccessfulMainRun(run(), repository, 'store', sha));
  for (const mismatch of [
    { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { head_repository: { full_name: 'someone/fork' } },
    { path: '.github/workflows/other.yml' }, { head_sha: 'b'.repeat(40) },
  ]) {
    assert.throws(() => assertSuccessfulMainRun(run(mismatch), repository, 'store', sha));
  }
});

test('the later completed workflow owns preparation regardless of event delivery order', () => {
  const first = run({ id: 1 });
  const last = run({ id: 2, updated_at: '2026-11-26T14:01:00Z' });
  assert.equal(lastCompletedRun([first, last]), last);
  assert.equal(lastCompletedRun([last, first]), last);
  assert.equal(lastCompletedRun([]), undefined);
});

test('runs completed in the same second use one consistent owner', () => {
  const first = run({ id: 1 });
  const second = run({ id: 2 });
  assert.equal(lastCompletedRun([first, second]), second);
  assert.equal(lastCompletedRun([second, first]), second);
});

function releaseRepository({ release = {}, storeRuns, buildRuns } = {}) {
  const releaseSha = 'c'.repeat(40);
  const calls = [];
  const store = run({ id: 10, head_sha: releaseSha });
  const build = run({ id: 20, head_sha: releaseSha, path: '.github/workflows/windows.yml',
    updated_at: '2026-11-26T14:02:00Z' });
  const readApi = route => {
    calls.push(route);
    if (route === `repos/${repository}/releases/latest`) return {
      tag_name: 'v0.1.18', draft: false, prerelease: false, published_at: '2026-11-26T14:03:00Z', ...release,
    };
    assert.ok(route.includes(`head_sha=${releaseSha}`));
    assert.ok(route.includes('branch=main&event=push&status=success'));
    if (route.includes('/microsoft-store.yml/runs?')) return { workflow_runs: storeRuns ?? [store] };
    if (route.includes('/windows.yml/runs?')) return { workflow_runs: buildRuns ?? [build] };
    throw new Error(`Unexpected GitHub request: ${route}`);
  };
  const readTag = (name, tag) => {
    assert.equal(name, repository);
    assert.equal(tag, 'v0.1.18');
    return releaseSha;
  };
  return { readApi, readTag, calls, releaseSha, store, build };
}

test('a scheduled retry chooses both successful main runs from the latest stable release tag', () => {
  const remote = releaseRepository();
  const result = findReleaseRuns({ repository, latest: true }, remote);
  assert.deepEqual(result, { ready: true, headSha: remote.releaseSha, storeRun: remote.store, buildRun: remote.build });
  assert.equal(remote.calls[0], `repos/${repository}/releases/latest`);
  assert.equal(remote.calls.length, 3);
});

test('a retry waits when either set of tests for the latest release is missing or comes from another commit', () => {
  for (const changes of [
    { storeRuns: [] }, { buildRuns: [] },
    { storeRuns: [run({ head_sha: 'd'.repeat(40) })] },
    { storeRuns: [run({ head_sha: 'c'.repeat(40), event: 'pull_request' })] },
  ]) {
    const result = findReleaseRuns({ repository, latest: true }, releaseRepository(changes));
    assert.equal(result.ready, false);
    assert.match(result.reason, /same main commit/);
  }
});

test('a retry requires a public stable release with an app version tag', () => {
  for (const release of [{ draft: true }, { prerelease: true }, { published_at: null }, { tag_name: 'nightly' }]) {
    assert.throws(() => findReleaseRuns({ repository, latest: true }, releaseRepository({ release })));
  }
  assert.throws(() => findReleaseRuns({ repository, latest: true, storeRunId: '10' }, releaseRepository()),
    /latest release or a Store run ID/);
});

test('workflow events still prepare only after the later successful run completes', () => {
  const remote = releaseRepository();
  const earlier = findReleaseRuns({ repository, event: { workflow_run: remote.store } }, remote);
  assert.equal(earlier.ready, false);
  assert.match(earlier.reason, /completed later/);
  const later = findReleaseRuns({ repository, event: { workflow_run: remote.build } }, remote);
  assert.equal(later.ready, true);
  assert.equal(later.headSha, remote.releaseSha);
});
