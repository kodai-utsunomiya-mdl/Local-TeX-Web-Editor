const orders = new Set(['name-asc', 'name-desc', 'modified-desc', 'modified-asc']);

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

export function buildFileTree(project, { sort = 'name-asc', filter = '', locale = 'en' } = {}) {
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
  const sorted = current => ({
    path: current.path, name: current.name, modifiedAt: current.modifiedAt,
    directories: [...current.directories.values()].sort(compare).map(sorted),
    files: current.files.sort(compare),
  });
  return sorted(root);
}
