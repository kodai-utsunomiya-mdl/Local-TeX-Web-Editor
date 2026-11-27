import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { macOSUpdateConfiguration, sparkleRelease } from './macos-update-config.mjs';

if (process.platform !== 'darwin') throw new Error('Build the macOS application on a macOS runner.');
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The macOS bundle version must have three numeric components.');
const build = path.join(root, 'bin/macos');
const distribution = path.join(root, 'dist/macos');
const application = path.join(distribution, 'Local TeX Web Editor.app');
const contents = path.join(application, 'Contents');
const macos = path.join(contents, 'MacOS');
const resources = path.join(contents, 'Resources');
const updateConfiguration = macOSUpdateConfiguration(process.env.APP_UPDATE_PUBLIC_KEY || await readFile(path.join(root, 'internal/updater/public-key.txt'), 'utf8'));
await rm(build, { recursive: true, force: true });
await rm(distribution, { recursive: true, force: true });
await mkdir(build, { recursive: true });
await mkdir(macos, { recursive: true });
await mkdir(resources, { recursive: true });

async function run(program, args, options = {}) {
  const result = await execute(program, args, { cwd: root, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  return result;
}

const sparkleDirectory = path.join(build, 'sparkle');
await mkdir(sparkleDirectory, { recursive: true });
const sparkleArchive = path.join(build, `Sparkle-${sparkleRelease.version}.tar.xz`);
const sparkleResponse = await fetch(sparkleRelease.url, { signal: AbortSignal.timeout(90000) });
if (!sparkleResponse.ok || !sparkleResponse.body) throw new Error(`Could not download Sparkle (${sparkleResponse.status}).`);
const sparkleParts = [];
let sparkleBytes = 0;
for await (const chunk of sparkleResponse.body) {
  sparkleBytes += chunk.length;
  if (sparkleBytes > 32 * 1024 * 1024) throw new Error('The Sparkle archive is larger than expected.');
  sparkleParts.push(chunk);
}
const sparkleData = Buffer.concat(sparkleParts);
if (createHash('sha256').update(sparkleData).digest('hex') !== sparkleRelease.sha256) throw new Error('The Sparkle archive did not match its recorded SHA-256.');
await writeFile(sparkleArchive, sparkleData);
await run('/usr/bin/tar', ['-xf', sparkleArchive, '-C', sparkleDirectory]);
await run(process.execPath, [path.join(root, 'scripts/test-sparkle-signatures.mjs'), path.join(sparkleDirectory, 'bin/sign_update')]);
const framework = path.join(contents, 'Frameworks', 'Sparkle.framework');
await mkdir(path.dirname(framework), { recursive: true });
await run('/usr/bin/ditto', [path.join(sparkleDirectory, 'Sparkle.framework'), framework]);

for (const [goArchitecture, swiftArchitecture] of [['arm64', 'arm64'], ['amd64', 'x86_64']]) {
  await run('go', ['build', '-trimpath', `-ldflags=-s -w -X main.version=${version}`, '-o', path.join(build, `server-${goArchitecture}`), './cmd/local-tex-editor'], {
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: goArchitecture },
  });
  await run('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${swiftArchitecture}-apple-macos12.0`,
    '-F', path.dirname(framework), '-framework', 'Sparkle',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks',
    path.join(root, 'scripts/macos-launcher.swift'), path.join(root, 'scripts/macos-updater.swift'),
    '-o', path.join(build, `launcher-${goArchitecture}`)]);
}
await run('/usr/bin/lipo', ['-create', path.join(build, 'server-arm64'), path.join(build, 'server-amd64'), '-output', path.join(macos, 'local-tex-web-editor')]);
await run('/usr/bin/lipo', ['-create', path.join(build, 'launcher-arm64'), path.join(build, 'launcher-amd64'), '-output', path.join(macos, 'LocalTeXWebEditor')]);
for (const file of ['local-tex-web-editor', 'LocalTeXWebEditor']) await chmod(path.join(macos, file), 0o755);

