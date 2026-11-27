import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signedAppcast } from './app-update-release.mjs';

if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Run this check on macOS with the Sparkle sign_update tool.');
const execute = promisify(execFile);
const signer = path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(os.tmpdir(), 'local-tex-sparkle-signatures-'));
try {
  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const keyFile = path.join(directory, 'test-key');
  await writeFile(keyFile, `${seed}\n`, { mode: 0o600 });
  const archive = Buffer.from('Sparkle checks the same bytes that the release script signs.\n');
  const archiveFile = path.join(directory, 'test-update.zip');
  await writeFile(archiveFile, archive);
  const feed = signedAppcast({ version: '1.2.3', date: '2026-11-27T00:00:00Z', asset: { url: 'https://example.com/update.zip' }, archive }, privateKey);
  const feedFile = path.join(directory, 'appcast.xml');
  await writeFile(feedFile, feed);
  const [, archiveSignature] = feed.toString('utf8').match(/sparkle:edSignature="([^"]+)"/);
  await execute(signer, ['--ed-key-file', keyFile, '--verify', feedFile]);
  await execute(signer, ['--ed-key-file', keyFile, '--verify', archiveFile, archiveSignature]);
  const changedFeed = Buffer.from(feed);
  changedFeed[changedFeed.indexOf('1.2.3')] = 50;
  await writeFile(feedFile, changedFeed);
  await assert.rejects(execute(signer, ['--ed-key-file', keyFile, '--verify', feedFile]));
  await writeFile(archiveFile, Buffer.concat([archive, Buffer.from('changed')]));
  await assert.rejects(execute(signer, ['--ed-key-file', keyFile, '--verify', archiveFile, archiveSignature]));
  console.log('Sparkle verified the release signatures and rejected changed update files.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
