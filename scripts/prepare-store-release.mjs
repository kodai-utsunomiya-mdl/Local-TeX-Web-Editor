import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productId = '9P6QF32N19HG';
const workflowPaths = {
  store: '.github/workflows/microsoft-store.yml',
  build: '.github/workflows/windows.yml',
};
const screenshotFiles = [
  'editor-tex-dark.png', 'editor-markdown-light.png', 'editor-tex-management.png',
  'tex-setup-home.png', 'tex-setup-plan.png', 'tex-setup-location.png',
  'tex-setup-progress.png', 'tex-setup-complete.png',
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { maxBuffer: 128 * 1024 * 1024, ...options });
}

function api(path) {
  return JSON.parse(gh(['api', path], { encoding: 'utf8' }));
}

function optionalApi(path) {
  try {
    return api(path);
  } catch (error) {
    if (String(error.stderr).includes('HTTP 404')) return null;
    throw error;
  }
}

export function assertSuccessfulMainRun(run, repository, kind, expectedSha) {
  assert.equal(run.path, workflowPaths[kind], `Unexpected ${kind} workflow.`);
  assert.equal(run.head_branch, 'main', 'Only builds from main can be submitted.');
  assert.equal(run.event, 'push', 'The package must come from a push to main.');
  assert.equal(run.status, 'completed', 'The workflow is still running.');
  assert.equal(run.conclusion, 'success', 'The workflow must succeed.');
  assert.equal(run.head_repository?.full_name, repository, 'The workflow belongs to another repository.');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  if (expectedSha) assert.equal(run.head_sha, expectedSha, 'The test runs use different commits.');
}

export function lastCompletedRun(runs) {
  return [...runs].sort((a, b) => {
    const elapsed = Date.parse(a.updated_at) - Date.parse(b.updated_at);
    assert.ok(Number.isFinite(elapsed), 'The completion times are missing.');
    return elapsed || Number(a.id) - Number(b.id);
  }).at(-1);
}

function section(document, heading, depth) {
  const prefix = '#'.repeat(depth);
  const start = document.indexOf(`${prefix} ${heading}\n`);
  assert.ok(start >= 0, `Missing listing section: ${heading}`);
  const rest = document.slice(start + prefix.length + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${depth}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

function textBlock(document, heading) {
  const match = section(document, heading, 3).match(/```text\n([\s\S]*?)\n```/);
  assert.ok(match, `Missing text block: ${heading}`);
  return match[1].trim();
}

export function createStoreMetadata(document, releaseBody, appVersion, commit, repository) {
  document = document.replaceAll('\r\n', '\n');
  const english = section(document, 'English listing', 2);
  const japanese = section(document, '日本語の掲載内容', 2);
  const imageSection = section(document, 'Images and captions', 2);
  const captions = new Map([...imageSection.matchAll(/^\| `([^`]+\.png)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => [match[1], { 'en-us': match[2].trim(), 'ja-jp': match[3].trim() }]));
  for (const file of screenshotFiles) assert.ok(captions.has(file), `Missing screenshot caption: ${file}`);
  const notes = {
    'en-us': textBlock(english, "What's new"),
    'ja-jp': textBlock(japanese, 'このバージョンの最新情報'),
  };
  assert.equal(notes['en-us'].split('\n')[0], `Version ${appVersion}`, 'The English Store release notes belong to another version.');
  assert.equal(notes['ja-jp'].split('\n')[0], `バージョン ${appVersion}`, 'The Japanese Store release notes belong to another version.');
  const listing = (language, content, descriptionHeading, featuresHeading) => ({
    description: textBlock(content, descriptionHeading),
    features: textBlock(content, featuresHeading).split('\n').map((line) => line.trim()).filter(Boolean),
    releaseNotes: notes[language],
    icon: { fileName: 'store-logo-300.png' },
    screenshots: screenshotFiles.map((fileName) => ({ fileName, description: captions.get(fileName)[language] })),
  });
  return {
    productId,
    appVersion,
    targetPublishMode: 'Immediate',
    notesForCertification: `Local TeX Web Editor ${appVersion} is a free Windows desktop app with a local browser interface. No account is required. The package and its screenshots come from the successful installed-MSIX tests. Review instructions and the explanation for runFullTrust: https://github.com/${repository}/blob/${commit}/docs/microsoft-store-listing.md#reviewer-notes\n\nSample project: https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/downloads/store-review-sample.zip`,
    listings: {
      'en-us': listing('en-us', english, 'Description', 'Product features'),
      'ja-jp': listing('ja-jp', japanese, '説明', '製品の機能'),
    },
  };
}

function extractArchive(archive, directory) {
  mkdirSync(directory, { recursive: true });
  const script = [
    'import pathlib, stat, sys, zipfile',
    'destination = pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    assert archive.testzip() is None, "Invalid artifact ZIP."',
    '    assert sum(info.file_size for info in archive.infolist()) <= 256 * 1024 * 1024, "Artifact is too large."',
    '    for info in archive.infolist():',
    '        path = pathlib.PurePosixPath(info.filename)',
    '        assert not path.is_absolute() and ".." not in path.parts and chr(92) not in info.filename, "Invalid artifact path."',
    '        assert not stat.S_ISLNK(info.external_attr >> 16), "Artifact links are not supported."',
    '        target = (destination / info.filename).resolve()',
    '        assert target.is_relative_to(destination), "Artifact path leaves its directory."',
    '    archive.extractall(destination)',
  ].join('\n');
  execFileSync('python', ['-c', script, archive, directory], { stdio: 'inherit' });
}

function artifactFor(artifacts, name, sha) {
  const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
  assert.equal(matches.length, 1, `Expected one unexpired ${name} artifact.`);
  const artifact = matches[0];
  assert.equal(artifact.workflow_run?.head_sha, sha, 'The artifact comes from another commit.');
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/, 'The artifact has no SHA-256 record.');
  return artifact;
}

