const knownStatuses = new Set(['available', 'missing', 'not-directory', 'unavailable', 'changed']);

function pathKey(path, platform) {
  path = String(path || '');
  if (platform === 'windows') return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function projectStatusFor(meta, path) {
  const key = pathKey(path, meta?.platform);
  const matches = value => value && typeof value.path === 'string' && pathKey(value.path, meta?.platform) === key;
  const value = matches(meta?.projectStatus) ? meta.projectStatus : (meta?.recentProjectStatuses || []).find(matches);
  if (!value) return { status: 'available', message: '' };
  const status = knownStatuses.has(value.status) ? value.status : 'unavailable';
  return { status, message: status === 'available' ? '' : String(value.message || '') };
}

export function recentProjectEntries(meta = {}) {
  const current = meta.project?.root || '';
  const paths = [current, ...(meta.recentProjects || []).map(value => typeof value === 'string' ? value : value?.root || value?.path || '')];
  const seen = new Set(), entries = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !path) continue;
    const key = pathKey(path, meta.platform);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ path, current: Boolean(current) && key === pathKey(current, meta.platform), ...projectStatusFor(meta, path) });
    if (entries.length === 12) break;
  }
  return entries;
}
