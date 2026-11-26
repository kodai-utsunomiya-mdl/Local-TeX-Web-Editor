import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';

if (process.platform !== 'win32') throw new Error('Create the MSIX package on Windows with the Windows SDK installed.');

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
if ([...args].some(argument => argument !== '--test-identity')) throw new Error('Usage: node scripts/build-msix.mjs [--test-identity]');
const testIdentity = args.has('--test-identity');
const appVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('The application version must have three numeric parts.');
const parts = appVersion.split('.').map(Number);
// The Store requires a nonzero first component and reserves the fourth for itself.
// Adding one to the application major version gives 0.1.4 the package version 1.1.4.0.
const storeVersion = `${parts[0] + 1}.${parts[1]}.${parts[2]}.0`;
if (storeVersion.split('.').some(part => Number(part) > 65535)) throw new Error('The package version exceeds the MSIX version range.');

const storedIdentity = JSON.parse(await readFile(path.join(root, 'packaging/windows/store-identity.json'), 'utf8'));
const identity = testIdentity ? {
  name: 'LocalTeXWebEditor.Test', publisher: 'CN=LocalTeXWebEditorTest', publisherDisplayName: 'Local TeX Web Editor test',
} : {
  name: (process.env.MSIX_IDENTITY_NAME || storedIdentity.identityName)?.trim(),
  publisher: (process.env.MSIX_PUBLISHER || storedIdentity.publisher)?.trim(),
  publisherDisplayName: (process.env.MSIX_PUBLISHER_DISPLAY_NAME || storedIdentity.publisherDisplayName)?.trim(),
};
for (const [field, value] of Object.entries(identity)) {
  if (!value || /[\u0000-\u001f]/.test(value)) throw new Error(`Provide ${field} from Partner Center's Product identity page in packaging/windows/store-identity.json or through the MSIX environment variables.`);
}
if (!/^[a-z\d][a-z\d.-]{2,49}$/i.test(identity.name)) throw new Error('The package identity name must have 3–50 letters, digits, periods or hyphens.');
if (!identity.publisher.startsWith('CN=')) throw new Error('The publisher must use the complete CN= value from Partner Center.');
if (!testIdentity && identity.name === 'LocalTeXWebEditor.Test') throw new Error('Use --test-identity for a local test package. Store packages require the reserved Product identity.');

