import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// MSIX submissions: https://learn.microsoft.com/windows/uwp/monetize/manage-app-submissions
export const PRODUCT_ID = '9P6QF32N19HG';
const IDENTITY_NAME = 'KodaiUtsunomiya.LocalTeXWebEditor';
const PUBLISHER = 'CN=62DF8CD3-B689-471E-B1B0-C75944260F73';
const API_ROOT = 'https://manage.devcenter.microsoft.com/v1.0/my';
const LANGUAGES = ['en-us', 'ja-jp'];
const STATUS_NAMES = new Set(['None', 'Canceled', 'PendingCommit', 'CommitStarted', 'CommitFailed',
  'PendingPublication', 'Publishing', 'Published', 'PublishFailed', 'PreProcessing',
  'PreProcessingFailed', 'Certification', 'CertificationFailed', 'Release', 'ReleaseFailed']);
const FAILED_STATUSES = new Set(['Canceled', 'CommitFailed', 'PublishFailed', 'PreProcessingFailed',
  'CertificationFailed', 'ReleaseFailed']);
const OAUTH_ERROR_NAMES = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'invalid_resource',
  'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied',
  'interaction_required', 'temporarily_unavailable', 'server_error']);
// https://learn.microsoft.com/entra/identity-platform/reference-error-codes
const AUTH_ERROR_HELP = new Map([
  [7000215, 'The client secret was rejected. Set PARTNER_CENTER_CLIENT_SECRET to the client secret value.'],
  [7000222, 'The client secret has expired. Create a new secret and update the GitHub Actions secret.'],
  [700016, 'The application was not found in the tenant. Check the application client ID and tenant ID.'],
]);

export class StoreSubmissionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreSubmissionError';
    this.code = code;
    this.details = details;
  }
}

function requireValue(condition, code, message) {
  if (!condition) throw new StoreSubmissionError(code, message);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value);
}

function text(value, label, maximum, { empty = false } = {}) {
  requireValue(typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= maximum,
    'invalid-metadata', `${label} must be a string with ${empty ? '0' : '1'}–${maximum} characters.`);
  return value;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function versionParts(value) {
  requireValue(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
    'invalid-version', 'A Store version must contain four decimal components.');
  const parts = value.split('.').map(Number);
  requireValue(parts.every(part => Number.isInteger(part) && part <= 65535),
    'invalid-version', 'A Store version component exceeds 65535.');
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new StoreSubmissionError('invalid-input', `Could not read valid JSON for ${label}.`);
  }
}

async function readContainedFile(directory, name) {
  requireValue(safeName(name), 'invalid-file-name', 'Artifact file names must be plain file names.');
  try {
    const root = await fs.realpath(directory);
    const file = path.join(root, name);
    const actual = await fs.realpath(file);
    const stat = await fs.lstat(file);
    requireValue(path.dirname(actual) === root && stat.isFile() && !stat.isSymbolicLink(),
      'invalid-artifact-file', 'An artifact must be a regular file inside its artifact directory.');
    requireValue(stat.size > 0 && stat.size <= 256 * 1024 * 1024,
      'invalid-artifact-file', 'An artifact file is empty or exceeds 256 MiB.');
    return { path: actual, bytes: await fs.readFile(actual) };
  } catch (error) {
    if (error instanceof StoreSubmissionError) throw error;
    throw new StoreSubmissionError('missing-artifact-file', `Could not read artifact file ${name}.`);
  }
}

function python(script, input) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  requireValue(result.status === 0 && !result.error, 'archive-operation-failed',
    'Python could not inspect or create the submission ZIP. Check that Python 3 is installed and the MSIX is valid.');
  try { return JSON.parse(result.stdout); } catch {
    throw new StoreSubmissionError('archive-operation-failed', 'Python returned an invalid archive result.');
  }
}

