import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PRODUCT_ID, StoreSubmissionError, buildSubmissionPayload, compareVersions,
  parseArguments, prepareSubmission, submitPrepared } from '../scripts/submit-microsoft-store.mjs';

const identity = { name: 'KodaiUtsunomiya.LocalTeXWebEditor',
  publisher: 'CN=62DF8CD3-B689-471E-B1B0-C75944260F73', publisherDisplayName: 'Kodai Utsunomiya' };
const environment = {
  PARTNER_CENTER_TENANT_ID: '10000000-0000-0000-0000-000000000001',
  PARTNER_CENTER_CLIENT_ID: '20000000-0000-0000-0000-000000000002',
  PARTNER_CENTER_CLIENT_SECRET: 'secret-value-that-must-never-appear-in-an-artifact',
};
const accessToken = 'access-token-that-must-never-appear-in-an-artifact';
const uploadUrl = 'https://productingestionbin1.blob.core.windows.net/ingestion/package?sig=private-upload-signature';

function python(script, input) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    input: JSON.stringify(input), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.store-submission-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'package');
  const listingDir = path.join(root, 'listing');
  const output = path.join(root, 'output');
  await fs.mkdir(packageDir);
  await fs.mkdir(listingDir);
  const info = { appVersion: '0.1.15', storeVersion: '1.1.15.0', identity, testIdentity: false,
    file: 'local-tex-web-editor-0.1.15-windows-x64.msix' };
  python(`import json, pathlib, struct, sys, zlib, zipfile
data = json.load(sys.stdin)
manifest = '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="' + data['name'] + '" Publisher="' + data['publisher'] + '" Version="' + data['version'] + '" ProcessorArchitecture="x64" /></Package>'
with zipfile.ZipFile(data['package'], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('AppxManifest.xml', manifest)
    archive.writestr('app.exe', b'test fixture')
def png(file, width, height):
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)
    raw = (b'\\x00' + b'\\x00\\x80\\xff' * width) * height
    content = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    content += chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    pathlib.Path(file).write_bytes(content)
png(data['screenshot'], 1600, 1000)
png(data['icon'], 300, 300)`, {
    package: path.join(packageDir, info.file), name: changes.manifestName ?? identity.name,
    publisher: identity.publisher, version: changes.manifestVersion ?? info.storeVersion,
    screenshot: path.join(listingDir, 'editor.png'), icon: path.join(listingDir, 'store-logo-300.png'),
  });
  const packageBytes = await fs.readFile(path.join(packageDir, info.file));
  info.bytes = packageBytes.length;
  info.sha256 = createHash('sha256').update(packageBytes).digest('hex');
  await fs.writeFile(path.join(packageDir, 'msix-package.json'), JSON.stringify(info));
  await fs.writeFile(path.join(listingDir, 'screenshot-source.json'), JSON.stringify({ source: 'installed-msix', files: ['editor.png'] }));
  const listings = Object.fromEntries(['en-us', 'ja-jp'].map(language => [language, {
    description: `${language} description`, features: ['Edit TeX and Markdown'], releaseNotes: 'Version 0.1.15',
    screenshots: [{ fileName: 'editor.png', description: 'Editing a project' }], icon: { fileName: 'store-logo-300.png' },
  }]));
  const metadata = { productId: PRODUCT_ID, appVersion: info.appVersion, targetPublishMode: 'Immediate',
    notesForCertification: 'Open the sample project and compile it.', listings };
  const metadataFile = path.join(root, 'metadata.json');
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return { root, info, metadata, options: { packageDir, listingDir, metadata: metadataFile, output } };
}

