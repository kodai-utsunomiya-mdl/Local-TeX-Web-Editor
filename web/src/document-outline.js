// Only resolve literal TeX filenames that already belong to the project's index.
function resolvePath(directory, name) {
  if (!name || /^(?:\/|[A-Za-z]:)|[\\{}#$]/.test(name)) return null;
  const parts = directory ? directory.split('/') : [];
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

const directoryOf = path => path.split('/').slice(0, -1).join('/');

export function wholeDocumentOutline(index, project, activePath, previousMain) {
  const windows = /^(?:[A-Za-z]:|\\\\)/.test(project.root);
  const key = path => windows ? path.toLowerCase() : path;
  const known = new Map(Array.from(index.keys(), path => [key(path), path]));
  const configs = new Set((project.files || []).filter(file => /(?:^|\/)\.?latexmkrc$/.test(key(file.path))).map(file => key(directoryOf(file.path))));
  function build(main) {
    const base = directoryOf(main);
    let work = '';
    if (project.mode === 'document') {
      let dir = base;
      while (dir && !configs.has(key(dir))) dir = directoryOf(dir);
      work = dir;
    }
    const visited = new Set(), outline = [];
    const frames = [];
    function enter(path) {
      if (visited.has(path)) return;
      visited.add(path);
      frames.push({ path, items: index.get(path)?.documentItems || [], cursor: 0 });
    }
    enter(main);
    while (frames.length) {
      const frame = frames.at(-1);
      if (frame.cursor === frame.items.length) { frames.pop(); continue; }
      const item = frame.items[frame.cursor++];
      if (item.include === undefined) { outline.push({ ...item, path: frame.path }); continue; }
      const directories = new Set([work, base, directoryOf(frame.path)]);
      for (const dir of directories) {
        const path = resolvePath(dir, item.include);
        if (!path) continue;
        const actual = known.get(key(path)) || known.get(key(path + '.tex'));
        if (actual && index.get(actual)?.documentItems) { enter(actual); break; }
      }
    }
    return { main, outline, visited };
  }
  const active = index.get(activePath);
  const explicit = known.get(key(active?.main || ''));
  if (explicit) return build(explicit);
  const candidates = new Set([previousMain, project.main]);
  for (const [path, entry] of index) if (entry.main === path) candidates.add(path);
  for (const candidate of candidates) {
    if (!candidate || candidate === activePath || !index.has(candidate)) continue;
    const result = build(candidate);
    if (result.visited.has(activePath)) return result;
  }
  return build(activePath);
}