function inspectMsix(file) {
  return python(`import json, sys, zipfile, xml.etree.ElementTree as ET
data = json.load(sys.stdin)
with zipfile.ZipFile(data['path']) as archive:
    assert archive.testzip() is None
    assert len([item for item in archive.namelist() if item == 'AppxManifest.xml']) == 1
    root = ET.fromstring(archive.read('AppxManifest.xml'))
    identity = root.find('{http://schemas.microsoft.com/appx/manifest/foundation/windows10}Identity')
    assert identity is not None
    print(json.dumps(dict(identity.attrib)))`, { path: file });
}

function pngSize(bytes, { icon = false } = {}) {
  requireValue(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.subarray(12, 16).toString('ascii') === 'IHDR', 'invalid-screenshot', 'A screenshot must be a PNG image.');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  requireValue(icon ? width === 300 && height === 300 : width >= 1366 && height >= 768 && width <= 10000 && height <= 10000,
    'invalid-screenshot', icon ? 'A Store icon must be 300 × 300 pixels.'
      : 'A desktop screenshot must be at least 1366 × 768 pixels and at most 10000 × 10000 pixels.');
  return { width, height };
}

export function validateMetadata(input, appVersion) {
  requireValue(object(input) && input.productId === PRODUCT_ID, 'invalid-product', `The product ID must be ${PRODUCT_ID}.`);
  requireValue(input.appVersion === appVersion, 'version-mismatch', 'The listing version differs from the package version.');
  requireValue(input.targetPublishMode === undefined || ['Immediate', 'Manual'].includes(input.targetPublishMode),
    'invalid-metadata', 'The publication mode must be Immediate or Manual.');
  requireValue(object(input.listings) && Object.keys(input.listings).sort().join(',') === LANGUAGES.join(','),
    'invalid-metadata', 'The metadata must provide en-us and ja-jp listings.');
  const result = { productId: PRODUCT_ID, appVersion,
    targetPublishMode: input.targetPublishMode ?? 'Immediate', listings: {} };
  if (input.notesForCertification !== undefined) result.notesForCertification = text(input.notesForCertification,
    'Reviewer notes', 20000, { empty: true });
  for (const language of LANGUAGES) {
    const listing = input.listings[language];
    requireValue(object(listing), 'invalid-metadata', `The ${language} listing is missing.`);
    requireValue(Array.isArray(listing.features) && listing.features.length > 0 && listing.features.length <= 20,
      'invalid-metadata', `The ${language} listing must have 1–20 features.`);
    requireValue(Array.isArray(listing.screenshots) && listing.screenshots.length > 0 && listing.screenshots.length <= 10,
      'invalid-metadata', `The ${language} listing must have 1–10 screenshots.`);
    const seen = new Set();
    const screenshots = listing.screenshots.map(image => {
      requireValue(object(image) && safeName(image.fileName) && image.fileName.endsWith('.png') && !seen.has(image.fileName),
        'invalid-metadata', `The ${language} screenshot file names must be unique PNG file names.`);
      seen.add(image.fileName);
      return { fileName: image.fileName, description: text(image.description, 'Screenshot description', 200) };
    });
    result.listings[language] = {
      description: text(listing.description, `${language} description`, 10000),
      features: listing.features.map(feature => text(feature, 'Feature', 200)),
      releaseNotes: text(listing.releaseNotes, `${language} release notes`, 1500, { empty: true }),
      screenshots,
    };
    if (listing.icon !== undefined) {
      requireValue(object(listing.icon) && safeName(listing.icon.fileName) && listing.icon.fileName.endsWith('.png'),
        'invalid-metadata', 'The Store icon must use a PNG file name.');
      result.listings[language].icon = { fileName: listing.icon.fileName };
    }
  }
  return result;
}