function publishedSubmission() {
  return {
    id: '100', status: 'Published', applicationCategory: 'Productivity',
    pricing: { priceId: 'Free', marketSpecificPricings: { JP: 'Free' }, trialPeriod: 'NoFreeTrial' },
    targetPublishMode: 'Manual', visibility: 'Public',
    marketSpecificAvailabilities: { JP: true, US: true }, ageRatings: { ESRB: 'Everyone' },
    packageDeliveryOptions: { isMandatoryUpdate: false },
    listings: Object.fromEntries(['en-us', 'ja-jp', 'fr-fr'].map(language => [language, {
      baseListing: { title: 'Local TeX Web Editor', description: `${language} old description`,
        images: [
          { id: '201', fileName: 'old.png', imageType: 'Screenshot', fileStatus: 'Uploaded' },
          { id: '202', fileName: 'old-icon.png', imageType: 'Icon', fileStatus: 'Uploaded' },
          { id: '203', fileName: 'wide.png', imageType: 'StoreLogo9x16', fileStatus: 'Uploaded' },
        ] }, platformOverrides: { Windows81: { title: 'Legacy title' } },
    }])),
    applicationPackages: [
      { id: '501', fileName: 'old.msix', fileStatus: 'Uploaded', architecture: 'X64', version: '1.1.14.0' },
      { id: '502', fileName: 'arm.msix', fileStatus: 'Uploaded', architecture: 'ARM64', version: '1.1.14.0' },
    ],
  };
}

function mockStore({ pending = null, current = publishedSubmission(), status = 'PreProcessing',
  failUpload = false, invalidUpload = false, networkFailure = false } = {}) {
  const requests = [];
  const appPath = `/v1.0/my/applications/${PRODUCT_ID}`;
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    requests.push({ url, ...options });
    assert.equal(options.redirect, 'error');
    if (networkFailure) throw new Error(`Connection to ${uploadUrl} failed: ${environment.PARTNER_CENTER_CLIENT_SECRET} ${accessToken}`);
    const answer = (value, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'login.microsoftonline.com') {
      assert.equal(options.body.get('resource'), 'https://manage.devcenter.microsoft.com');
      assert.equal(options.body.get('client_secret'), environment.PARTNER_CENTER_CLIENT_SECRET);
      return answer({ access_token: accessToken });
    }
    if (url.hostname.endsWith('.blob.core.windows.net')) {
      assert.equal(options.method, 'PUT');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['x-ms-blob-type'], 'BlockBlob');
      assert.equal(options.body.subarray(0, 2).toString(), 'PK');
      return new Response(failUpload ? `${uploadUrl} ${accessToken}` : '', { status: failUpload ? 403 : 201 });
    }
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
    if (url.pathname === appPath && options.method === 'GET') return answer({ id: PRODUCT_ID,
      packageIdentityName: identity.name, publisherName: identity.publisher,
      lastPublishedApplicationSubmission: { id: '100' }, pendingApplicationSubmission: pending ? { id: pending } : null });
    if (url.pathname === `${appPath}/submissions/100`) return answer(current);
    if (pending && url.pathname === `${appPath}/submissions/${pending}/status`) return answer({ status: 'Certification' });
    if (url.pathname === `${appPath}/submissions` && options.method === 'POST') return answer({ ...structuredClone(current),
      id: '101', status: 'PendingCommit', fileUploadUrl: invalidUpload ? 'https://example.com/upload?sig=bad' : uploadUrl });
    if (url.pathname === `${appPath}/submissions/101` && options.method === 'PUT') return answer(JSON.parse(options.body));
    if (url.pathname === `${appPath}/submissions/101/commit`) return answer({ status: 'CommitStarted' });
    if (url.pathname === `${appPath}/submissions/101/status`) return answer({ status });
    throw new Error(`Unexpected request: ${options.method} ${url.pathname}`);
  };
  return { fetchImpl, requests };
}

const submitOptions = extra => ({ env: environment, sleep: async () => {}, pollAttempts: 2, ...extra });

test('preparation verifies an MSIX and builds a ZIP with only the package, screenshots and icon', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  assert.equal(prepared.plan.package.sha256, sample.info.sha256);
  assert.equal(prepared.plan.listings['ja-jp'].screenshots[0].imageType, 'Screenshot');
  assert.equal(prepared.plan.listings['en-us'].icon.imageType, 'Icon');
  const names = JSON.parse(python(`import json, sys, zipfile
with zipfile.ZipFile(json.load(sys.stdin)['path']) as archive:
    assert archive.testzip() is None
    print(json.dumps(archive.namelist()))`, { path: prepared.archivePath }));
  assert.deepEqual(names, [sample.info.file, 'images/editor.png', 'images/store-logo-300.png']);
  assert.deepEqual((await fs.readdir(sample.options.output)).sort(), ['plan.json', 'submission.zip']);
});

