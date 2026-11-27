import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareAppUpdates, updateSigningKey } from '../scripts/app-update-release.mjs';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateSeed: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), publicText: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'), publicKey };
}

test('release metadata and both Sparkle signatures verify with the embedded public key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'app-updates-'));
  try {
    const keys = keyPair(), version = '0.1.17', windows = Buffer.from('windows application archive'), mac = Buffer.from('universal macOS application archive');
    await writeFile(path.join(directory, `local-tex-web-editor-${version}-windows-x64.zip`), windows);
    await writeFile(path.join(directory, `local-tex-web-editor-${version}-macos-universal.zip`), mac);
    const names = await prepareAppUpdates({ directory, version, privateSeed: keys.privateSeed, publicKey: keys.publicText, date: '2026-11-27T00:00:00.000Z' });
    assert.equal(names.length, 3);
    const manifest = await readFile(path.join(directory, 'app-update.json'));
    assert.equal(verify(null, manifest, keys.publicKey, Buffer.from((await readFile(path.join(directory, 'app-update.json.sig'), 'utf8')).trim(), 'base64')), true);
    const details = JSON.parse(manifest);
    assert.equal(details.assets['windows-amd64'].sha256, createHash('sha256').update(windows).digest('hex'));
    assert.equal(details.assets['darwin-universal'].size, mac.length);
    const feed = await readFile(path.join(directory, 'appcast.xml'), 'utf8');
    const [, archiveSignature] = feed.match(/sparkle:edSignature="([^"]+)"/);
    assert.equal(verify(null, mac, keys.publicKey, Buffer.from(archiveSignature, 'base64')), true);
    const [, feedSignature, length] = feed.match(/<!-- sparkle-signatures:\nedSignature: ([^\n]+)\nlength: (\d+)\n-->/);
    const signed = Buffer.from(feed).subarray(0, Number(length));
    assert.equal(verify(null, signed, keys.publicKey, Buffer.from(feedSignature, 'base64')), true);
    assert.equal(signed.toString().endsWith('</rss>\n'), true);
    assert.equal(feed.includes(`<sparkle:version>${version}</sparkle:version>`), true);
    const changed = Buffer.from(signed); changed[50] ^= 1;
    assert.equal(verify(null, changed, keys.publicKey, Buffer.from(feedSignature, 'base64')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publishing refuses a missing or unrelated signing key', () => {
  const keys = keyPair();
  assert.throws(() => updateSigningKey('', keys.publicText), /APP_UPDATE_PRIVATE_KEY/);
  assert.throws(() => updateSigningKey(keyPair().privateSeed, keys.publicText), /does not match/);
});
