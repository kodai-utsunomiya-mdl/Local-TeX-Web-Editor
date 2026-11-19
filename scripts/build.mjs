import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'web/dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(path.join(out, '.keep'), '');
const bundle = await build({
  entryPoints: [path.join(root, 'web/src/main.js')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['chrome120', 'edge120', 'firefox128'],
  legalComments: 'linked',
  metafile: true,
  logLevel: 'info'
});
await cp(path.join(root, 'web/src/index.html'), path.join(out, 'index.html'));
await cp(path.join(root, 'internal/branding/app-icon.svg'), path.join(out, 'app-icon.svg'));
await cp(path.join(root, 'web/src/style.css'), path.join(out, 'style.css'));
await cp(path.join(root, 'web/src/pdf-search.css'), path.join(out, 'pdf-search.css'));
await cp(path.join(root, 'web/src/source-search.css'), path.join(out, 'source-search.css'));
await cp(path.join(root, 'web/src/markdown-preview.css'), path.join(out, 'markdown-preview.css'));
await cp(path.join(root, 'web/src/tex-packages.css'), path.join(out, 'tex-packages.css'));
await cp(path.join(root, 'web/src/help.css'), path.join(out, 'help.css'));
await mkdir(path.join(out, 'katex'), { recursive: true });
await cp(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(out, 'katex/katex.min.css'));
await cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(out, 'katex/fonts'), { recursive: true });
const pdf = path.join(root, 'node_modules/pdfjs-dist');
await cp(path.join(pdf, 'build/pdf.worker.min.mjs'), path.join(out, 'pdf.worker.min.mjs'));
await cp(path.join(pdf, 'web/pdf_viewer.css'), path.join(out, 'pdf_viewer.css'));
await cp(path.join(pdf, 'web/images'), path.join(out, 'images'), { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(path.join(pdf, folder), path.join(out, folder), { recursive: true });
}
// Keep the third-party license text with the assets embedded in the executable.
let notices = '# Third-party licenses\n\n';
const packages = new Map();
for (const input of Object.keys(bundle.metafile.inputs)) {
  const parts = path.resolve(input).split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) continue;
  const end = index + (parts[index + 1].startsWith('@') ? 3 : 2);
  const dir = parts.slice(0, end).join(path.sep);
  packages.set(parts.slice(index + 1, end).join('/'), dir);
}
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const licenses = (await readdir(dir)).filter(file => /^(licen[sc]e|notice)([.\-]|$)/i.test(file));
  if (!licenses.length) throw new Error(`No license text found for ${name}.`);
  notices += `## ${name} ${metadata.version}\n\n`;
  for (const file of licenses.sort()) notices += `### ${file}\n\n${await readFile(path.join(dir, file), 'utf8')}\n\n`;
}
await writeFile(path.join(out, 'THIRD_PARTY_LICENSES.txt'), notices, 'utf8');