test('a package changed after its test record was written is rejected', async t => {
  const sample = await fixture(t);
  await fs.appendFile(path.join(sample.options.packageDir, sample.info.file), 'changed');
  await assert.rejects(prepareSubmission(sample.options), { code: 'package-mismatch' });
});

test('the MSIX manifest must match the product identity and version', async t => {
  const sample = await fixture(t, { manifestName: 'Unrelated.Product' });
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-package-manifest' });
});

test('a test identity cannot be prepared for submission', async t => {
  const sample = await fixture(t);
  await fs.writeFile(path.join(sample.options.packageDir, 'msix-package.json'), JSON.stringify({ ...sample.info, testIdentity: true }));
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-package-identity' });
});

test('listing metadata cannot refer to a different product or version', async t => {
  const sample = await fixture(t);
  await fs.writeFile(sample.options.metadata, JSON.stringify({ ...sample.metadata, productId: 'OTHERPRODUCT' }));
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-product' });
  await fs.writeFile(sample.options.metadata, JSON.stringify({ ...sample.metadata, appVersion: '0.1.14' }));
  await assert.rejects(prepareSubmission(sample.options), { code: 'version-mismatch' });
});

test('screenshot paths and images from an untested source are rejected', async t => {
  const sample = await fixture(t);
  sample.metadata.listings['en-us'].screenshots[0].fileName = '../outside.png';
  await fs.writeFile(sample.options.metadata, JSON.stringify(sample.metadata));
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-metadata' });
  sample.metadata.listings['en-us'].screenshots[0].fileName = 'editor.png';
  await fs.writeFile(sample.options.metadata, JSON.stringify(sample.metadata));
  await fs.writeFile(path.join(sample.options.listingDir, 'screenshot-source.json'), JSON.stringify({ source: 'repository', files: ['editor.png'] }));
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-screenshot-source' });
});

test('a non-PNG screenshot and an icon with incorrect dimensions are rejected', async t => {
  const sample = await fixture(t);
  const screenshot = await fs.readFile(path.join(sample.options.listingDir, 'editor.png'));
  await fs.writeFile(path.join(sample.options.listingDir, 'editor.png'), '<html>error</html>');
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-screenshot' });
  await fs.writeFile(path.join(sample.options.listingDir, 'editor.png'), screenshot);
  await fs.writeFile(path.join(sample.options.listingDir, 'store-logo-300.png'), screenshot);
  await assert.rejects(prepareSubmission(sample.options), { code: 'invalid-screenshot' });
});

test('submission updates desktop screenshots and icons while carrying forward the other Store settings', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const draft = { ...publishedSubmission(), status: 'PendingCommit', fileUploadUrl: uploadUrl };
  const before = structuredClone(draft);
  const payload = buildSubmissionPayload(draft, prepared);
  assert.deepEqual(draft, before);
  for (const key of ['pricing', 'marketSpecificAvailabilities', 'ageRatings', 'packageDeliveryOptions', 'visibility']) {
    assert.deepEqual(payload[key], draft[key]);
  }
  assert.deepEqual(payload.listings['fr-fr'], draft.listings['fr-fr']);
  assert.deepEqual(payload.listings['en-us'].platformOverrides, draft.listings['en-us'].platformOverrides);
  assert.equal(payload.listings['en-us'].baseListing.title, 'Local TeX Web Editor');
  const images = payload.listings['en-us'].baseListing.images;
  assert.equal(images.find(image => image.id === '201').fileStatus, 'PendingDelete');
  assert.equal(images.find(image => image.id === '202').fileStatus, 'PendingDelete');
  assert.equal(images.find(image => image.id === '203').fileStatus, 'Uploaded');
  assert.equal(images.find(image => image.fileName === 'images/editor.png').fileStatus, 'PendingUpload');
  assert.equal(payload.applicationPackages.find(item => item.id === '501').fileStatus, 'PendingDelete');
  assert.equal(payload.applicationPackages.find(item => item.id === '502').fileStatus, 'Uploaded');
  assert.equal(payload.targetPublishMode, 'Immediate');
  assert.equal(payload.fileUploadUrl, undefined);
});