const execute = promisify(execFile);
async function run(program, arguments_, options = {}) {
  const result = await execute(program, arguments_, { cwd: root, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.log(result.stderr.trim());
  return result;
}
async function exists(filename) { try { return (await stat(filename)).isFile(); } catch { return false; } }
const sdkRoot = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
const sdkVersions = (await readdir(sdkRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^10\.\d+\.\d+\.\d+$/.test(entry.name)).map(entry => entry.name)
  .sort((first, second) => second.localeCompare(first, 'en', { numeric: true }));
let sdk;
for (const candidate of sdkVersions) {
  const directory = path.join(sdkRoot, candidate, 'x64');
  if (await exists(path.join(directory, 'makeappx.exe')) && await exists(path.join(directory, 'makepri.exe'))) { sdk = directory; break; }
}
if (!sdk) throw new Error('MakeAppx and MakePri were not found in the Windows 10/11 SDK.');

const executable = path.join(root, 'bin/local-tex-web-editor.exe');
if (!await exists(executable)) throw new Error('Build bin/local-tex-web-editor.exe before creating the MSIX package.');
const actualVersion = await run(executable, ['--version']);
if (actualVersion.stdout.trim() !== appVersion) throw new Error('The executable version does not match package.json.');
const stage = path.join(root, 'dist/msix');
const build = path.join(root, 'bin/msix');
const listing = path.join(root, 'dist/store-listing');
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'Assets'), { recursive: true });
await mkdir(build, { recursive: true });
await mkdir(listing, { recursive: true });
await copyFile(executable, path.join(stage, 'local-tex-web-editor.exe'));
await copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE.txt'));
await copyFile(path.join(root, 'web/dist/THIRD_PARTY_LICENSES.txt'), path.join(stage, 'THIRD_PARTY_LICENSES.txt'));

const svg = await readFile(path.join(root, 'internal/branding/app-icon.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  async function icon(filename, size) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: filename, omitBackground: true });
  }
  for (const [name, size] of [['StoreLogo', 50], ['Square44x44Logo', 44], ['Square150x150Logo', 150]]) {
    await icon(path.join(stage, 'Assets', `${name}.png`), size);
    for (const scale of [125, 150, 200, 400]) await icon(path.join(stage, 'Assets', `${name}.scale-${scale}.png`), Math.round(size * scale / 100));
  }
  for (const size of [16, 24, 32, 48, 256]) await icon(path.join(stage, 'Assets', `Square44x44Logo.targetsize-${size}_altform-unplated.png`), size);
  await icon(path.join(listing, 'store-logo-300.png'), 300);
} finally { await browser.close(); }
for (const filename of ['editor-tex-dark.png', 'editor-markdown-light.png', 'editor-tex-management.png', 'tex-setup-home.png', 'tex-setup-plan.png', 'tex-setup-location.png', 'tex-setup-progress.png', 'tex-setup-complete.png']) {
  const captured = path.join(root, 'test-results/msix', filename);
  const source = await exists(captured) ? captured : path.join(root, 'docs/screenshots', filename);
  if (filename !== 'editor-tex-dark.png' && filename !== 'editor-markdown-light.png' && !await exists(source)) continue;
  await copyFile(source, path.join(listing, filename));
}
for (const filename of ['microsoft-store-listing.md', 'privacy.md', 'privacy.ja.md']) {
  const source = path.join(root, 'docs', filename);
  if (await exists(source)) await copyFile(source, path.join(listing, filename));
}
await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
Compress-Archive -LiteralPath @('packaging/windows/review-sample/main.tex', 'packaging/windows/review-sample/notes.md') -DestinationPath 'dist/store-listing/store-review-sample.zip' -Force
`]);

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="desktop uap uap10 rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${storeVersion}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Local TeX Web Editor</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>Edit TeX and Markdown in your browser with your local TeX Live installation.</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-US" />
    <Resource Language="ja-JP" />
  </Resources>
  <Applications>
    <Application Id="App" Executable="local-tex-web-editor.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="Local TeX Web Editor" Description="Edit TeX and Markdown with a local TeX installation."
                          Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" BackgroundColor="transparent" />
      <Extensions>
        <desktop:Extension Category="windows.startupTask" Executable="local-tex-web-editor.exe" EntryPoint="Windows.FullTrustApplication" uap10:Parameters="--background">
          <desktop:StartupTask TaskId="LocalTeXWebEditorBackground" Enabled="false" DisplayName="Local TeX Web Editor" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
await writeFile(path.join(stage, 'AppxManifest.xml'), manifest);
const priConfig = path.join(build, 'priconfig.xml');
await run(path.join(sdk, 'makepri.exe'), ['createconfig', '/cf', priConfig, '/dq', 'en-US', '/o']);
await run(path.join(sdk, 'makepri.exe'), ['new', '/pr', stage, '/cf', priConfig, '/of', path.join(stage, 'resources.pri'), '/o']);
const archive = path.join(root, 'dist', `local-tex-web-editor-${appVersion}-windows-x64.msix`);
await run(path.join(sdk, 'makeappx.exe'), ['pack', '/d', stage, '/p', archive, '/o']);
const buffer = await readFile(archive);
const result = { appVersion, storeVersion, identity, testIdentity, file: path.basename(archive), bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
await writeFile(path.join(root, 'dist/msix-package.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Windows MSIX\n\nApplication: ${appVersion}. Package: ${storeVersion}.\n\n${testIdentity ? 'This package uses the CI test identity.' : 'This package uses the Product identity configured for Microsoft Store.'}\n\nFile: \`${result.file}\` (${result.bytes} bytes).\n\nSHA-256: \`${result.sha256}\`\n`);
