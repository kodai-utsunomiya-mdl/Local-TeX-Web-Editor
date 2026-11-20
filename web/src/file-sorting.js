const orders = new Set(['name-asc', 'name-desc', 'modified-desc', 'modified-asc', 'manual']);

export function normalizeFileSort(value) {
  return orders.has(value) ? value : 'name-asc';
}

export function fileModificationTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function fractionalNanoseconds(value) {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] || '';
  return Number(fraction.padEnd(9, '0').slice(0, 9));
}

export function projectListingSignature(project) {
  return JSON.stringify([project?.root, project?.files, project?.directories, project?.directoryModifiedAt]);
}

export function normalizeFileOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, paths]) => Array.isArray(paths)).map(([parent, paths]) => [parent, [...new Set(paths.filter(path => typeof path === 'string' && path && parentPath(path) === parent))]]));
}

const parentPath = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export function buildFileTree(project, { sort = 'name-asc', filter = '', locale = 'en', fileOrder = {} } = {}) {
  sort = normalizeFileSort(sort);
  const query = String(filter).trim().toLocaleLowerCase();
  const matches = path => !query || path.toLocaleLowerCase().includes(query);
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const compareNames = (a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const direction = sort.endsWith('-desc') ? -1 : 1;
  const compare = (a, b) => {
    if (sort.startsWith('name-')) return direction * compareNames(a, b);
    const aTime = fileModificationTime(a.modifiedAt), bTime = fileModificationTime(b.modifiedAt);
    if (aTime === null || bTime === null) {
      if (aTime !== bTime) return aTime === null ? 1 : -1;
    } else {
      const difference = aTime - bTime || fractionalNanoseconds(a.modifiedAt) - fractionalNanoseconds(b.modifiedAt);
      if (difference) return direction * difference;
    }
    return compareNames(a, b);
  };
  const node = (path = '', name = '') => ({ path, name, modifiedAt: project?.directoryModifiedAt?.[path], directories: new Map(), files: [] });
  const root = node();
  const directory = parts => {
    let current = root;
    for (const name of parts) {
      if (!name) continue;
      const path = current.path ? `${current.path}/${name}` : name;
      if (!current.directories.has(name)) current.directories.set(name, node(path, name));
      current = current.directories.get(name);
    }
    return current;
  };
  for (const path of project?.directories || []) if (matches(path)) directory(path.split('/'));
  for (const file of project?.files || []) {
    if (!matches(file.path)) continue;
    const parts = file.path.split('/');
    directory(parts.slice(0, -1)).files.push({ ...file, name: parts.at(-1) });
  }
  const sorted = current => {
    const directories = [...current.directories.values()].sort(sort === 'manual' ? compareNames : compare).map(sorted);
    const files = current.files.sort(sort === 'manual' ? compareNames : compare);
    const entries = [...directories, ...files];
    if (sort === 'manual') {
      const paths = Array.isArray(fileOrder[current.path]) ? fileOrder[current.path] : [];
      const rank = new Map(paths.map((path, index) => [path, index]));
      entries.sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) || 0);
    }
    return { path: current.path, name: current.name, directory: true, modifiedAt: current.modifiedAt, directories, files, entries };
  };
  return sorted(root);
}

export function captureFileOrder(project, options = {}) {
  const result = [];
  function visit(node) {
    result.push([node.path, node.entries.map(entry => entry.path)]);
    for (const directory of node.directories) visit(directory);
  }
  visit(buildFileTree(project, options));
  return Object.fromEntries(result);
}

export function mapFileOrder(order, from, to, directory, removed = false) {
  const map = path => path === from || directory && path.startsWith(`${from}/`)
    ? removed ? null : to + path.slice(from.length) : path;
  return normalizeFileOrder(Object.fromEntries(Object.entries(order).flatMap(([parent, paths]) => {
    const nextParent = map(parent);
    return nextParent === null ? [] : [[nextParent, paths.map(map).filter(path => path !== null)]];
  })));
}

export function placeInFileOrder(order, path, { parent = parentPath(path), anchor = '', after = false } = {}) {
  const result = { ...normalizeFileOrder(order) };
  for (const [folder, paths] of Object.entries(result)) result[folder] = paths.filter(candidate => candidate !== path);
  const siblings = Array.isArray(result[parent]) ? result[parent] : [];
  const index = anchor ? siblings.indexOf(anchor) : -1;
  siblings.splice(index < 0 ? siblings.length : index + Number(after), 0, path);
  Object.defineProperty(result, parent, { value: siblings, enumerable: true, writable: true, configurable: true });
  return result;
}
