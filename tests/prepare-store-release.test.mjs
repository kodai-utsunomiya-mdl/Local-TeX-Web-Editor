import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertSuccessfulMainRun, createStoreMetadata, lastCompletedRun,
} from '../scripts/prepare-store-release.mjs';

const repository = 'kodai-utsunomiya-mdl/Local-TeX-Web-Editor';
const sha = 'a'.repeat(40);
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const document = readFileSync(new URL('../docs/microsoft-store-listing.md', import.meta.url), 'utf8');
const releaseBody = readFileSync(new URL(`../release-notes/v${appVersion}.md`, import.meta.url), 'utf8');

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
