import { t } from './i18n.js';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function normalizePanelLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    sidebarWidth: Number.isFinite(source.sidebarWidth) && source.sidebarWidth > 0 ? source.sidebarWidth : null,
    editorRatio: Number.isFinite(source.editorRatio) ? clamp(source.editorRatio, 0, 1) : .5,
    logHeight: Number.isFinite(source.logHeight) && source.logHeight > 0 ? source.logHeight : null,
    previewVisible: source.previewVisible !== false,
  };
}

export function calculatePanelLayout({ width, height, viewportHeight = height, overlay = false, singlePane = false,
  sidebarCollapsed = false, defaultSidebar = 226, preferences: value } = {}) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  const preferences = normalizePanelLayout(value);
  const twoPanes = !singlePane && preferences.previewVisible;
  const sidebarMax = Math.max(0, overlay ? width - 40 : width - (twoPanes ? 530 : 265));
  const sidebarMin = Math.min(180, sidebarMax);
  const sidebarWidth = clamp(preferences.sidebarWidth ?? defaultSidebar, sidebarMin, sidebarMax);
  const editorSpace = Math.max(0, width - (sidebarCollapsed || overlay ? 0 : sidebarWidth + 5) - (twoPanes ? 5 : 0));
  const editorMin = Math.min(260, twoPanes ? editorSpace / 2 : editorSpace);
  const editorMax = twoPanes ? Math.max(editorMin, editorSpace - editorMin) : editorSpace;
  const editorWidth = twoPanes ? clamp(editorSpace * preferences.editorRatio, editorMin, editorMax) : editorSpace;
  const previewWidth = twoPanes ? editorSpace - editorWidth : 0;
  // If one track reaches its minimum, CSS Grid recalculates the other track.
  // A remaining flex factor below 1 can leave part of the available space empty.
  // Scale both factors so the smaller one is 1, including at either drag limit.
  const unit = Math.min(editorWidth, previewWidth);
  const logMax = Math.max(0, height - Math.min(160, height / 2));
  const logMin = Math.min(100, logMax);
  const defaultLog = clamp(viewportHeight * .25, 135, 260);
  const logHeight = clamp(preferences.logHeight ?? defaultLog, logMin, logMax);
  return {
    preferences, editorSpace, previewWidth,
    editorFactor: unit > 0 ? editorWidth / unit : 1,
    previewFactor: unit > 0 ? previewWidth / unit : 1,
    sidebar: { minimum: sidebarMin, maximum: sidebarMax, value: sidebarWidth },
    editor: { minimum: editorMin, maximum: editorMax, value: editorWidth },
    log: { minimum: logMin, maximum: logMax, value: logHeight },
  };
}

