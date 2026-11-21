import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(process.env.RUNNER_TEMP, 'website-browser/node_modules/playwright'));
const root = process.cwd();
const sitePath = '/Local-TeX-Web-Editor/';
const output = path.join(root, 'website-checks');
await mkdir(output, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(sitePath)) {
      response.writeHead(404).end();
      return;
    }
    let file = path.resolve(root, pathname.slice(sitePath.length) || '.');
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = [];
try {
  for (const route of [
    { language: 'en', path: '', name: 'en' },
    { language: 'ja', path: 'ja/', name: 'ja' },
    { language: 'en', path: 'privacy/', name: 'en-privacy' },
    { language: 'ja', path: 'ja/privacy/', name: 'ja-privacy' },
  ]) {
    const { language } = route;
    for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => {
        if (response.url().startsWith(baseURL) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
      });
      await page.goto(`${baseURL}${sitePath}${route.path}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      for (const picture of await page.locator('img').all()) {
        await picture.scrollIntoViewIfNeeded();
        await picture.evaluate(image => image.decode());
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      const layout = await page.evaluate(() => ({
        language: document.documentElement.lang,
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        unloadedImages: Array.from(document.images).filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute('src')),
        missingAnchors: Array.from(document.querySelectorAll('a[href^="#"]')).map(link => link.getAttribute('href').slice(1)).filter(id => id && !document.getElementById(decodeURIComponent(id))),
        title: document.title,
      }));
      if (layout.language !== language) errors.push(`Expected ${language}, got ${layout.language}`);
      if (layout.pageWidth > layout.viewportWidth + 1) errors.push(`Horizontal overflow: ${layout.pageWidth}/${layout.viewportWidth}`);
      if (layout.unloadedImages.length) errors.push(`Images did not load: ${layout.unloadedImages.join(', ')}`);
      if (layout.missingAnchors.length) errors.push(`Missing sections: ${layout.missingAnchors.join(', ')}`);
      if (!layout.title.includes('Local TeX Web Editor')) errors.push('The page title does not identify the app.');
      await page.screenshot({ path: path.join(output, `${route.name}-${size.name}.png`), fullPage: true });
      const sectionScreenshots = [];
      if (route.name === 'en' || route.name === 'ja') {
        const steps = page.locator('.setup-steps > li');
        const count = await steps.count();
        if (count !== 6) errors.push(`Expected 6 setup steps, got ${count}.`);
        const captureSection = async (locator, name) => {
          await locator.screenshot({
            path: path.join(output, name),
            style: '.site-header { visibility: hidden !important; }',
          });
          sectionScreenshots.push(name);
        };
        for (let index = 0; index < count; index++) {
          await captureSection(steps.nth(index), `${route.name}-${size.name}-setup-${index + 1}.png`);
        }
        await captureSection(page.locator('#settings-reset'), `${route.name}-${size.name}-settings-reset.png`);
      }
      results.push({ page: route.name, language, viewport: size.name, ...layout, sectionScreenshots, errors });
      await context.close();
    }
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.errors.length)) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