function downloadArtifact(repository, artifact, path) {
  const bytes = gh(['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`]);
  assert.equal(`sha256:${digest(bytes)}`, artifact.digest, `The ${artifact.name} archive has changed.`);
  writeFileSync(path, bytes);
}

function resolveTag(repository, tag) {
  let object = api(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
    object = api(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  assert.equal(object.type, 'commit', 'The release tag must resolve to a commit.');
  return object.sha;
}

function publishAsset(tag, path, label, assets) {
  const name = path.split('/').at(-1);
  const expectedDigest = `sha256:${digest(readFileSync(path))}`;
  const existing = assets.find((asset) => asset.name === name);
  if (existing) {
    assert.equal(existing.digest, expectedDigest, `The existing release asset ${name} has different content.`);
    return;
  }
  gh(['release', 'upload', tag, `${path}#${label}`], { stdio: 'inherit' });
}

function writeOutput(output, values) {
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'release.json'), `${JSON.stringify(values, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${values.ready}\n`);
    if (values.ready) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${values.tag}\nstore_run_id=${values.storeRunId}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, values.ready
      ? `## Store files for ${values.tag}\n\n- Source: ${values.commit}\n- [Successful Windows / Mac tests](${values.buildRunUrl})\n- [Successful installed-MSIX tests](${values.storeRunUrl})\n- [Release](${values.releaseUrl})\n- MSIX SHA-256: \`${values.packageSha256}\`\n\n`
      : `## Store submission preparation\n\n${values.reason}\n`);
  }
  console.log(values.ready ? `Ready: ${values.tag}, Store run ${values.storeRunId}.` : values.reason);
}

export function findReleaseRuns(options, { readApi = api, readTag = resolveTag } = {}) {
  const repository = options.repository;
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const triggered = options.event?.workflow_run;
  const requestedId = options.storeRunId;
  assert.ok(!(options.latest && requestedId), 'Choose the latest release or a Store run ID.');
  if (!requestedId && !triggered && !options.latest) throw new Error('A Store run ID, workflow_run event, or --latest is required.');

  let storeRun = requestedId ? readApi(`repos/${repository}/actions/runs/${requestedId}`) : null;
  let headSha = storeRun?.head_sha ?? triggered?.head_sha;
  if (options.latest) {
    const release = readApi(`repos/${repository}/releases/latest`);
    assert.ok(release && !release.draft && !release.prerelease && release.published_at,
      'The latest release must be public and stable.');
    assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/, 'The latest release must use an app version tag.');
    headSha = readTag(repository, release.tag_name);
  }
  assert.match(headSha, /^[a-f0-9]{40}$/);
  const completed = (kind) => readApi(`repos/${repository}/actions/workflows/${workflowPaths[kind].split('/').at(-1)}/runs?head_sha=${headSha}&branch=main&event=push&status=success&per_page=100`)
    .workflow_runs.filter((run) => run.head_sha === headSha && run.head_branch === 'main' && run.event === 'push' && run.conclusion === 'success');
  if (!storeRun) storeRun = lastCompletedRun(completed('store'));
  const buildRun = lastCompletedRun(completed('build'));
  if (!storeRun || !buildRun) return { ready: false, reason: 'Waiting for successful app and Store-package workflows for the same main commit.' };
  assertSuccessfulMainRun(storeRun, repository, 'store', headSha);
  assertSuccessfulMainRun(buildRun, repository, 'build', headSha);
  if (!requestedId && !options.latest && Number(triggered.id) !== Number(lastCompletedRun([storeRun, buildRun]).id)) {
    return { ready: false, reason: 'The workflow that completed later prepares this release.' };
  }
  return { ready: true, headSha, storeRun, buildRun };
}

