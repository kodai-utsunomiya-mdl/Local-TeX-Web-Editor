import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { frontendBuildOptions, initialJavaScript } from '../scripts/frontend-build.mjs';

test('the application starts without PDF.js and includes one KaTeX engine', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const { metafile } = await build({ ...frontendBuildOptions(root), write: false });
  const initial = initialJavaScript(metafile);
  const initialInputs = initial.files.flatMap(name => Object.keys(metafile.outputs[name].inputs));
  assert.ok(!initialInputs.some(name => name.includes('pdfjs-dist/')), 'PDF.js should load when a PDF is opened.');
  assert.equal(Object.keys(metafile.inputs).filter(name => /katex\/dist\/katex\.(?:mjs|js)$/.test(name)).length, 1);
  const deferred = Object.entries(metafile.outputs).filter(([, value]) => value.entryPoint?.endsWith('/pdf-runtime.js'));
  assert.equal(deferred.length, 1);
  assert.ok(Object.keys(deferred[0][1].inputs).some(name => name.includes('pdfjs-dist/build/pdf.mjs')));
});
