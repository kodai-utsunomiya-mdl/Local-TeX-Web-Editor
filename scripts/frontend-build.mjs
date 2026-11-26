import path from 'node:path';

export function frontendBuildOptions(root) {
  return {
    entryPoints: [{ in: path.join(root, 'web/src/main.js'), out: 'app' }],
    outdir: path.join(root, 'web/dist'),
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    // markdown-it-texmath can require KaTeX while the editors import it. Resolve
    // both to the same module so the browser loads one copy of the math engine.
    alias: { katex: path.join(root, 'node_modules/katex/dist/katex.mjs') },
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['chrome120', 'edge120', 'firefox128'],
    legalComments: 'linked',
    metafile: true,
  };
}

export function initialJavaScript(metafile) {
  const entry = Object.keys(metafile.outputs).find(name => name.endsWith('/app.js'));
  if (!entry) throw new Error('The application entry point was not built.');
  const initial = new Set();
  const visit = name => {
    if (initial.has(name)) return;
    const output = metafile.outputs[name];
    if (!output) throw new Error(`Missing JavaScript output: ${name}`);
    initial.add(name);
    for (const dependency of output.imports) if (dependency.kind === 'import-statement' && !dependency.external) visit(dependency.path);
  };
  visit(entry);
  return { files: [...initial], bytes: [...initial].reduce((total, name) => total + metafile.outputs[name].bytes, 0) };
}
