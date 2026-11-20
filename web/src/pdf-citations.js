const linkSelector = '.annotationLayer [data-internal-link] a[href]';
let nextTooltipId = 0;

// PDF.js uses escape() when it puts a named destination into a link. Decode
// each escape once so Latin-1 characters, Unicode, and literal % signs agree.
export function citationDestinationFromHref(href) {
  if (typeof href !== 'string') return '';
  const hash = href.indexOf('#');
  if (hash < 0) return '';
  return href.slice(hash + 1).replace(/%u([\da-f]{4})|%([\da-f]{2})/gi,
    (_, unicode, byte) => String.fromCharCode(parseInt(unicode || byte, 16)));
}

function citationIndex(entries) {
  const result = new Map();
  for (const entry of entries || []) {
    if (typeof entry?.key !== 'string' || !entry.key || !entry.title?.trim()) continue;
    const matches = result.get(entry.key) || [];
    if (!matches.some(item => item.title === entry.title && item.author === entry.author && item.year === entry.year)) matches.push(entry);
    result.set(entry.key, matches);
  }
  return result;
}

export function citationsForDestination(destination, entries) {
  if (typeof destination !== 'string' || !destination.startsWith('cite.')) return [];
  const index = entries instanceof Map ? entries : citationIndex(entries);
  const key = destination.slice(5);
  // hyperref/natbib use cite.<key>; biblatex adds the refsection before the key.
  const matches = index.get(key);
  if (matches) return matches;
  const section = /^\d+@(.+)$/.exec(key);
  return section ? index.get(section[1]) || [] : [];
}

const details = entry => [entry.author, entry.year].filter(Boolean).join(' · ');
const summary = entries => entries.map(entry => [entry.title, details(entry), entries.length > 1 ? entry.path : ''].filter(Boolean).join('\n')).join('\n\n');
const restoreAttribute = (element, name, value) => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);

