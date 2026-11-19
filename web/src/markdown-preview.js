import { t, getLanguage, onLanguageChange } from './i18n.js';
import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';
import katex from 'katex';
import texmath from 'markdown-it-texmath';

const markdownExtensions = /\.(?:md|markdown)$/i;
const imageData = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;
const imageExtensions = /\.(?:png|apng|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function isMarkdownPath(path) { return markdownExtensions.test(path || ''); }

// Resolve against the Markdown file, while keeping all local reads inside the
// project. The backend applies the same project boundary to the actual file.
export function resolveMarkdownReference(reference, path = '') {
  const value = String(reference || '').trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^(?:https?:|mailto:)/i.test(value) || value.startsWith('//')) {
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
      return { kind: 'external', href: url.href };
    } catch { return null; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const hash = value.indexOf('#');
  const location = hash < 0 ? value : value.slice(0, hash);
  let fragment;
  try { fragment = hash < 0 ? '' : decodeURIComponent(value.slice(hash + 1)); } catch { return null; }
  if (!location) return { kind: 'anchor', fragment };
  let relative;
  try { relative = decodeURIComponent(location.split('?')[0]).replace(/\\/g, '/'); } catch { return null; }
  if (/[\u0000-\u001f\u007f:]/.test(relative) || relative.startsWith('//')) return null;
  const parts = relative.startsWith('/') ? [] : path.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  const resolved = parts.join('/');
  return resolved ? { kind: 'local', path: resolved, fragment } : null;
}

function headingSlug(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-') || 'section';
}

function sourceAttributes(token) {
  if (!token.map) return '';
  return ` data-source-line="${token.map[0] + 1}" data-source-end-line="${token.map[1] + 1}"`;
}

function makeParser() {
  const parser = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  const mathOptions = { trust: false, throwOnError: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, macros: {} };
  parser.use(texmath, {
    engine: katex,
    delimiters: ['gitlab', 'dollars', 'brackets'],
    katexOptions: mathOptions,
  });
  const renderMath = (content, displayMode) => {
    try { return katex.renderToString(content, { ...mathOptions, displayMode }); }
    catch (error) { return `<span class="katex-error" title="${escapeHTML(error.message)}">${escapeHTML(content)}</span>`; }
  };
  parser.renderer.rules.math_inline = (tokens, index) => renderMath(tokens[index].content, false);
  parser.renderer.rules.math_inline_double = (tokens, index) => renderMath(tokens[index].content, true);
  for (const type of ['math_block', 'math_block_eqno']) parser.renderer.rules[type] = (tokens, index) => {
    const token = tokens[index];
    const number = type === 'math_block_eqno' ? `<span>(${escapeHTML(token.info)})</span>` : '';
    return `<div class="markdown-equation${number ? ' eqno' : ''}"${sourceAttributes(token)}><div>${renderMath(token.content, true)}</div>${number}</div>\n`;
  };
  for (const type of ['fence', 'code_block']) {
    const renderCode = parser.renderer.rules[type];
    parser.renderer.rules[type] = (tokens, index, ...args) => renderCode(tokens, index, ...args)
      .replace('<pre>', `<pre${sourceAttributes(tokens[index])}>`);
  }
  parser.core.ruler.push('preview-headings', state => {
    const headings = new Map();
    for (let index = 0; index < state.tokens.length; ++index) {
      const token = state.tokens[index];
      if (token.map && token.nesting >= 0) {
        token.attrSet('data-source-line', String(token.map[0] + 1));
        token.attrSet('data-source-end-line', String(token.map[1] + 1));
      }
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[index + 1];
      const text = (inline?.children || []).filter(child => !['html_inline', 'image'].includes(child.type)).map(child => child.content).join('');
      const slug = headingSlug(text);
      const count = headings.get(slug) || 0;
      headings.set(slug, count + 1);
      token.attrSet('data-markdown-heading', count ? `${slug}-${count}` : slug);
    }
  });
  // Task checkboxes are read-only in the preview. Their source stays Markdown.
  parser.core.ruler.push('preview-tasks', state => {
    for (let index = 2; index < state.tokens.length; ++index) {
      const inline = state.tokens[index];
      if (inline.type !== 'inline' || state.tokens[index - 1].type !== 'paragraph_open' || state.tokens[index - 2].type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const match = first?.type === 'text' && first.content.match(/^\[([ xX])\]\s+/);
      if (!match) continue;
      first.content = first.content.slice(match[0].length);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'} aria-label="${match[1] === ' ' ? t("未完了") : t("完了")}">`;
      inline.children.unshift(checkbox);
      state.tokens[index - 2].attrJoin('class', 'markdown-task');
    }
  });
  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const reference = token.attrGet('src') || '';
    token.attrSet('data-markdown-image', reference);
    const src = token.attrIndex('src');
    if (src >= 0) token.attrs.splice(src, 1);
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    return defaultImage(tokens, index, options, env, renderer);
  };
  return parser;
}

export function extractMarkdownOutline(content) {
  const tokens = makeParser().parse(String(content || '').replace(/\r\n?/g, '\n'), {});
  const outline = [];
  for (let index = 0; index < tokens.length; ++index) {
    const token = tokens[index];
    if (token.type !== 'heading_open' || !token.map) continue;
    const title = (tokens[index + 1]?.children || []).map(child =>
      ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : child.content).join('').replace(/\s+/g, ' ').trim();
    outline.push({ level: Number(token.tag.slice(1)), title, line: token.map[0] + 1 });
  }
  return outline;
}

// HTML input is escaped by the parser. The view additionally sanitizes this
// output before adding it to the page, including the math renderer's output.
export function renderMarkdownHTML(content) {
  return makeParser().render(String(content || '').replace(/\r\n?/g, '\n'));
}

export class MarkdownPreview {
  constructor({ container, token, onOpenFile, onSourceLine, onError }) {
    if (!container) throw new Error(t("Markdown の表示先がありません．"));
    this.container = container;
    this.token = token;
    this.onOpenFile = onOpenFile;
    this.onSourceLine = onSourceLine;
    this.onError = onError;
    this.document = container.ownerDocument;
    this.window = this.document.defaultView;
    this.purify = createDOMPurify(this.window);
    this.article = this.document.createElement('article');
    this.article.className = 'markdown-body';
    this.article.dataset.testid = 'markdown-document';
    this.container.classList.add('markdown-preview');
    this.container.dataset.testid = 'markdown-preview';
    this.container.setAttribute('aria-label', t("Markdown プレビュー"));
    this.container.setAttribute('tabindex', '0');
    this.container.append(this.article);
    this.current = null;
    this.rendered = null;
    this.timer = null;
    this.generation = 0;
    this.images = new Map();
    this.imageSizes = new Map();
    this.positions = new Map();
    this.observer = null;
    this.controllers = new Set();
    this.linePositions = null;
    this.scrollSync = true;
    this.sourceTarget = null;
    this.sourcePosition = null;
    this.sourceFrame = null;
    this.highlighted = null;
    this.highlightTimer = null;
    this.layoutObserver = this.window.ResizeObserver ? new this.window.ResizeObserver(() => {
      this.linePositions = null;
      this.queueSourceScroll();
    }) : null;
    this.layoutObserver?.observe(this.container);
    this.layoutObserver?.observe(this.article);
    this.manualScroll = event => {
      if (event.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
      this.sourceTarget = null;
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) this.container.addEventListener(type, this.manualScroll, { passive: true });
    this.linkClick = event => this.openLink(event);
    this.doubleClick = event => {
      if (!this.onSourceLine || event.target.closest('a, input, button')) return;
      const block = event.target.closest('[data-source-line]');
      if (block && this.current) this.onSourceLine(Number(block.dataset.sourceLine), this.current.path);
    };
    this.container.addEventListener('click', this.linkClick);
    this.container.addEventListener('dblclick', this.doubleClick);
    this.unsubscribeLanguage = onLanguageChange(() => this.refreshLanguage());
  }

  refreshLanguage() {
    this.container.setAttribute('aria-label', t('Markdown プレビュー'));
    if (this.article.classList.contains('is-empty')) this.article.textContent = t('Markdown を入力すると，ここに表示されます．');
    for (const input of this.article.querySelectorAll('.markdown-task > input')) input.setAttribute('aria-label', t(input.checked ? '完了' : '未完了'));
    for (const link of this.article.querySelectorAll('a.markdown-image-link')) link.title = t('画像をブラウザで開く');
    for (const label of this.article.querySelectorAll('span.markdown-image-link')) label.title = t('画像のパスを確認してください．');
  }

  key(value = this.current) { return value ? `${value.projectRoot}\n${value.path}` : ''; }

  rememberPosition() {
    if (!this.current) return;
    this.positions.set(this.key(), { top: this.container.scrollTop, left: this.container.scrollLeft });
    while (this.positions.size > 50) this.positions.delete(this.positions.keys().next().value);
  }

  show() {
    if (!this.container.hidden) return;
    this.container.hidden = false;
    if (this.current && this.rendered !== this.current) this.render();
  }

  hide() {
    if (this.container.hidden) return;
    this.rememberPosition();
    this.sourceTarget = null;
    this.sourcePosition = null;
    this.clearHighlight();
    this.container.hidden = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.releaseImages();
    this.rendered = null;
  }

  reset() {
    this.hide();
    this.releaseImages();
    this.current = null;
    this.rendered = null;
    this.positions.clear();
    this.imageSizes.clear();
    this.linePositions = null;
    this.article.replaceChildren();
    delete this.container.dataset.path;
    this.container.dataset.state = 'idle';
  }

  update(content, { path, projectRoot, immediate = false, fragment = '' } = {}) {
    const next = { content: String(content || ''), path: path || '', projectRoot: projectRoot || '', fragment };
    const changedDocument = this.key(next) !== this.key();
    if (!changedDocument && this.current?.content === next.content && !fragment && this.rendered === this.current) return;
    if (changedDocument) {
      this.rememberPosition();
      this.sourceTarget = null;
      this.sourcePosition = null;
      this.clearHighlight();
    }
    this.current = next;
    clearTimeout(this.timer);
    this.timer = null;
    this.container.dataset.path = next.path;
    this.container.dataset.state = 'updating';
    if (this.container.hidden) return;
    if (immediate || changedDocument) this.render();
    else this.timer = setTimeout(() => { this.timer = null; this.render(); }, 160);
  }

  refresh() {
    if (!this.current) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.releaseImages();
    this.render();
  }

  releaseImages({ keepLoaded = false } = {}) {
    ++this.generation;
    this.observer?.disconnect();
    this.observer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const image of this.article.querySelectorAll('img')) image.removeAttribute('src');
    for (const [path, image] of this.images) {
      if (keepLoaded && image.url) continue;
      if (image.url) this.window.URL.revokeObjectURL(image.url);
      this.images.delete(path);
    }
  }

  render() {
    const current = this.current;
    if (!current || this.container.hidden) return;
    const sameDocument = this.key(this.rendered) === this.key(current);
    const position = sameDocument ? { top: this.container.scrollTop, left: this.container.scrollLeft } : this.positions.get(this.key(current));
    this.releaseImages({ keepLoaded: sameDocument });
    try {
      const html = renderMarkdownHTML(current.content);
      const fragment = this.purify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
        FORBID_ATTR: ['srcset', 'formaction'],
        SANITIZE_NAMED_PROPS: true,
      });
      this.prepareLinks(fragment, current.path);
      this.prepareImages(fragment, current);
      const imagePaths = new Set([...fragment.querySelectorAll('[data-markdown-local-image]')].map(image => image.dataset.markdownLocalImage));
      for (const [path, image] of this.images) if (!imagePaths.has(path)) {
        if (image.url) this.window.URL.revokeObjectURL(image.url);
        this.images.delete(path);
      }
      this.article.replaceChildren(fragment);
      this.linePositions = null;
      this.clearHighlight();
      this.article.classList.toggle('is-empty', !current.content.trim());
      if (!current.content.trim()) this.article.textContent = t("Markdown を入力すると，ここに表示されます．");
      this.rendered = current;
      this.container.scrollTop = position?.top || 0;
      this.container.scrollLeft = position?.left || 0;
      this.container.dataset.state = 'ready';
      this.observeImages(current);
      if (current.fragment) this.scrollToHeading(current.fragment);
      else this.queueSourceScroll();
    } catch (error) {
      this.releaseImages();
      this.container.dataset.state = 'error';
      this.article.textContent = t("Markdown を表示できませんでした．{value0}", { value0: error.message || error });
      this.onError?.(error);
    }
  }

  setScrollSync(enabled) {
    this.scrollSync = Boolean(enabled);
    if (!this.scrollSync) {
      this.sourceTarget = null;
      this.sourcePosition = null;
    }
  }

  matchesSource({ path = this.current?.path, projectRoot = this.current?.projectRoot } = {}) {
    return Boolean(this.current && this.current.path === path && this.current.projectRoot === projectRoot
      && !this.container.hidden && this.container.clientHeight && this.container.getClientRects().length);
  }

  measureLines() {
    if (this.linePositions) return this.linePositions;
    const containerTop = this.container.getBoundingClientRect().top;
    const topOf = rectangle => rectangle.top - containerTop + this.container.scrollTop - this.container.clientTop;
    const lineCount = this.current.content.replace(/\r\n?/g, '\n').split('\n').length;
    const blocks = [];
    const nodes = new Set();
    for (const element of this.article.querySelectorAll('[data-source-line]')) {
      const node = element.tagName === 'CODE' && element.parentElement?.tagName === 'PRE' ? element.parentElement : element;
      if (nodes.has(node)) continue;
      const start = Number(element.dataset.sourceLine);
      const end = Number(element.dataset.sourceEndLine);
      const rectangle = node.getBoundingClientRect();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !rectangle.height) continue;
      nodes.add(node);
      blocks.push({ node, start, end, top: topOf(rectangle), bottom: topOf(rectangle) + rectangle.height });
    }
    const article = this.article.getBoundingClientRect();
    const positions = new Map([
      [1, { line: 1, top: topOf(article), priority: 0 }],
      [lineCount + 1, { line: lineCount + 1, top: topOf(article) + article.height, priority: 0 }],
    ]);
    for (const block of blocks) {
      // A nested block starts closer to its text than its list or table wrapper.
      // Start positions also account for the margin after the preceding block.
      for (const [line, top, priority] of [[block.start, block.top, 2], [block.end, block.bottom, 1]]) {
        const previous = positions.get(line);
        if (!previous || previous.priority <= priority) positions.set(line, { line, top, priority });
      }
    }
    const anchors = [...positions.values()].sort((a, b) => a.line - b.line);
    for (let index = 1; index < anchors.length; ++index) anchors[index].top = Math.max(anchors[index - 1].top, anchors[index].top);
    this.linePositions = { blocks, anchors, lineCount };
    return this.linePositions;
  }

  locateLine(value) {
    const { blocks, anchors, lineCount } = this.measureLines();
    const line = Math.min(lineCount + 1, Math.max(1, Number(value) || 1));
    let lower = anchors[0], upper = anchors.at(-1);
    for (const anchor of anchors) {
      if (anchor.line <= line) lower = anchor;
      if (anchor.line >= line) { upper = anchor; break; }
    }
    const fraction = upper.line > lower.line ? (line - lower.line) / (upper.line - lower.line) : 0;
    const top = lower.top + fraction * (upper.top - lower.top);
    let block = null;
    for (const candidate of blocks) {
      if (candidate.start <= line && line < candidate.end && (!block || candidate.end - candidate.start <= block.end - block.start)) block = candidate;
    }
    if (!block) block = blocks.find(candidate => candidate.start >= line) || blocks.at(-1);
    return { top, node: block?.node };
  }

  revealSourceLine(line, { path, projectRoot, align = 'center', highlight = true } = {}) {
    if (!this.matchesSource({ path, projectRoot }) || !Number.isFinite(Number(line))) return false;
    this.sourceTarget = null;
    return this.scrollSourceLine(line, { align, highlight });
  }

  syncSourceLine(line, { path, projectRoot } = {}) {
    if (!this.scrollSync || !this.matchesSource({ path, projectRoot }) || !Number.isFinite(Number(line))) {
      this.sourceTarget = null;
      this.sourcePosition = null;
      return false;
    }
    const target = { line: Number(line), path: this.current.path, projectRoot: this.current.projectRoot };
    // Editing can report the same editor position after the user has scrolled
    // the preview. Follow again when the editor actually moves.
    if (!this.sourceTarget && this.sourcePosition?.path === target.path
      && this.sourcePosition.projectRoot === target.projectRoot
      && Math.abs(this.sourcePosition.line - target.line) < 0.0001) return false;
    this.sourceTarget = target;
    this.sourcePosition = target;
    if (this.rendered !== this.current) return true;
    return this.scrollSourceLine(line, { align: 'start', highlight: false });
  }

  scrollSourceLine(line, { align, highlight }) {
    if (this.rendered !== this.current) {
      clearTimeout(this.timer);
      this.timer = null;
      this.render();
    }
    if (this.container.dataset.state !== 'ready') return false;
    const location = this.locateLine(line);
    const padding = parseFloat(this.window.getComputedStyle(this.container).paddingTop) || 0;
    const offset = align === 'center' ? this.container.clientHeight / 2 : padding;
    const top = Math.max(0, Math.min(this.container.scrollHeight - this.container.clientHeight, location.top - offset));
    this.container.scrollTo({ top, behavior: 'instant' });
    if (highlight) {
      this.clearHighlight();
      if (location.node) {
        this.highlighted = location.node;
        this.highlighted.classList.add('markdown-source-highlight');
        this.highlightTimer = this.window.setTimeout(() => this.clearHighlight(), 2600);
      }
    }
    return true;
  }

  queueSourceScroll() {
    if (!this.scrollSync || !this.sourceTarget || this.sourceFrame !== null) return;
    this.sourceFrame = this.window.requestAnimationFrame(() => {
      this.sourceFrame = null;
      const target = this.sourceTarget;
      if (this.scrollSync && target && this.rendered === this.current && this.matchesSource(target)) this.scrollSourceLine(target.line, { align: 'start', highlight: false });
    });
  }

  clearHighlight() {
    this.window.clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.highlighted?.classList.remove('markdown-source-highlight');
    this.highlighted = null;
  }

  prepareLinks(fragment, path) {
    for (const link of fragment.querySelectorAll('a')) {
      const resolved = resolveMarkdownReference(link.getAttribute('href'), path);
      link.removeAttribute('target');
      if (!resolved) { link.removeAttribute('href'); continue; }
      if (resolved.kind === 'external') {
        link.href = resolved.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.referrerPolicy = 'no-referrer';
      } else {
        link.href = '#';
        if (resolved.kind === 'local') link.dataset.markdownPath = resolved.path;
        link.dataset.markdownFragment = resolved.fragment;
      }
    }
  }

  prepareImages(fragment, current) {
    for (const image of fragment.querySelectorAll('img')) {
      const reference = image.dataset.markdownImage || '';
      image.removeAttribute('src');
      image.removeAttribute('srcset');
      if (imageData.test(reference)) { image.src = reference; continue; }
      const resolved = resolveMarkdownReference(reference, current.path);
      if (resolved?.kind === 'local' && imageExtensions.test(resolved.path)) {
        image.dataset.markdownLocalImage = resolved.path;
        const cached = this.images.get(resolved.path);
        const size = this.imageSizes.get(`${current.projectRoot}\n${resolved.path}`);
        if (size) this.setImageSize(image, size);
        if (cached?.url) {
          image.src = cached.url;
          if (cached.width && cached.height) this.setImageSize(image, cached);
          image.dataset.state = 'ready';
        } else image.dataset.state = 'loading';
        continue;
      }
      const replacement = this.document.createElement(resolved?.kind === 'external' ? 'a' : 'span');
      replacement.className = 'markdown-image-link';
      replacement.textContent = image.alt || reference || t("画像");
      if (resolved?.kind === 'external') {
        replacement.href = resolved.href;
        replacement.target = '_blank';
        replacement.rel = 'noopener noreferrer';
        replacement.title = t("画像をブラウザで開く");
      } else replacement.title = t("画像のパスを確認してください．");
      image.replaceWith(replacement);
    }
  }

  setImageSize(image, { width, height }) {
    image.width = width;
    image.height = height;
    let frame = image.parentElement;
    if (!frame?.classList.contains('markdown-image-frame')) {
      frame = this.document.createElement('span');
      frame.className = 'markdown-image-frame';
      image.replaceWith(frame);
      frame.append(image);
    }
    // An img without a src may lay out its alt text even when width/height are set.
    // Give the surrounding box the known dimensions before the next asset arrives.
    frame.style.width = `${width}px`;
    frame.style.aspectRatio = `${width} / ${height}`;
  }

  observeImages(current) {
    const generation = this.generation;
    const images = [...this.article.querySelectorAll('[data-markdown-local-image][data-state="loading"]')];
    if (!this.window.IntersectionObserver) { for (const image of images) this.loadImage(image, current, generation); return; }
    this.observer = new this.window.IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.observer?.unobserve(entry.target);
        this.loadImage(entry.target, current, generation);
      }
    }, { root: this.container, rootMargin: '600px' });
    for (const image of images) this.observer.observe(image);
  }

  async loadImage(image, current, generation) {
    const path = image.dataset.markdownLocalImage;
    let asset = this.images.get(path);
    if (!asset) {
      const controller = new AbortController();
      this.controllers.add(controller);
      asset = { url: null, promise: null };
      this.images.set(path, asset);
      asset.promise = (async () => {
        const response = await this.window.fetch(`/api/asset?path=${encodeURIComponent(path)}`, {
          headers: { 'X-Local-Token': this.token, 'X-Project-Root': encodeURIComponent(current.projectRoot), 'Accept-Language': getLanguage() },
          signal: controller.signal, cache: 'no-store',
        });
        if (!response.ok) {
          let error;
          try { error = (await response.json()).error; } catch { /* The status below describes non-JSON responses. */ }
          throw new Error(error || t("画像を取得できませんでした (HTTP {value0})．", { value0: response.status }));
        }
        const blob = await response.blob();
        if (generation !== this.generation) return null;
        if (!blob.type.startsWith('image/')) throw new Error(t("このファイルは画像として表示できません．"));
        asset.url = this.window.URL.createObjectURL(blob);
        return asset.url;
      })().finally(() => this.controllers.delete(controller));
    }
    try {
      const url = await asset.promise;
      if (!url || generation !== this.generation || !image.isConnected) return;
      image.src = url;
      await image.decode();
      if (generation !== this.generation || !image.isConnected) return;
      asset.width = image.naturalWidth;
      asset.height = image.naturalHeight;
      this.setImageSize(image, asset);
      this.linePositions = null;
      this.queueSourceScroll();
      this.imageSizes.set(`${current.projectRoot}\n${path}`, { width: asset.width, height: asset.height });
      while (this.imageSizes.size > 200) this.imageSizes.delete(this.imageSizes.keys().next().value);
      image.dataset.state = 'ready';
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      image.dataset.state = 'error';
      image.title = `${path}\n${error.message || error}`;
      if (!image.alt) image.alt = path;
    }
  }

  scrollToHeading(fragment) {
    this.sourceTarget = null;
    const value = fragment.replace(/^user-content-/, '');
    const heading = [...this.article.querySelectorAll('[data-markdown-heading]')].find(node => node.dataset.markdownHeading === value);
    if (heading) heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else if (!value) this.container.scrollTo({ top: 0, behavior: 'smooth' });
  }

  openLink(event) {
    const link = event.target.closest('a');
    if (!link || !this.container.contains(link) || !link.hasAttribute('data-markdown-fragment')) return;
    event.preventDefault();
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const path = link.dataset.markdownPath;
    const fragment = link.dataset.markdownFragment;
    if (!path || path === this.current?.path) { this.scrollToHeading(fragment); return; }
    if (this.onOpenFile) Promise.resolve().then(() => this.onOpenFile(path, { fragment })).catch(error => this.onError?.(error));
  }

  destroy() {
    this.unsubscribeLanguage?.();
    this.reset();
    this.layoutObserver?.disconnect();
    if (this.sourceFrame !== null) this.window.cancelAnimationFrame(this.sourceFrame);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) this.container.removeEventListener(type, this.manualScroll);
    this.container.removeEventListener('click', this.linkClick);
    this.container.removeEventListener('dblclick', this.doubleClick);
    this.article.remove();
  }
}
