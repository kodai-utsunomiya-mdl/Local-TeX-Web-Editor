import test from 'node:test';
import assert from 'node:assert/strict';
import { documentDownloadName, extractPDFText, markdownPageDetails, suggestedMarkdownPagePath, textFromPDFItems } from '../web/src/document-conversion.js';
import { renderMarkdownHTML, resolveMarkdownReference } from '../web/src/markdown-preview.js';

test('new Markdown pages use a relative link and keep title characters as text', () => {
  const title = '費用 $x$ [draft] & <tag>';
  const page = markdownPageDetails({ title, path: 'pages/費用 #1% (draft).md', documentPath: 'notes/chapter.md' });
  assert.equal(page.link, '[費用 \\$x\\$ \\[draft\\] &amp; \\<tag\\>](../pages/%E8%B2%BB%E7%94%A8%20%231%25%20%28draft%29.md)');
  const html = renderMarkdownHTML(page.link);
  assert.match(html, /費用 \$x\$ \[draft\] &amp; &lt;tag&gt;<\/a>/);
  assert.doesNotMatch(html, /class="katex"/);
  assert.deepEqual(resolveMarkdownReference(page.link.match(/\]\((.*)\)$/)[1], 'notes/chapter.md'), { kind: 'local', path: 'pages/費用 #1% (draft).md', fragment: '' });
  assert.match(renderMarkdownHTML(page.content), /<h1[^>]*>費用 \$x\$ \[draft\] &amp; &lt;tag&gt;<\/h1>/);
  assert.match(renderMarkdownHTML(markdownPageDetails({ title: 'Title ##', path: 'page.md', documentPath: 'index.md' }).content), />Title ##<\/h1>/);
});

test('new Markdown page names avoid existing paths and reject paths outside the project', () => {
  assert.equal(suggestedMarkdownPagePath('Next page', 'notes/current.md', [{ path: 'notes/Next page.md' }, { path: 'notes/Next page-2.md' }]), 'notes/Next page-3.md');
  assert.equal(suggestedMarkdownPagePath('CON', 'current.md'), 'page-CON.md');
  for (const path of ['../outside.md', '/outside.md', 'C:/outside.md', 'notes/../outside.md', 'notes//a.md', 'notes/a.py', 'notes/bad?.md']) {
    assert.throws(() => markdownPageDetails({ title: 'Title', path, documentPath: 'notes/current.md' }), /markdown-page-path/);
  }
  assert.throws(() => markdownPageDetails({ title: '', path: 'page.md', documentPath: 'current.md' }), /markdown-page-title/);
});

test('PDF text keeps explicit lines, word spaces, and adjacent Japanese characters', () => {
  const item = (str, x, y = 100, width = str.length * 6, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], height: 10, width, hasEOL });
  assert.equal(textFromPDFItems([item('First', 0), item('line', 40, 100, 24, true), item('日本', 0, 80, 20), item('語', 20, 80, 10, true), item('Last', 0, 60)]), 'First line\n日本語\nLast');
  assert.equal(textFromPDFItems([{ type: 'beginMarkedContent' }, { str: 'one', hasEOL: true }, { str: '', hasEOL: true }, { str: 'two' }]), 'one\n\ntwo');
  assert.equal(textFromPDFItems([
    { str: 'Rotated', transform: [0, 10, -10, 0, 100, 100], width: 42, height: 10 },
    { str: 'line', transform: [0, 10, -10, 0, 100, 150], width: 24, height: 10 },
  ]), 'Rotated line');
});

test('PDF extraction visits each page in order and reports progress', async () => {
  const seen = [], progress = [];
  const pdf = { numPages: 3, async getPage(number) { seen.push(number); return { async getTextContent() { return { items: [{ str: `Page ${number}`, hasEOL: true }] }; } }; } };
  const result = await extractPDFText(pdf, { onProgress: (page, total) => progress.push([page, total]) });
  assert.equal(result.text, 'Page 1\n\nPage 2\n\nPage 3\n');
  assert.deepEqual(seen, [1, 2, 3]); assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.equal(documentDownloadName('notes/chapter.tex', 'txt'), 'chapter.txt');
});

test('PDF extraction stops on cancellation, replaced documents, or a text size limit', async () => {
  const controller = new AbortController(); let pages = 0;
  const pdf = { numPages: 10, async getPage() { pages++; return { async getTextContent() { return { items: [{ str: 'text' }] }; } }; } };
  await assert.rejects(extractPDFText(pdf, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(pages, 1);
  await assert.rejects(extractPDFText(pdf, { isCurrent: () => false }), /pdf-document-changed/);
  await assert.rejects(extractPDFText(pdf, { maxBytes: 3 }), /pdf-text-too-large/);
  const empty = await extractPDFText({ numPages: 1, async getPage() { return { async getTextContent() { return { items: [] }; } }; } });
  assert.equal(empty.text, '');
});

test('PDF extraction rejects a document replaced after its final page was read', async () => {
  let current = true;
  const pdf = { numPages: 1, async getPage() { return { async getTextContent() { return { items: [{ str: 'Previous PDF' }] }; } }; } };
  await assert.rejects(extractPDFText(pdf, {
    isCurrent: () => current,
    onProgress: () => { current = false; },
  }), /pdf-document-changed/);
});