const iconset = path.join(build, 'app-icon.iconset');
await mkdir(iconset, { recursive: true });
const largeIcon = path.join(build, 'icon-1024.png');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${await readFile(path.join(root, 'internal/branding/app-icon.svg'), 'utf8')}`);
  await page.screenshot({ path: largeIcon, omitBackground: true });
} finally { await browser.close(); }
for (const size of [16, 32, 128, 256, 512]) {
  for (const density of [1, 2]) {
    const name = `icon_${size}x${size}${density === 2 ? '@2x' : ''}.png`;
    await run('/usr/bin/sips', ['-z', String(size * density), String(size * density), largeIcon, '--out', path.join(iconset, name)]);
  }
}
await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'app-icon.icns')]);
const icon = await readFile(path.join(resources, 'app-icon.icns'));
if (icon.toString('ascii', 0, 4) !== 'icns' || icon.readUInt32BE(4) !== icon.length) throw new Error('The application icon has an invalid ICNS header.');

const info = {
  CFBundleName: 'Local TeX Web Editor', CFBundleDisplayName: 'Local TeX Web Editor',
  CFBundleIdentifier: 'io.github.kodai-utsunomiya-mdl.local-tex-editor',
  CFBundleExecutable: 'LocalTeXWebEditor', CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: version, CFBundleVersion: version,
  CFBundleIconFile: 'app-icon.icns', LSMinimumSystemVersion: '12.0',
  LSUIElement: true, NSHighResolutionCapable: true,
  NSHumanReadableCopyright: 'Local TeX Web Editor contributors. MIT License.',
  ...updateConfiguration,
};
await writeFile(path.join(contents, 'Info.plist'), JSON.stringify(info));
await run('/usr/bin/plutil', ['-convert', 'xml1', path.join(contents, 'Info.plist')]);
await writeFile(path.join(contents, 'PkgInfo'), 'APPL????');
await cp(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'));
await cp(path.join(root, 'web/dist/THIRD_PARTY_LICENSES.txt'), path.join(resources, 'THIRD_PARTY_LICENSES.txt'));
await cp(path.join(sparkleDirectory, 'LICENSE'), path.join(resources, 'SPARKLE_LICENSE.txt'));
// Ad-hoc signing makes both Mach-O slices and the bundle verifiable. A Developer
// ID signature and notarization require the maintainer's Apple credentials.
await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path.join(macos, 'local-tex-web-editor')]);
await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
for (const file of ['LocalTeXWebEditor', 'local-tex-web-editor']) await run('/usr/bin/lipo', [path.join(macos, file), '-verify_arch', 'arm64', 'x86_64']);
const actual = await run(path.join(macos, 'local-tex-web-editor'), ['--version']);
if (actual.stdout.trim() !== version) throw new Error('The packaged server reports another version.');

for (const file of ['README.md', 'README.ja.md', 'LICENSE']) await cp(path.join(root, file), path.join(distribution, file));
await cp(path.join(root, 'docs'), path.join(distribution, 'docs'), { recursive: true });
const archive = path.join(root, 'dist', `local-tex-web-editor-${version}-macos-universal.zip`);
await rm(archive, { force: true });
await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', distribution, archive]);
const unpacked = path.join(build, 'unpacked');
await run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(unpacked, 'Local TeX Web Editor.app')]);

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(filename);
    else if (entry.isFile()) total += (await stat(filename)).size;
  }
  return total;
}
const sizes = {
  version, platform: 'macos', architectures: ['arm64', 'x86_64'],
  application: path.basename(application), archive: path.basename(archive),
  appBytes: await directoryBytes(path.join(unpacked, 'Local TeX Web Editor.app')),
  zipBytes: (await stat(archive)).size,
};
const megabytes = bytes => (bytes / 1_000_000).toFixed(2);
await writeFile(path.join(root, 'dist', `local-tex-web-editor-${version}-macos-size.json`), `${JSON.stringify(sizes, null, 2)}\n`);
console.log(`Created ${sizes.archive} (${sizes.zipBytes} bytes; ${megabytes(sizes.zipBytes)} MB).`);
console.log(`Extracted application: ${sizes.appBytes} bytes; ${megabytes(sizes.appBytes)} MB.`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## macOS application size\n\nVersion ${version}. MB uses 1,000,000 bytes.\n\n| File | Bytes | MB |\n| --- | ---: | ---: |\n| ZIP download | ${sizes.zipBytes} | ${megabytes(sizes.zipBytes)} |\n| Extracted .app | ${sizes.appBytes} | ${megabytes(sizes.appBytes)} |\n`);
}