export function prepareRelease(options) {
  const repository = options.repository;
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true });
  const incomplete = (reason) => {
    writeOutput(output, { ready: false, reason });
    if (options.storeRunId) throw new Error(reason);
    return { ready: false, reason };
  };
  const runs = findReleaseRuns(options);
  if (!runs.ready) return incomplete(runs.reason);
  const { headSha, storeRun, buildRun } = runs;

  const artifacts = api(`repos/${repository}/actions/runs/${storeRun.id}/artifacts?per_page=100`).artifacts;
  const submission = artifactFor(artifacts, 'microsoft-store-submission', headSha);
  const listing = artifactFor(artifacts, 'microsoft-store-listing', headSha);
  const packageDirectory = resolve(output, 'package');
  const listingDirectory = resolve(output, 'listing');
  const packageArchive = resolve(output, 'microsoft-store-submission.zip');
  const listingArchive = resolve(output, 'microsoft-store-listing.zip');
  downloadArtifact(repository, submission, packageArchive);
  downloadArtifact(repository, listing, listingArchive);
  extractArchive(packageArchive, packageDirectory);
  extractArchive(listingArchive, listingDirectory);

  const info = JSON.parse(readFileSync(resolve(packageDirectory, 'msix-package.json'), 'utf8'));
  assert.match(info.appVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(info.testIdentity, false, 'A Store product package is required.');
  assert.equal(info.file, `local-tex-web-editor-${info.appVersion}-windows-x64.msix`);
  const identity = JSON.parse(readFileSync(resolve(repositoryRoot, 'packaging/windows/store-identity.json'), 'utf8'));
  assert.deepEqual(info.identity, { name: identity.identityName, publisher: identity.publisher, publisherDisplayName: identity.publisherDisplayName });
  const packagePath = resolve(packageDirectory, info.file);
  const bytes = readFileSync(packagePath);
  assert.equal(bytes.length, info.bytes);
  assert.equal(digest(bytes), info.sha256);
  const source = JSON.parse(readFileSync(resolve(listingDirectory, 'screenshot-source.json'), 'utf8'));
  assert.equal(source.source, 'installed-msix', 'Screenshots must come from the installed-MSIX tests.');

  const tag = `v${info.appVersion}`;
  const release = optionalApi(`repos/${repository}/releases/tags/${tag}`);
  if (!release || release.draft || release.prerelease || !release.published_at) {
    return incomplete(`Waiting for the public release ${tag}.`);
  }
  if (resolveTag(repository, tag) !== headSha) return incomplete(`${tag} belongs to another commit; no Store submission is prepared.`);
  const latest = api(`repos/${repository}/releases/latest`);
  if (latest.id !== release.id) return incomplete(`${tag} is no longer the latest stable release.`);

  const metadata = createStoreMetadata(readFileSync(resolve(listingDirectory, 'microsoft-store-listing.md'), 'utf8'), release.body, info.appVersion, headSha, repository);
  writeFileSync(resolve(output, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  if (options.publishDownloads) {
    publishAsset(tag, packagePath, 'Microsoft Store submission package', release.assets);
    publishAsset(tag, listingArchive, 'Microsoft Store screenshots and listing text', release.assets);
  }
  const result = {
    ready: true, productId, tag, commit: headSha, appVersion: info.appVersion,
    storeVersion: info.storeVersion, packageSha256: info.sha256,
    packageArtifactId: submission.id, listingArtifactId: listing.id,
    packageArtifactSha256: submission.digest, listingArtifactSha256: listing.digest,
    storeRunId: storeRun.id, buildRunId: buildRun.id,
    storeRunUrl: storeRun.html_url, buildRunUrl: buildRun.html_url, releaseUrl: release.html_url,
  };
  writeOutput(output, result);
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const options = { repository: process.env.GITHUB_REPOSITORY, output: 'store-submission-files' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--publish-downloads') options.publishDownloads = true;
    else if (arg === '--latest') options.latest = true;
    else if (['--repository', '--output', '--store-run'].includes(arg)) {
      const value = args[++index];
      assert.ok(value, `Missing value for ${arg}.`);
      options[{ '--repository': 'repository', '--output': 'output', '--store-run': 'storeRunId' }[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.storeRunId) assert.match(options.storeRunId, /^\d+$/);
  if (process.env.GITHUB_EVENT_PATH) options.event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  prepareRelease(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