test('a successful submission sends the package and images before committing and writes a public result', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore();
  const result = await submitPrepared(prepared, submitOptions(mock));
  assert.equal(result.outcome, 'submitted');
  assert.equal(result.status, 'PreProcessing');
  assert.equal(result.submissionId, '101');
  assert.equal(result.published, false);
  const uploadIndex = mock.requests.findIndex(item => item.url.hostname.endsWith('.blob.core.windows.net'));
  const commitIndex = mock.requests.findIndex(item => item.url.pathname.endsWith('/commit'));
  assert.ok(uploadIndex >= 0 && commitIndex > uploadIndex);
  const resultText = await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8');
  for (const secret of [environment.PARTNER_CENTER_CLIENT_SECRET, accessToken, 'private-upload-signature', 'fileUploadUrl']) {
    assert.ok(!resultText.includes(secret));
    assert.ok(!JSON.stringify(prepared.plan).includes(secret));
  }
});

test('an existing draft or review in progress stops the submission before any Store mutation', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore({ pending: '999' });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'pending-submission' });
  const storeWrites = mock.requests.filter(item => item.url.hostname === 'manage.devcenter.microsoft.com' && item.method !== 'GET');
  assert.equal(storeWrites.length, 0);
  const result = JSON.parse(await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8'));
  assert.equal(result.submissionId, '999');
  assert.equal(result.status, 'Certification');
});

test('the already published version is reported without creating another submission', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const current = publishedSubmission();
  current.applicationPackages[0].version = sample.info.storeVersion;
  const mock = mockStore({ current });
  const result = await submitPrepared(prepared, submitOptions(mock));
  assert.equal(result.outcome, 'already-published');
  assert.equal(result.published, true);
  assert.equal(mock.requests.filter(item => item.url.pathname.endsWith('/submissions')).length, 0);
});

test('a version older than the published x64 package cannot be submitted', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const current = publishedSubmission();
  current.applicationPackages[0].version = '1.1.16.0';
  const mock = mockStore({ current });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'older-package' });
  assert.equal(mock.requests.filter(item => item.url.pathname.endsWith('/submissions')).length, 0);
});

test('an upload failure leaves the new draft uncommitted and reports its ID', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore({ failUpload: true });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'http-error' });
  assert.equal(mock.requests.some(item => item.url.pathname.endsWith('/commit')), false);
  const resultText = await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8');
  const result = JSON.parse(resultText);
  assert.equal(result.submissionId, '101');
  assert.equal(result.phase, 'uploading-files');
  assert.equal(result.committed, false);
  assert.ok(!resultText.includes('private-upload-signature'));
  assert.ok(!resultText.includes(accessToken));
});

test('an upload URL outside Azure Blob storage is rejected before sending the files', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore({ invalidUpload: true });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'invalid-upload-url' });
  assert.equal(mock.requests.some(item => item.url.hostname === 'example.com'), false);
  assert.equal(mock.requests.some(item => item.url.pathname.endsWith('/commit')), false);
});

test('authentication and connection errors cannot leak credentials or upload URLs into the result', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore({ networkFailure: true });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'network-error' });
  const output = await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8');
  for (const secret of [environment.PARTNER_CENTER_CLIENT_SECRET, accessToken, 'private-upload-signature']) assert.ok(!output.includes(secret));
});