export async function prepareSubmission({ packageDir, listingDir, metadata: metadataFile, output }) {
  const info = await readJson(path.join(packageDir, 'msix-package.json'), 'the package record');
  requireValue(object(info) && info.testIdentity === false && info.identity?.name === IDENTITY_NAME
    && info.identity?.publisher?.toUpperCase() === PUBLISHER.toUpperCase(),
  'invalid-package-identity', 'The package must use the published Store product identity.');
  requireValue(typeof info.appVersion === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.appVersion),
    'invalid-version', 'The app version must contain three decimal components.');
  const appParts = info.appVersion.split('.').map(Number);
  const expectedStoreVersion = `${appParts[0] + 1}.${appParts[1]}.${appParts[2]}.0`;
  requireValue(info.storeVersion === expectedStoreVersion, 'version-mismatch', 'The Store version differs from the app version.');
  versionParts(info.storeVersion);
  requireValue(safeName(info.file) && info.file.endsWith('.msix') && /^[a-f0-9]{64}$/.test(info.sha256),
    'invalid-package-record', 'The package record must name an MSIX and its SHA-256.');
  const packageFile = await readContainedFile(packageDir, info.file);
  requireValue(info.bytes === packageFile.bytes.length && digest(packageFile.bytes) === info.sha256,
    'package-mismatch', 'The package bytes differ from the tested package record.');
  const manifest = inspectMsix(packageFile.path);
  requireValue(manifest.Name === IDENTITY_NAME && manifest.Publisher?.toUpperCase() === PUBLISHER.toUpperCase()
    && manifest.Version === info.storeVersion && manifest.ProcessorArchitecture?.toLowerCase() === 'x64',
  'invalid-package-manifest', 'The MSIX manifest differs from its Store identity, version, or x64 architecture.');
  const metadata = validateMetadata(await readJson(metadataFile, 'the listing metadata'), info.appVersion);
  const screenshotSource = await readJson(path.join(listingDir, 'screenshot-source.json'), 'the screenshot source');
  requireValue(screenshotSource.source === 'installed-msix' && Array.isArray(screenshotSource.files),
    'invalid-screenshot-source', 'The listing must contain screenshots captured from the tested installed MSIX.');
  const files = new Map([[info.file, { path: packageFile.path, bytes: info.bytes, sha256: info.sha256 }]]);
  const imageRecords = new Map();
  for (const language of LANGUAGES) {
    for (const screenshot of metadata.listings[language].screenshots) {
      requireValue(screenshotSource.files.includes(screenshot.fileName), 'invalid-screenshot-source',
        'A requested screenshot is absent from the installed-app screenshot record.');
      if (imageRecords.has(screenshot.fileName)) continue;
      const image = await readContainedFile(listingDir, screenshot.fileName);
      const dimensions = pngSize(image.bytes);
      imageRecords.set(screenshot.fileName, { ...dimensions, bytes: image.bytes.length, sha256: digest(image.bytes) });
      files.set(`images/${screenshot.fileName}`, { path: image.path, bytes: image.bytes.length, sha256: digest(image.bytes) });
    }
    const icon = metadata.listings[language].icon;
    if (icon) {
      const image = await readContainedFile(listingDir, icon.fileName);
      const dimensions = pngSize(image.bytes, { icon: true });
      imageRecords.set(icon.fileName, { ...dimensions, bytes: image.bytes.length, sha256: digest(image.bytes) });
      files.set(`images/${icon.fileName}`, { path: image.path, bytes: image.bytes.length, sha256: digest(image.bytes) });
    }
  }
  await fs.mkdir(output, { recursive: true });
  const archivePath = path.resolve(output, 'submission.zip');
  python(`import hashlib, json, sys, zipfile
data = json.load(sys.stdin)
with zipfile.ZipFile(data['output'], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for item in data['files']:
        archive.write(item['path'], item['name'])
with zipfile.ZipFile(data['output']) as archive:
    assert archive.testzip() is None
    for item in data['files']:
        content = archive.read(item['name'])
        assert len(content) == item['bytes']
        assert hashlib.sha256(content).hexdigest() == item['sha256']
    print(json.dumps({'files': archive.namelist()}))`, {
    output: archivePath, files: [...files].map(([name, file]) => ({ name, ...file })),
  });
  const archiveBytes = await fs.readFile(archivePath);
  const plan = {
    productId: PRODUCT_ID, appVersion: info.appVersion, storeVersion: info.storeVersion,
    package: { fileName: info.file, bytes: info.bytes, sha256: info.sha256 },
    targetPublishMode: metadata.targetPublishMode,
    listings: Object.fromEntries(LANGUAGES.map(language => [language, {
      ...metadata.listings[language], screenshots: metadata.listings[language].screenshots.map(image => ({
        ...image, ...imageRecords.get(image.fileName), imageType: 'Screenshot', archivePath: `images/${image.fileName}`,
      })),
      ...(metadata.listings[language].icon ? { icon: {
        ...metadata.listings[language].icon, ...imageRecords.get(metadata.listings[language].icon.fileName),
        imageType: 'Icon', archivePath: `images/${metadata.listings[language].icon.fileName}`,
      } } : {}),
    }])),
    ...(metadata.notesForCertification === undefined ? {} : { notesForCertification: metadata.notesForCertification }),
    archive: { fileName: 'submission.zip', bytes: archiveBytes.length, sha256: digest(archiveBytes) },
  };
  await fs.writeFile(path.join(output, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { info, metadata, plan, archivePath, output: path.resolve(output) };
}

function checkFreePublishedSubmission(submission) {
  requireValue(object(submission) && submission.status === 'Published', 'not-published',
    'The product must already have a published Store submission.');
  requireValue(submission.pricing?.priceId === 'Free', 'unexpected-pricing',
    'This workflow updates the existing free product. Check its current Store pricing.');
  requireValue(Array.isArray(submission.applicationPackages) && submission.applicationPackages.length > 0,
    'missing-published-package', 'The published submission has no application package.');
}

export function buildSubmissionPayload(draft, prepared) {
  requireValue(object(draft) && draft.status === 'PendingCommit', 'unexpected-draft-status',
    'The newly created submission is not ready for changes.');
  requireValue(draft.pricing?.priceId === 'Free', 'unexpected-pricing', 'The new submission must use the existing free price.');
  const result = structuredClone(draft);
  requireValue(object(result.listings), 'missing-listings', 'The Store submission contains no listings.');
  for (const language of LANGUAGES) {
    const oldListing = result.listings[language];
    requireValue(object(oldListing?.baseListing), 'missing-listing-language', `The published app must already have a ${language} listing.`);
    const update = prepared.metadata.listings[language];
    oldListing.baseListing.description = update.description;
    oldListing.baseListing.features = [...update.features];
    oldListing.baseListing.releaseNotes = update.releaseNotes;
    const oldImages = oldListing.baseListing.images ?? [];
    requireValue(Array.isArray(oldImages), 'invalid-existing-images', 'The Store listing has an invalid image list.');
    oldListing.baseListing.images = [
      ...oldImages.map(image => image.imageType === 'Screenshot' || (update.icon && image.imageType === 'Icon')
        ? { ...image, fileStatus: 'PendingDelete' } : image),
      ...update.screenshots.map(image => ({ fileName: `images/${image.fileName}`, fileStatus: 'PendingUpload',
        description: image.description, imageType: 'Screenshot' })),
      ...(update.icon ? [{ fileName: `images/${update.icon.fileName}`, fileStatus: 'PendingUpload', imageType: 'Icon' }] : []),
    ];
  }
  requireValue(Array.isArray(result.applicationPackages), 'missing-published-package', 'The submission has no application package list.');
  result.applicationPackages = [
    ...result.applicationPackages.map(item => item.architecture?.toLowerCase() === 'x64' ? { ...item, fileStatus: 'PendingDelete' } : item),
    { fileName: prepared.info.file, fileStatus: 'PendingUpload', minimumDirectXVersion: 'None', minimumSystemRam: 'None' },
  ];
  result.targetPublishMode = prepared.metadata.targetPublishMode;
  if (prepared.metadata.notesForCertification !== undefined) result.notesForCertification = prepared.metadata.notesForCertification;
  // The upload URL authorizes a Blob upload and is never written to a log or artifact.
  delete result.fileUploadUrl;
  delete result.statusDetails;
  return result;
}

function statusName(value) {
  return STATUS_NAMES.has(value) ? value : 'Unknown';
}

function submissionId(value) {
  requireValue(typeof value === 'string' && /^[0-9]{1,30}$/.test(value), 'invalid-submission-id',
    'Microsoft returned an invalid submission ID.');
  return value;
}

function credentials(env) {
  const tenantId = env.PARTNER_CENTER_TENANT_ID;
  const clientId = env.PARTNER_CENTER_CLIENT_ID;
  const clientSecret = env.PARTNER_CENTER_CLIENT_SECRET;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  requireValue(uuid.test(tenantId ?? ''), 'missing-credentials', 'Set PARTNER_CENTER_TENANT_ID to the Entra tenant ID.');
  requireValue(uuid.test(clientId ?? ''), 'missing-credentials', 'Set PARTNER_CENTER_CLIENT_ID to the Entra application ID.');
  requireValue(typeof clientSecret === 'string' && clientSecret.length > 0, 'missing-credentials',
    'Set PARTNER_CENTER_CLIENT_SECRET in GitHub Actions secrets.');
  return { tenantId, clientId, clientSecret };
}

async function authenticationFailure(response) {
  let body;
  try { body = await response.json(); } catch { return {}; }
  if (!object(body)) return {};
  const oauthError = OAUTH_ERROR_NAMES.has(body.error) ? body.error : undefined;
  const aadstsCodes = Array.isArray(body.error_codes) ? [...new Set(body.error_codes.filter(code =>
    Number.isSafeInteger(code) && code > 0 && code <= 999999999))].slice(0, 8) : [];
  return { ...(oauthError ? { oauthError } : {}), ...(aadstsCodes.length ? { aadstsCodes } : {}) };
}

class StoreClient {
  constructor(fetchImpl) { this.fetch = fetchImpl; this.token = null; }
  async request(url, options, label, { json = true, timeout = 60000, authentication = false } = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
    catch { throw new StoreSubmissionError('network-error', `${label} did not complete. Retry after checking the connection and the existing submission state.`); }
    if (!response.ok) {
      const details = authentication ? await authenticationFailure(response) : {};
      const parts = [`${label} returned HTTP ${response.status}.`];
      if (details.oauthError) parts.push(`OAuth error: ${details.oauthError}.`);
      if (details.aadstsCodes) {
        parts.push(`Error codes: ${details.aadstsCodes.map(code => `AADSTS${code}`).join(', ')}.`);
        for (const code of details.aadstsCodes) if (AUTH_ERROR_HELP.has(code)) parts.push(AUTH_ERROR_HELP.get(code));
      }
      throw new StoreSubmissionError('http-error', parts.join(' '), { authentication: details });
    }
    if (!json || response.status === 204) return null;
    try { return await response.json(); }
    catch { throw new StoreSubmissionError('invalid-api-response', `${label} returned invalid JSON.`); }
  }
  async authenticate(env) {
    const { tenantId, clientId, clientSecret } = credentials(env);
    const result = await this.request(`https://login.microsoftonline.com/${tenantId}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId,
        client_secret: clientSecret, resource: 'https://manage.devcenter.microsoft.com' }),
    }, 'Microsoft Entra authentication', { authentication: true });
    requireValue(typeof result.access_token === 'string' && result.access_token.length > 0,
      'invalid-api-response', 'Microsoft Entra did not return an access token.');
    this.token = result.access_token;
  }
  async api(method, route, label, body) {
    return this.request(`${API_ROOT}${route}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, label);
  }
  async upload(value, archivePath, expectedArchive) {
    let url;
    try { url = new URL(value); } catch { /* Report a fixed message below. */ }
    requireValue(url?.protocol === 'https:' && /^[a-z0-9-]+\.blob\.core\.windows\.net$/i.test(url.hostname)
      && !url.username && !url.password && url.searchParams.has('sig'), 'invalid-upload-url',
    'Microsoft returned an invalid Azure Blob upload address.');
    const body = await fs.readFile(archivePath);
    requireValue(body.length === expectedArchive.bytes && digest(body) === expectedArchive.sha256,
      'archive-mismatch', 'The submission ZIP changed after it was prepared.');
    await this.request(url.href, { method: 'PUT', headers: {
      'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2021-12-02', 'Content-Type': 'application/zip',
      'Content-Length': String(body.length),
    }, body }, 'Submission ZIP upload', { json: false, timeout: 180000 });
  }
}

async function writeResult(prepared, values) {
  const result = { productId: PRODUCT_ID, appVersion: prepared.info.appVersion,
    storeVersion: prepared.info.storeVersion, packageSha256: prepared.info.sha256, ...values };
  await fs.writeFile(path.join(prepared.output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function checkStoreApplication(app) {
  requireValue(app.id === PRODUCT_ID && app.packageIdentityName === IDENTITY_NAME
    && app.publisherName?.toUpperCase() === PUBLISHER.toUpperCase(),
  'store-identity-mismatch', 'The connected Store application differs from the published product identity.');
}

export async function readSubmissionStatus({ output }, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  requireValue(typeof output === 'string' && output.length > 0, 'invalid-arguments', 'Provide --output for the Store status result.');
  await fs.mkdir(output, { recursive: true });
  const resultFile = path.join(output, 'result.json');
  let result = { productId: PRODUCT_ID, submissionId: null, status: 'Unknown', published: false };
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  const client = new StoreClient(fetchImpl);
  await client.authenticate(env);
  const appPath = `/applications/${PRODUCT_ID}`;
  const app = await client.api('GET', appPath, 'Reading the Store application');
  checkStoreApplication(app);
  const id = submissionId(app.pendingApplicationSubmission?.id ?? app.lastPublishedApplicationSubmission?.id);
  const report = await client.api('GET', `${appPath}/submissions/${id}/status`, 'Reading the Store submission status');
  const status = statusName(report?.status);
  result = { productId: PRODUCT_ID, submissionId: id, status, published: status === 'Published' };
  await fs.writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  requireValue(status !== 'Unknown', 'invalid-api-response', 'Microsoft returned an unknown submission status.');
  requireValue(!FAILED_STATUSES.has(status), 'submission-failed', `Submission ${id} has status ${status}.`);
  return result;
}

export async function submitPrepared(prepared, { env = process.env, fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollAttempts = 8, pollInterval = 15000 } = {}) {
  const client = new StoreClient(fetchImpl);
  let id;
  let phase = 'authentication';
  let committed = false;
  try {
    await client.authenticate(env);
    const appPath = `/applications/${PRODUCT_ID}`;
    const app = await client.api('GET', appPath, 'Reading the Store application');
    checkStoreApplication(app);
    if (app.pendingApplicationSubmission?.id) {
      id = submissionId(app.pendingApplicationSubmission.id);
      const existing = await client.api('GET', `${appPath}/submissions/${id}/status`, 'Reading the existing submission status');
      const status = statusName(existing.status);
      throw new StoreSubmissionError('pending-submission', `Submission ${id} already exists with status ${status}. Finish or remove it in its original submission workflow before starting this update.`,
        { submissionId: id, status });
    }
    const publishedId = submissionId(app.lastPublishedApplicationSubmission?.id);
    const published = await client.api('GET', `${appPath}/submissions/${publishedId}`, 'Reading the published submission');
    checkFreePublishedSubmission(published);
    const currentPackages = published.applicationPackages.filter(item => item.fileStatus !== 'PendingDelete'
      && item.architecture?.toLowerCase() === 'x64');
    requireValue(currentPackages.length > 0, 'missing-published-package', 'The published submission has no x64 package.');
    const comparisons = currentPackages.map(item => compareVersions(prepared.info.storeVersion, item.version));
    requireValue(comparisons.every(value => value >= 0), 'older-package', 'A newer x64 package is already published in Microsoft Store.');
    if (comparisons.includes(0)) return writeResult(prepared, {
      outcome: 'already-published', submissionId: publishedId, status: 'Published', published: true,
    });
    // Check the mutable fields against the current published submission before creating a draft.
    buildSubmissionPayload({ ...published, status: 'PendingCommit' }, prepared);
    phase = 'creating-submission';
    const draft = await client.api('POST', `${appPath}/submissions`, 'Creating the Store submission');
    id = submissionId(draft.id);
    await writeResult(prepared, { outcome: 'in-progress', submissionId: id, status: statusName(draft.status), published: false });
    const payload = buildSubmissionPayload(draft, prepared);
    phase = 'updating-submission';
    await client.api('PUT', `${appPath}/submissions/${id}`, 'Updating the Store submission', payload);
    phase = 'uploading-files';
    await client.upload(draft.fileUploadUrl, prepared.archivePath, prepared.plan.archive);
    phase = 'committing-submission';
    await client.api('POST', `${appPath}/submissions/${id}/commit`, 'Committing the Store submission');
    committed = true;
    phase = 'checking-status';
    let status = 'CommitStarted';
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const report = await client.api('GET', `${appPath}/submissions/${id}/status`, 'Reading the new submission status');
      status = statusName(report.status);
      if (FAILED_STATUSES.has(status)) throw new StoreSubmissionError('submission-failed',
        `Submission ${id} has status ${status}.`, { submissionId: id, status });
      requireValue(status !== 'Unknown', 'invalid-api-response', 'Microsoft returned an unknown submission status.');
      if (!['None', 'PendingCommit', 'CommitStarted'].includes(status)) break;
      if (attempt + 1 < pollAttempts) await sleep(pollInterval);
    }
    return writeResult(prepared, { outcome: 'submitted', submissionId: id, status, published: status === 'Published',
      commitPending: ['None', 'PendingCommit', 'CommitStarted'].includes(status) });
  } catch (error) {
    const failure = error instanceof StoreSubmissionError ? error
      : new StoreSubmissionError('submission-error', 'The Store submission could not complete.');
    const details = failure.details ?? {};
    await writeResult(prepared, { outcome: 'blocked', ...(id ? { submissionId: id } : {}),
      ...(details.status ? { status: details.status } : {}), published: false, committed,
      phase, error: { code: failure.code, message: failure.message, ...details.authentication } });
    throw failure;
  }
}

export function parseArguments(args) {
  const result = {};
  const keys = { '--package-dir': 'packageDir', '--listing-dir': 'listingDir', '--metadata': 'metadata', '--output': 'output' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--prepare' || arg === '--submit' || arg === '--status') {
      requireValue(!result.mode, 'invalid-arguments', 'Choose exactly one of --prepare, --submit and --status.');
      result.mode = arg.slice(2);
    } else if (keys[arg]) {
      requireValue(!result[keys[arg]] && args[index + 1] && !args[index + 1].startsWith('--'),
        'invalid-arguments', `Provide one value for ${arg}.`);
      result[keys[arg]] = args[++index];
    } else {
      throw new StoreSubmissionError('invalid-arguments', 'Unknown argument. Use --status with --output, or --prepare/--submit with --package-dir, --listing-dir, --metadata and --output.');
    }
  }
  if (result.mode === 'status') {
    requireValue(result.output && !result.packageDir && !result.listingDir && !result.metadata, 'invalid-arguments',
      'Use --status with --output only.');
  } else {
    requireValue(result.mode && Object.values(keys).every(key => result[key]), 'invalid-arguments',
      'Use --status with --output, or --prepare/--submit with --package-dir, --listing-dir, --metadata and --output.');
  }
  return result;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === 'status') {
      const result = await readSubmissionStatus(options);
      console.log(`Store submission ${result.submissionId}: ${result.status}.`);
      return;
    }
    const prepared = await prepareSubmission(options);
    if (options.mode === 'prepare') {
      console.log(`Prepared ${PRODUCT_ID} version ${prepared.info.storeVersion}: submission.zip and plan.json.`);
      return;
    }
    const result = await submitPrepared(prepared);
    console.log(`Store submission ${result.submissionId}: ${result.status} (${result.outcome}).`);
  } catch (error) {
    console.error(error instanceof StoreSubmissionError ? `${error.code}: ${error.message}` : 'The Store submission command could not complete.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
