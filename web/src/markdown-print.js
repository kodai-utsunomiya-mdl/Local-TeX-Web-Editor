import createDOMPurify from 'dompurify';
import { renderMarkdownHTML, resolveMarkdownReference } from './markdown-preview.js';
import { t, getLanguage } from './i18n.js';

const imageData = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;
const imageExtensions = /\.(?:png|apng|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

function checkCancelled(signal) {
  if (signal.aborted) throw new DOMException('The print preview was cancelled.', 'AbortError');
}

function duringPrint(promise, signal) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('The print preview was cancelled.', 'AbortError'));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// Use the preview renderer and the browser's existing PDF printer. The document
// receives only rendered content and styles; application controls stay outside.
export async function prepareMarkdownPrint(frame, snapshot, { token, signal, urls }) {
  await new Promise((resolve, reject) => {
    const aborted = () => { frame.onload = null; reject(new DOMException('The print preview was cancelled.', 'AbortError')); };
    signal.addEventListener('abort', aborted, { once: true });
    frame.onload = () => { signal.removeEventListener('abort', aborted); frame.onload = null; resolve(); };
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\'; img-src blob: data:; base-uri \'none\'"></head><body></body></html>';
  });
  checkCancelled(signal);
  const document = frame.contentDocument;
  document.documentElement.lang = getLanguage();
  const article = document.createElement('article');
  article.className = 'markdown-body';
  const purify = createDOMPurify(frame.contentWindow);
  article.append(purify.sanitize(renderMarkdownHTML(snapshot.content), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['srcset', 'formaction'],
    SANITIZE_NAMED_PROPS: true,
  }));
  for (const heading of article.querySelectorAll('[data-markdown-heading]')) heading.id = heading.dataset.markdownHeading;
  for (const link of article.querySelectorAll('a')) {
    const resolved = resolveMarkdownReference(link.getAttribute('href'), snapshot.path);
    link.removeAttribute('target');
    if (resolved?.kind === 'external') { link.href = resolved.href; link.rel = 'noopener noreferrer'; }
    else if (resolved?.kind === 'anchor') link.setAttribute('href', `#${encodeURIComponent(resolved.fragment)}`);
    else { link.removeAttribute('href'); if (resolved?.path) link.title = resolved.path; }
  }
  document.body.append(article);
  const styles = ['/markdown-preview.css', '/katex/katex.min.css', '/markdown-print.css'].map(path => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = path;
    link.onload = resolve;
    link.onerror = () => reject(new Error(t('印刷用のスタイルを読み込めませんでした．もう一度開いてください．')));
    document.head.append(link);
  }));
  await duringPrint(Promise.all(styles), signal);
  checkCancelled(signal);
  const assets = new Map();
  for (const image of article.querySelectorAll('img')) {
    checkCancelled(signal);
    const reference = image.dataset.markdownImage || '';
    image.removeAttribute('src'); image.removeAttribute('srcset'); image.loading = 'eager';
    if (imageData.test(reference)) image.src = reference;
    else {
      const resolved = resolveMarkdownReference(reference, snapshot.path);
      if (resolved?.kind === 'local' && imageExtensions.test(resolved.path)) {
        let url = assets.get(resolved.path);
        if (!url) {
          const response = await fetch(`/api/asset?path=${encodeURIComponent(resolved.path)}`, {
            headers: { 'X-Local-Token': token, 'X-Project-Root': encodeURIComponent(snapshot.projectRoot), 'Accept-Language': getLanguage() },
            signal, cache: 'no-store',
          });
          if (!response.ok) throw new Error(t('画像を読み込めませんでした: {path} (HTTP {status})', { path: resolved.path, status: response.status }));
          const blob = await response.blob();
          checkCancelled(signal);
          if (!blob.type.startsWith('image/')) throw new Error(t('このファイルは画像として表示できません．'));
          url = URL.createObjectURL(blob); urls.add(url); assets.set(resolved.path, url);
        }
        image.src = url;
      } else {
        const replacement = document.createElement(resolved?.kind === 'external' ? 'a' : 'span');
        replacement.textContent = image.alt || reference || t('画像');
        if (resolved?.kind === 'external') replacement.href = resolved.href;
        image.replaceWith(replacement); continue;
      }
    }
    try { await duringPrint(image.decode(), signal); }
    catch { throw new Error(t('画像を表示できませんでした: {path}', { path: reference })); }
  }
  article.getBoundingClientRect();
  await duringPrint(document.fonts.ready, signal);
  checkCancelled(signal);
  return document;
}