test('authentication errors report allowed OAuth names and AADSTS numbers without response text or credentials', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  for (const [oauthError, aadstsCode] of [['invalid_client', 7000215], ['invalid_resource', 500011]]) {
    const response = {
      error: oauthError, error_codes: [aadstsCode],
      error_description: `AADSTS${aadstsCode}: ${environment.PARTNER_CENTER_CLIENT_SECRET} ${accessToken} ${uploadUrl}`,
      trace_id: 'trace-value-that-must-not-appear', access_token: accessToken,
    };
    const fetchImpl = async () => new Response(JSON.stringify(response), { status: 400 });
    await assert.rejects(submitPrepared(prepared, submitOptions({ fetchImpl })), error => {
      assert.equal(error.code, 'http-error');
      assert.ok(error.message.includes(`OAuth error: ${oauthError}`));
      assert.ok(error.message.includes(`AADSTS${aadstsCode}`));
      if (aadstsCode === 7000215) assert.match(error.message, /Set PARTNER_CENTER_CLIENT_SECRET to the client secret value/);
      return true;
    });
    const output = await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8');
    const result = JSON.parse(output);
    assert.equal(result.phase, 'authentication');
    assert.equal(result.error.oauthError, oauthError);
    assert.deepEqual(result.error.aadstsCodes, [aadstsCode]);
    for (const secret of [environment.PARTNER_CENTER_CLIENT_SECRET, accessToken, 'private-upload-signature',
      'trace-value-that-must-not-appear', 'error_description']) assert.ok(!output.includes(secret));
  }
});

test('authentication errors ignore unexpected OAuth strings, nonnumeric codes and malformed JSON', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const responses = [
    JSON.stringify({ error: environment.PARTNER_CENTER_CLIENT_SECRET,
      error_codes: [accessToken, '7000215', { code: 7000222 }, null, -1, 1.5, 1000000000, 700016, 700016],
      error_description: uploadUrl }),
    `<html>${environment.PARTNER_CENTER_CLIENT_SECRET}</html>`,
  ];
  for (let index = 0; index < responses.length; index += 1) {
    const fetchImpl = async () => new Response(responses[index], { status: 400 });
    await assert.rejects(submitPrepared(prepared, submitOptions({ fetchImpl })), { code: 'http-error' });
    const output = await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8');
    const result = JSON.parse(output);
    assert.equal(result.error.oauthError, undefined);
    assert.deepEqual(result.error.aadstsCodes, index === 0 ? [700016] : undefined);
    for (const secret of [environment.PARTNER_CENTER_CLIENT_SECRET, accessToken, 'private-upload-signature']) assert.ok(!output.includes(secret));
  }
});

test('missing credentials stop before any network request', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  let calls = 0;
  await assert.rejects(submitPrepared(prepared, { env: {}, fetchImpl: async () => { calls += 1; } }),
    { code: 'missing-credentials' });
  assert.equal(calls, 0);
});

test('a failed commit status fails the command and records the submission for follow-up', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  const mock = mockStore({ status: 'CommitFailed' });
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'submission-failed' });
  const result = JSON.parse(await fs.readFile(path.join(prepared.output, 'result.json'), 'utf8'));
  assert.equal(result.status, 'CommitFailed');
  assert.equal(result.committed, true);
  assert.equal(result.published, false);
});

test('a ZIP changed after preparation is never uploaded or committed', async t => {
  const sample = await fixture(t);
  const prepared = await prepareSubmission(sample.options);
  await fs.appendFile(prepared.archivePath, 'modified');
  const mock = mockStore();
  await assert.rejects(submitPrepared(prepared, submitOptions(mock)), { code: 'archive-mismatch' });
  assert.equal(mock.requests.some(item => item.url.hostname.endsWith('.blob.core.windows.net')), false);
  assert.equal(mock.requests.some(item => item.url.pathname.endsWith('/commit')), false);
});

test('the command requires an explicit mode and numeric Store versions use numeric ordering', () => {
  assert.throws(() => parseArguments(['--package-dir', 'one']), StoreSubmissionError);
  assert.throws(() => parseArguments(['--prepare', '--submit']), StoreSubmissionError);
  assert.throws(() => parseArguments(['--submit', '--client-secret', 'value']), StoreSubmissionError);
  assert.equal(compareVersions('1.1.9.0', '1.1.15.0'), -1);
  assert.equal(compareVersions('2.0.0.0', '1.100.999.0'), 1);
  assert.throws(() => compareVersions('1.1.65536.0', '1.1.0.0'), StoreSubmissionError);
});
