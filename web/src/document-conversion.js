import { relativeAssetPath } from './insert-content.js';

export const maxExtractedTextBytes = 16 * 1024 * 1024;
const encoder = new TextEncoder();

function markdownText(value) {
  return String(value).replace(/\r?\n/g, ' ').replaceAll('&', '&amp;').replace(/[\\[\]`*_<>$~#]/g, character => `\\${character}`);
}

export function suggestedMarkdownPagePath(title, documentPath, files = []) {
  let name = String(title || '').trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/^[ .]+|[ .]+$/g, '').slice(0, 100) || 'page';
  if (!/\.(md|markdown)$/i.test(name)) name += '.md';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\./i.test(name)) name = `page-${name}`;
  const directory = String(documentPath || '').replaceAll('\\', '/').split('/').slice(0, -1).join('/');
  const prefix = directory ? `${directory}/` : '';
  const existing = new Set(files.map(file => String(file.path ?? file).toLowerCase()));
  const extension = name.match(/\.[^.]+$/)[0], base = name.slice(0, -extension.length);
  let candidate = prefix + name, number = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${prefix}${base}-${number++}${extension}`;
  return candidate;
}

export function markdownPageDetails({ title, path, documentPath }) {
  title = String(title || '').trim().replace(/\r?\n/g, ' ');
  path = String(path || '').trim().replaceAll('\\', '/');
  if (!title || title.length > 200) throw new Error('markdown-page-title');
  if (!path || path.length > 240 || !/\.(md|markdown)$/i.test(path) || /^[\/]/.test(path) || /[<>:"|?*\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part))) throw new Error('markdown-page-path');
  const relative = relativeAssetPath(documentPath, path);
  const url = relative.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return { path, content: `# ${markdownText(title)}\n\n`, link: `[${markdownText(title)}](${url})` };
}

// PDF.js reports the reading order and explicit line endings. Position data
// supplies a word space when two adjacent text runs do not include one.
export function textFromPDFItems(items) {
  let text = '', previous = null;
  for (const item of items || []) {
    if (typeof item.str !== 'string') continue;
    const value = item.str.replace(/\u0000/g, '');
    if (value && previous && text && !/\s$/.test(text) && !/^\s/.test(value)
      && item.dir !== 'ttb' && previous.dir !== 'ttb'
      && Array.isArray(item.transform) && Array.isArray(previous.transform)) {
      const height = Math.max(Math.abs(item.height || Math.hypot(item.transform[2], item.transform[3])), Math.abs(previous.height || Math.hypot(previous.transform[2], previous.transform[3])), 1);
      const scale = Math.hypot(previous.transform[0], previous.transform[1]) || 1;
      const directionX = previous.transform[0] / scale, directionY = previous.transform[1] / scale;
      const deltaX = item.transform[4] - previous.transform[4], deltaY = item.transform[5] - previous.transform[5];
      const vertical = Math.abs(deltaX * directionY - deltaY * directionX);
      const advance = deltaX * directionX + deltaY * directionY;
      const gap = item.dir === 'rtl'
        ? -advance - Math.abs(item.width || 0)
        : advance - Math.abs(previous.width || 0);
      if (vertical > height * .8) text += '\n';
      else if (gap > height * .15) text += ' ';
    }
    text += value;
    if (item.hasEOL) { text = text.replace(/[ \t]+$/g, '') + '\n'; previous = null; }
    else if (value) previous = item;
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('The conversion was cancelled.', 'AbortError');
}

export async function extractPDFText(document, { signal, onProgress = () => {}, isCurrent = () => true, maxBytes = maxExtractedTextBytes } = {}) {
  const pages = [];
  let bytes = 0;
  for (let number = 1; number <= document.numPages; number++) {
    checkCancelled(signal);
    if (!isCurrent()) throw new Error('pdf-document-changed');
    const page = await document.getPage(number);
    checkCancelled(signal);
    const content = await page.getTextContent();
    checkCancelled(signal);
    if (!isCurrent()) throw new Error('pdf-document-changed');
    const text = textFromPDFItems(content.items);
    bytes += encoder.encode(text).byteLength + (number > 1 ? 2 : 0);
    if (bytes > maxBytes) throw new Error('pdf-text-too-large');
    pages.push(text);
    onProgress(number, document.numPages);
    // Yield between pages so a long document can be cancelled from the dialog.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  checkCancelled(signal);
  if (!isCurrent()) throw new Error('pdf-document-changed');
  const text = pages.join('\n\n').trim();
  return { text: text ? `${text}\n` : '', pages: pages.length, bytes };
}

export function documentDownloadName(path, extension) {
  const name = String(path || 'document').replaceAll('\\', '/').split('/').pop().replace(/\.[^.]*$/, '') || 'document';
  return `${name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')}.${extension}`;
}
