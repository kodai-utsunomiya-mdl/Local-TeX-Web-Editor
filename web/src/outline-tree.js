import { t, onLanguageChange } from './i18n.js';

export function outlineHierarchy(outline) {
  const roots = [], nodes = [], stack = [];
  const occurrence = new Map();
  for (const item of outline) {
    const level = Number(item.level) || 0;
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const parent = stack.at(-1) || null;
    const base = `${parent?.id || ''}/${level}:${encodeURIComponent(item.title || '')}`;
    const count = occurrence.get(base) || 0;
    occurrence.set(base, count + 1);
    const node = { item, level, parent, children: [], id: `${base}:${count}` };
    (parent ? parent.children : roots).push(node);
    nodes.push(node); stack.push(node);
  }
  return { roots, nodes };
}

export function createOutlineTree({ container, onJump }) {
  const documents = new Map();
  let current = null, hierarchy = { roots: [], nodes: [] }, collapsed = new Set(), active = null;
  let rendered = new Map(), sequence = 0;

  function storageKey(value) { return `${value.projectRoot || ''}\0${value.path || ''}\0${value.scope || 'file'}`; }
  function label(node) { return node.item.title || t('(無題の見出し)'); }
  function setDisclosure(node, value, save = true) {
    const entry = rendered.get(node.id);
    if (!entry?.toggle || !entry.children) return;
    entry.children.hidden = !value;
    entry.toggle.setAttribute('aria-expanded', String(value));
    entry.toggle.title = entry.toggle.ariaLabel = t(value ? '下位見出しを折りたたむ: {title}' : '下位見出しを展開: {title}', { title: label(node) });
    entry.row.classList.toggle('collapsed', !value);
    if (save) {
      if (value) collapsed.delete(node.id); else collapsed.add(node.id);
    }
    if (save) updateActive();
  }
  function isShown(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const entry = rendered.get(parent.id);
      if (entry?.children?.hidden) return false;
    }
    return true;
  }
  function updateActive() {
    for (const { link, row } of rendered.values()) {
      link.classList.remove('active'); link.removeAttribute('aria-current'); row.classList.remove('contains-active');
    }
    if (!active || !current) return;
    let node = null;
    for (const candidate of hierarchy.nodes) if ((candidate.item.path || current.path) === active.path && Number(candidate.item.line) <= active.line) node = candidate;
    const selected = node && rendered.get(node.id);
    if (selected) { selected.link.classList.add('active'); selected.link.setAttribute('aria-current', 'location'); }
    if (node && !isShown(node)) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        const entry = rendered.get(parent.id);
        if (entry && isShown(parent)) { entry.row.classList.add('contains-active'); break; }
      }
    }
  }
  function visibleNodes() { return hierarchy.nodes.filter(node => rendered.has(node.id) && isShown(node)); }
  function handleKeys(event, node) {
    const entry = rendered.get(node.id);
    const candidates = visibleNodes(), index = candidates.indexOf(node);
    let target = null;
    if (event.key === 'ArrowDown') target = candidates[Math.min(candidates.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') target = candidates[Math.max(0, index - 1)];
    else if (event.key === 'Home') target = candidates[0];
    else if (event.key === 'End') target = candidates.at(-1);
    else if (event.key === 'ArrowRight') {
      if (entry?.children?.hidden) setDisclosure(node, true);
      else target = entry?.descendants?.[0];
    } else if (event.key === 'ArrowLeft') {
      if (entry?.children && !entry.children.hidden) setDisclosure(node, false);
      else {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (rendered.has(parent.id)) { target = parent; break; }
        }
      }
    } else return;
    event.preventDefault();
    if (target) rendered.get(target.id)?.link.focus();
  }

  function render(value) {
    const previousKey = current && storageKey(current), key = storageKey(value);
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const focusID = focused?.dataset.outlineId, focusToggle = focused?.classList.contains('outline-toggle');
    const scrollTop = previousKey === key ? container.scrollTop : 0;
    current = { ...value, query: String(value.query || '').trim().toLowerCase() };
    hierarchy = outlineHierarchy(value.outline || []);
    if (!documents.has(key)) {
      documents.set(key, new Set());
      if (documents.size > 100) documents.delete(documents.keys().next().value);
    }
    collapsed = documents.get(key);
    rendered = new Map(); container.replaceChildren();
    if (value.path) {
      const heading = document.createElement('p'); heading.className = 'outline-file'; heading.textContent = value.path; container.append(heading);
    }
    const matches = node => !current.query || `${node.item.title} ${node.item.path || value.path}`.toLowerCase().includes(current.query);
    const visible = hierarchy.nodes.filter(matches);
    const visibleIDs = new Set(visible.map(node => node.id));
    const children = new Map();
    for (const node of visible) {
      let parent = node.parent;
      while (parent && !visibleIDs.has(parent.id)) parent = parent.parent;
      const parentID = parent?.id || '';
      if (!children.has(parentID)) children.set(parentID, []);
      children.get(parentID).push(node);
    }
    const build = parentID => {
      const group = document.createElement('ul'); group.className = 'outline-level';
      for (const node of children.get(parentID) || []) {
        const item = document.createElement('li'); item.className = 'outline-item';
        const row = document.createElement('div'); row.className = 'outline-row';
        const descendants = children.get(node.id) || [];
        let toggle = null, nested = null;
        if (descendants.length) {
          toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'outline-toggle'; toggle.dataset.outlineId = node.id;
          const chevron = document.createElement('span'); chevron.className = 'outline-chevron'; chevron.ariaHidden = 'true'; toggle.append(chevron);
          row.append(toggle);
          nested = build(node.id); nested.id = `outline-children-${++sequence}`;
          toggle.setAttribute('aria-controls', nested.id);
          toggle.addEventListener('click', () => setDisclosure(node, nested.hidden));
        } else {
          const spacer = document.createElement('span'); spacer.className = 'outline-toggle-space'; spacer.ariaHidden = 'true'; row.append(spacer);
        }
        const link = document.createElement('button'); link.type = 'button'; link.className = 'outline-link'; link.dataset.outlineId = node.id;
        link.dataset.path = node.item.path || value.path; link.dataset.line = String(node.item.line); link.title = value.scope === 'document' ? label(node) + '\n' + link.dataset.path + ':' + node.item.line : label(node);
        const title = document.createElement('span'); title.className = 'outline-title'; title.textContent = label(node);
        const line = document.createElement('span'); line.className = 'outline-line'; line.textContent = String(node.item.line);
        link.append(title, line); row.append(link);
        link.addEventListener('click', () => onJump(link.dataset.path, node.item.line));
        link.addEventListener('keydown', event => handleKeys(event, node));
        item.append(row); if (nested) item.append(nested); group.append(item);
        rendered.set(node.id, { row, link, toggle, children: nested, descendants });
      }
      return group;
    };
    if (visible.length) {
      container.append(build(''));
      for (const node of visible) setDisclosure(node, !!current.query || !collapsed.has(node.id), false);
    } else {
      const empty = document.createElement('p'); empty.className = 'tree-empty';
      empty.textContent = !value.path ? t('TeX または Markdown ファイルを開くと，その見出しが表示されます．') : !value.supported ? t('このファイルにはアウトラインがありません．') : current.query ? t('一致する見出しがありません．') : t('この文書には見出しがありません．');
      container.append(empty);
    }
    updateActive(); container.scrollTop = scrollTop;
    const entry = rendered.get(focusID);
    if (entry) (focusToggle && entry.toggle ? entry.toggle : entry.link).focus({ preventScroll: true });
  }
  const stopLanguage = onLanguageChange(() => { if (current) render(current); });
  return {
    render,
    setActive(position) { active = position; updateActive(); },
    destroy() { stopLanguage(); documents.clear(); rendered.clear(); container.replaceChildren(); },
  };
}
