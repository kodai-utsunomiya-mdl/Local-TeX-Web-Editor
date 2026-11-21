import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(site, 'website-checks');
const filename = path.join(site, 'assets/social-preview.png');
const width = 1280;
const height = 640;

async function sourceFile(repositoryPath, websitePath) {
  const source = path.join(site, '..', repositoryPath);
  try { await access(source); return source; } catch { return path.join(site, websitePath); }
}

const iconPath = await sourceFile('internal/branding/app-icon.svg', 'assets/app-icon.svg');
const screenshotPath = await sourceFile('docs/screenshots/editor-tex-dark.png', 'assets/editor-tex-dark.png');
const icon = (await readFile(iconPath)).toString('base64');
const screenshot = await readFile(screenshotPath);
const screenshotWidth = screenshot.readUInt32BE(16);
const screenshotHeight = screenshot.readUInt32BE(20);
assert.equal(screenshotWidth * 5, screenshotHeight * 8, 'The source screenshot must have an 8:5 aspect ratio.');
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${width}, initial-scale=1">
  <title>Local TeX Web Editor</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
    body { background: #111c26; color: #f1f5f9; font-family: Arial, Helvetica, sans-serif; }
    main { width: 100%; height: 100%; display: grid; grid-template-columns: 300px minmax(0, 1fr); align-items: center; gap: 36px; padding: 48px; }
    .brand { min-width: 0; }
    .icon { display: block; width: 82px; height: 82px; margin-left: -3px; }
    h1 { margin: 28px 0 22px; font-size: 48px; line-height: 1.14; font-weight: 700; letter-spacing: -1.3px; }
    h1 span { display: block; white-space: nowrap; }
    .details { margin: 0; color: #b5c8d4; font-size: 18px; line-height: 1.75; }
    figure { margin: 0; min-width: 0; overflow: hidden; border: 1px solid #344b5b; border-radius: 12px; background: #192733; box-shadow: 0 18px 36px #00000038; }
    .editor { display: block; width: 100%; height: auto; }
  </style>
</head>
<body>
  <main>
    <section class="brand" aria-label="Application">
      <img class="icon" src="data:image/svg+xml;base64,${icon}" alt="" width="82" height="82">
      <h1><span>Local TeX</span><span>Web Editor</span></h1>
      <p class="details">Windows · macOS<br>TeX · Markdown</p>
    </section>
    <figure>
      <img class="editor" src="data:image/png;base64,${screenshot.toString('base64')}" alt="TeX source and its compiled PDF in Local TeX Web Editor" width="${screenshotWidth}" height="${screenshotHeight}">
    </figure>
  </main>
</body>
</html>
`;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'social-preview.html'), html);

let playwright;
try {
  playwright = require('playwright');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !process.env.RUNNER_TEMP) throw error;
  playwright = require(path.join(process.env.RUNNER_TEMP, 'website-browser/node_modules/playwright'));
}
const browser = await playwright.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await page.route(/^https?:/, route => route.abort());
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, image => image.decode()));
  });
  const layout = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    titleFits: Array.from(document.querySelectorAll('h1 span')).every(line => line.scrollWidth <= line.clientWidth),
    imageWidth: document.querySelector('.editor').naturalWidth,
    imageHeight: document.querySelector('.editor').naturalHeight,
  }));
  assert.equal(layout.pageWidth, width);
  assert.equal(layout.pageHeight, height);
  assert.equal(layout.titleFits, true, 'The application name must fit inside the card.');
  assert.ok(layout.imageWidth > 0 && layout.imageHeight > 0);
  await page.screenshot({ path: filename, type: 'png', animations: 'disabled' });
  const png = await readFile(filename);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  assert.ok(png.length < 1_000_000, 'The GitHub social preview must be smaller than 1 MB.');
  await writeFile(path.join(output, 'social-preview.png'), png);
  const result = { file: 'assets/social-preview.png', width, height, bytes: png.length, ...layout };
  await writeFile(path.join(output, 'social-preview.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