export function createPanelLayout({ workbench, shell, handles, getPreferences, onChange }) {
  let drag = null;

  function measurements() {
    const bounds = workbench.getBoundingClientRect();
    return calculatePanelLayout({
      width: bounds.width, height: bounds.height, viewportHeight: innerHeight,
      overlay: matchMedia('(max-width: 640px)').matches,
      singlePane: matchMedia('(max-width: 900px)').matches,
      sidebarCollapsed: shell.classList.contains('sidebar-collapsed'),
      defaultSidebar: parseFloat(getComputedStyle(workbench).getPropertyValue('--sidebar-width')) || 226,
      preferences: getPreferences(),
    });
  }

  function refresh() {
    shell.classList.toggle('preview-hidden', !normalizePanelLayout(getPreferences()).previewVisible);
    const sizes = measurements();
    if (!sizes) { finishDrag(); return; }
    workbench.style.setProperty('--sidebar-size', sizes.sidebar.value + 'px');
    workbench.style.setProperty('--log-height', sizes.log.value + 'px');
    workbench.style.setProperty('--panel-min-width', sizes.editor.minimum + 'px');
    workbench.style.setProperty('--editor-size', sizes.editorFactor + 'fr');
    workbench.style.setProperty('--preview-size', sizes.previewFactor + 'fr');
    for (const name of ['sidebar', 'editor', 'log']) {
      const handle = handles[name], size = sizes[name];
      handle.setAttribute('aria-valuemin', String(Math.round(size.minimum)));
      handle.setAttribute('aria-valuemax', String(Math.round(size.maximum)));
      handle.setAttribute('aria-valuenow', String(Math.round(size.value)));
      handle.setAttribute('aria-valuetext', t(name === 'log' ? '高さ {value0} px' : '幅 {value0} px', { value0: Math.round(size.value) }));
    }
    if (drag && !drag.handle.getClientRects().length) finishDrag();
  }

  function setPreviewVisible(visible) {
    const preferences = normalizePanelLayout(getPreferences());
    const next = Boolean(visible);
    if (preferences.previewVisible === next) return false;
    finishDrag();
    onChange({ ...preferences, previewVisible: next }, true);
    refresh();
    return true;
  }

  function setSize(name, requested, persist) {
    const sizes = measurements();
    if (!sizes) return false;
    const size = sizes[name];
    const value = clamp(requested, size.minimum, size.maximum);
    const preferences = { ...sizes.preferences };
    if (name === 'sidebar') preferences.sidebarWidth = Math.round(value);
    else if (name === 'log') preferences.logHeight = Math.round(value);
    else if (sizes.editorSpace > 0) preferences.editorRatio = value / sizes.editorSpace;
    if (JSON.stringify(preferences) === JSON.stringify(sizes.preferences)) return false;
    onChange(preferences, persist);
    refresh();
    return true;
  }

  function resetSize(name) {
    const preferences = normalizePanelLayout(getPreferences());
    if (name === 'sidebar') preferences.sidebarWidth = null;
    else if (name === 'log') preferences.logHeight = null;
    else preferences.editorRatio = .5;
    onChange(preferences, true);
    refresh();
  }

  function finishDrag(event) {
    if (!drag || (event && 'pointerId' in event && event.pointerId !== drag.pointerId)) return;
    const current = drag;
    drag = null;
    current.handle.removeEventListener('pointermove', moveDrag);
    current.handle.removeEventListener('pointerup', finishDrag);
    current.handle.removeEventListener('pointercancel', finishDrag);
    current.handle.removeEventListener('lostpointercapture', finishDrag);
    current.handle.classList.remove('dragging');
    document.body.classList.remove('resizing', 'resizing-log');
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    if (current.changed) onChange(normalizePanelLayout(getPreferences()), true);
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = drag.name === 'log' ? drag.startPointer - event.clientY : event.clientX - drag.startPointer;
    const changed = setSize(drag.name, drag.startSize + delta, false);
    if (drag) drag.changed ||= changed;
  }

  for (const name of ['sidebar', 'editor', 'log']) {
    const handle = handles[name];
    handle.addEventListener('dblclick', event => {
      if (event.button !== 0 || drag || !handle.getClientRects().length) return;
      event.preventDefault();
      resetSize(name);
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || drag) return;
      const sizes = measurements();
      if (!sizes || !handle.getClientRects().length) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      drag = { name, handle, pointerId: event.pointerId, startPointer: name === 'log' ? event.clientY : event.clientX, startSize: sizes[name].value, changed: false };
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.classList.toggle('resizing-log', name === 'log');
      handle.addEventListener('pointermove', moveDrag);
      handle.addEventListener('pointerup', finishDrag);
      handle.addEventListener('pointercancel', finishDrag);
      handle.addEventListener('lostpointercapture', finishDrag);
    });
    handle.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || drag) return;
      const sizes = measurements();
      if (!sizes || !handle.getClientRects().length) return;
      if (event.key === 'Enter') { event.preventDefault(); resetSize(name); return; }
      const size = sizes[name];
      let value;
      if (event.key === 'Home') value = size.minimum;
      else if (event.key === 'End') value = size.maximum;
      else if (event.key === (name === 'log' ? 'ArrowUp' : 'ArrowRight')) value = size.value + 25;
      else if (event.key === (name === 'log' ? 'ArrowDown' : 'ArrowLeft')) value = size.value - 25;
      else return;
      event.preventDefault();
      setSize(name, value, true);
    });
  }
  window.addEventListener('blur', finishDrag);
  window.addEventListener('resize', refresh);
  const observer = new ResizeObserver(refresh);
  observer.observe(workbench);
  refresh();
  return { refresh, setPreviewVisible };
}