export class PDFCitationTitles {
  constructor({ container, eventBus, getCitations = () => [] }) {
    this.container = container;
    this.eventBus = eventBus;
    this.getCitations = getCitations;
    this.document = container.ownerDocument;
    this.window = this.document.defaultView;
    this.original = new WeakMap();
    this.index = new Map();
    this.entries = null;
    this.activeLink = null;
    this.tooltip = null;
    this.hideTimer = null;
    this.abortController = new this.window.AbortController();
    const signal = this.abortController.signal;

    container.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const link = event.target.closest?.(linkSelector);
      if (link && !link.contains(event.relatedTarget)) this.show(link);
    }, { signal });
    container.addEventListener('pointerout', event => {
      if (!this.activeLink?.contains(event.target) || this.activeLink.contains(event.relatedTarget) || this.tooltip?.contains(event.relatedTarget)) return;
      this.deferHide();
    }, { signal });
    container.addEventListener('focusin', event => {
      const link = event.target.closest?.(linkSelector);
      if (link) this.show(link);
    }, { signal });
    container.addEventListener('focusout', () => this.deferHide(), { signal });
    this.document.addEventListener('keydown', event => { if (event.key === 'Escape') this.hide(); }, { signal });
    this.document.addEventListener('pointerdown', event => { if (!this.tooltip?.contains(event.target)) this.hide(); }, { signal, capture: true });
    this.document.addEventListener('scroll', event => { if (!this.tooltip?.contains(event.target)) this.hide(); }, { signal, capture: true });
    this.window.addEventListener('resize', () => this.hide(), { signal });

    this.onAnnotations = event => {
      if (!event.error && event.source?.div && container.contains(event.source.div)) this.refresh(event.source.div);
    };
    this.onViewChange = () => this.hide();
    eventBus.on('annotationlayerrendered', this.onAnnotations);
    for (const name of ['pagesinit', 'pagesdestroy', 'scalechanging', 'pagechanging']) eventBus.on(name, this.onViewChange);
  }

  getIndex() {
    const entries = this.getCitations() || [];
    if (entries !== this.entries) {
      this.entries = entries;
      this.index = citationIndex(entries);
    }
    return this.index;
  }

  updateLink(link) {
    const entries = citationsForDestination(citationDestinationFromHref(link.getAttribute('href')), this.getIndex());
    if (!entries.length) {
      const original = this.original.get(link);
      if (original) {
        restoreAttribute(link, 'title', original.title);
        restoreAttribute(link, 'aria-label', original.label);
        delete link.dataset.pdfCitationKey;
        this.original.delete(link);
      }
      return [];
    }
    if (!this.original.has(link)) this.original.set(link, { title: link.getAttribute('title'), label: link.getAttribute('aria-label') });
    const text = summary(entries);
    link.dataset.pdfCitationKey = entries[0].key;
    link.setAttribute('aria-label', text);
    if (link !== this.activeLink) link.title = text;
    return entries;
  }

  refresh(root = this.container) {
    for (const link of root.querySelectorAll(linkSelector)) this.updateLink(link);
    if (this.activeLink) {
      if (this.activeLink.isConnected && this.container.contains(this.activeLink)) this.show(this.activeLink);
      else this.hide();
    }
  }

  createTooltip() {
    if (this.tooltip) return;
    const tooltip = this.document.createElement('div');
    tooltip.id = `pdf-citation-tooltip-${++nextTooltipId}`;
    tooltip.className = 'pdf-citation-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    const signal = this.abortController.signal;
    tooltip.addEventListener('pointerenter', () => clearTimeout(this.hideTimer), { signal });
    tooltip.addEventListener('pointerleave', () => this.deferHide(), { signal });
    this.document.body.append(tooltip);
    this.tooltip = tooltip;
  }

  show(link) {
    clearTimeout(this.hideTimer);
    if (!this.container.contains(link)) return;
    const entries = this.updateLink(link);
    if (!entries.length) { this.hide(); return; }
    if (link !== this.activeLink) this.hide();
    this.createTooltip();
    this.activeLink = link;
    // The custom tooltip is also available on keyboard focus. Temporarily
    // remove the native title to avoid displaying two popups on pointer hover.
    link.removeAttribute('title');
    const describedBy = new Set((link.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    describedBy.add(this.tooltip.id);
    link.setAttribute('aria-describedby', [...describedBy].join(' '));
    this.tooltip.replaceChildren();
    for (const entry of entries) {
      const item = this.document.createElement('div'); item.className = 'pdf-citation-entry';
      const title = this.document.createElement('strong'); title.textContent = entry.title; item.append(title);
      const authors = details(entry);
      if (authors) { const text = this.document.createElement('p'); text.textContent = authors; item.append(text); }
      const source = this.document.createElement('p'); source.className = 'pdf-citation-source';
      source.textContent = [entry.key, entries.length > 1 ? entry.path : ''].filter(Boolean).join(' · '); item.append(source);
      this.tooltip.append(item);
    }
    this.tooltip.hidden = false;
    const anchor = link.getBoundingClientRect(), popup = this.tooltip.getBoundingClientRect();
    const width = this.window.innerWidth, height = this.window.innerHeight;
    const left = Math.max(8, Math.min(anchor.left, width - popup.width - 8));
    const below = anchor.bottom + 8;
    const top = below + popup.height <= height - 8 ? below : Math.max(8, anchor.top - popup.height - 8);
    this.tooltip.style.left = `${left}px`; this.tooltip.style.top = `${top}px`;
  }

  deferHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.document.activeElement !== this.activeLink && !this.tooltip?.matches(':hover')) this.hide();
    }, 160);
  }

  hide() {
    clearTimeout(this.hideTimer);
    const link = this.activeLink;
    this.activeLink = null;
    if (this.tooltip) this.tooltip.hidden = true;
    if (link) {
      const describedBy = (link.getAttribute('aria-describedby') || '').split(/\s+/).filter(value => value && value !== this.tooltip?.id);
      if (describedBy.length) link.setAttribute('aria-describedby', describedBy.join(' '));
      else link.removeAttribute('aria-describedby');
      this.updateLink(link);
    }
  }

  destroy() {
    this.hide();
    this.abortController.abort();
    this.eventBus.off('annotationlayerrendered', this.onAnnotations);
    for (const name of ['pagesinit', 'pagesdestroy', 'scalechanging', 'pagechanging']) this.eventBus.off(name, this.onViewChange);
    for (const link of this.container.querySelectorAll(linkSelector)) {
      const original = this.original.get(link);
      if (!original) continue;
      restoreAttribute(link, 'title', original.title);
      restoreAttribute(link, 'aria-label', original.label);
      delete link.dataset.pdfCitationKey;
    }
    this.tooltip?.remove();
  }
}
