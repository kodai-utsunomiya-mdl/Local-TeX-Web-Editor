import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor';
const root = path.resolve(import.meta.dirname, '..');

export function updateSigningKey(seedText, expectedPublicKey) {
  const seed = Buffer.from(String(seedText || '').trim(), 'base64');
  if (seed.length !== 32) throw new Error('Set APP_UPDATE_PRIVATE_KEY to the base64 Ed25519 seed before publishing automatic updates.');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), type: 'pkcs8', format: 'der' });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  if (publicKey !== String(expectedPublicKey).trim()) throw new Error('The update signing key does not match the public key embedded in the application.');
  return privateKey;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function signedAppcast({ version, date, asset, archive }, key) {
  const signature = sign(null, archive, key).toString('base64');
  const content = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">\n  <channel>\n    <title>Local TeX Web Editor updates</title>\n    <link>${repository}</link>\n    <description>Application updates for macOS.</description>\n    <language>en</language>\n    <item>\n      <title>Local TeX Web Editor ${xml(version)}</title>\n      <link>${repository}/releases/tag/v${xml(version)}</link>\n      <pubDate>${xml(new Date(date).toUTCString())}</pubDate>\n      <sparkle:version>${xml(version)}</sparkle:version>\n      <sparkle:shortVersionString>${xml(version)}</sparkle:shortVersionString>\n      <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>\n      <enclosure url="${xml(asset.url)}" length="${archive.length}" type="application/octet-stream" sparkle:edSignature="${signature}" />\n    </item>\n  </channel>\n</rss>\n`, 'utf8');
  const feedSignature = sign(null, content, key).toString('base64');
  return Buffer.concat([content, Buffer.from(`<!-- sparkle-signatures:\nedSignature: ${feedSignature}\nlength: ${content.length}\n-->\n`)]);
}

export async function prepareAppUpdates({ directory, version, privateSeed, publicKey, date = new Date().toISOString() }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Automatic updates require a stable version.');
  const key = updateSigningKey(privateSeed, publicKey);
  const assets = {}, archives = {};
  for (const [platform, suffix] of [['windows-amd64', 'windows-x64.zip'], ['darwin-universal', 'macos-universal.zip']]) {
    const name = `local-tex-web-editor-${version}-${suffix}`;
    const archive = await readFile(path.join(directory, name));
    if (!archive.length || archive.length > 256 * 1024 * 1024) throw new Error(`Unexpected update archive size: ${name}`);
    archives[platform] = archive;
    assets[platform] = { url: `${repository}/releases/download/v${version}/${name}`, sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length };
  }
  const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, version, publishedAt: date, releaseNotesURL: `${repository}/releases/tag/v${version}`, assets }, null, 2)}\n`);
  const signature = `${sign(null, manifest, key).toString('base64')}\n`;
  const appcast = signedAppcast({ version, date, asset: assets['darwin-universal'], archive: archives['darwin-universal'] }, key);
  await writeFile(path.join(directory, 'app-update.json'), manifest);
  await writeFile(path.join(directory, 'app-update.json.sig'), signature);
  await writeFile(path.join(directory, 'appcast.xml'), appcast);
  return ['app-update.json', 'app-update.json.sig', 'appcast.xml'];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const files = await prepareAppUpdates({ directory: path.resolve(process.argv[2] || '.'), version, privateSeed: process.env.APP_UPDATE_PRIVATE_KEY, publicKey: await readFile(path.join(root, 'internal/updater/public-key.txt'), 'utf8') });
  console.log(`Prepared signed application updates: ${files.join(', ')}`);
}
