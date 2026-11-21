import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const text = '# Zoom notes\n\n' + Array.from({ length: 70 }, (_, index) => `Paragraph ${index + 1}: Keep this passage visible while changing the text size in either editor pane.\n\n`).join('');
const rich = (page, pane = 'primary') => page.locator(`#markdown-rich-${pane} .markdown-rich-document`);
const fontSize = locator => locator.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await use(errors); expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Zoom notes' });

async function openNotes(page, session) {
  const file = path.join(session.project, 'notes.md'); await writeFile(file, text);
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId('file-notes.md').click(); await expect(rich(page)).toBeVisible();
  return file;
}
async function wheel(page, point, deltaY) {
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down(modifier); await page.mouse.wheel(0, deltaY); await page.keyboard.up(modifier);
}
async function sourceComposition(source, type) {
  await source.evaluate((element, type) => {
    // CodeMirror receives composition events on EditContext when enabled,
    // and on the content element in the usual desktop input path.
    (element.editContext || element).dispatchEvent(new CompositionEvent(type, { bubbles: true, data: '' }));
  }, type);
}

test('直接編集の文字サイズを保存し，選択と Undo を続けてソース編集にも同じ設定を使う', async ({ page, session }) => {
  const file = await openNotes(page, session);
  const paragraph = rich(page).locator('p').filter({ hasText: 'Paragraph 35:' });
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 'Paragraph 35'.length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.closest('.ProseMirror').focus();
  });
  await page.keyboard.press(`${modifier}+b`); await expect(paragraph.locator('strong')).toHaveText('Paragraph 35');
  const before = await page.evaluate(() => {
    const selection = window.getSelection(); window.zoomRange = selection.getRangeAt(0).cloneRange(); zoomRange.collapse(true);
    const box = zoomRange.getBoundingClientRect();
    return { selection: selection.toString(), top: box.top, x: box.left + 2, y: (box.top + box.bottom) / 2, scale: window.visualViewport.scale };
  });
  const initial = await fontSize(rich(page)); await wheel(page, before, -80);
  await expect.poll(() => fontSize(rich(page))).toBeGreaterThan(initial);
  const enlarged = await fontSize(rich(page));
  expect(await page.evaluate(() => window.getSelection().toString())).toBe(before.selection);
  expect(Math.abs(await page.evaluate(() => zoomRange.getBoundingClientRect().top) - before.top)).toBeLessThan(2);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(before.scale);
  await page.keyboard.press(`${modifier}+z`); await expect(paragraph.locator('strong')).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+z`); await expect(paragraph.locator('strong')).toHaveText('Paragraph 35');
  await page.keyboard.press(`${modifier}+z`);
  await page.keyboard.press(`${modifier}+s`); await expect.poll(() => readFile(file, 'utf8')).toBe(text);
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.editorFontSize).toBe(enlarged);
  await page.reload(); await expect(rich(page)).toBeVisible();
  await expect.poll(() => fontSize(rich(page))).toBe(enlarged);

  await page.locator('#markdown-editor-mode').selectOption('source');
  const scroller = page.getByTestId('editor').locator('.cm-scroller'); await expect(scroller).toBeVisible();
  await expect.poll(() => fontSize(scroller)).toBe(enlarged);
  const bounds = await scroller.boundingBox(); await wheel(page, { x: bounds.x + 150, y: bounds.y + 80 }, -60);
  await expect.poll(() => fontSize(scroller)).toBeGreaterThan(enlarged);
  const sourceSize = await fontSize(scroller);
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value?.editorFontSize).toBe(sourceSize);
  await page.locator('#markdown-editor-mode').selectOption('rich');
  await expect.poll(() => fontSize(rich(page))).toBe(sourceSize);
  await page.keyboard.press(`${modifier}+s`); expect(await readFile(file, 'utf8')).toBe(text);
});

test('別のペインで拡大してもプレビューとフォーカスを変えず，両方の本文位置を合わせて IME 中は待つ', async ({ page, session }) => {
  const file = await openNotes(page, session);
  await page.locator('#markdown-editor-mode').selectOption('source');
  await page.locator('#split-editors').click();
  await page.locator('#secondary-document').selectOption('notes.md');
  await expect(rich(page, 'secondary')).toBeVisible();
  const source = page.getByTestId('editor').locator('.cm-content'); await source.click();
  await expect(page.locator('#markdown-editor-mode')).toHaveValue('source');
  await expect(page.locator('#toggle-preview')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('editor').locator('.cm-scroller').evaluate(element => { element.scrollTop = 900; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const point = await page.evaluate(() => {
    const definitions = [
      { root: '#editor .cm-scroller', selector: '#editor .cm-line', rich: false },
      { root: '#markdown-rich-secondary', selector: '#markdown-rich-secondary p', rich: true },
    ];
    for (const definition of definitions) {
      const host = document.querySelector(definition.root), box = host.getBoundingClientRect();
      const candidates = [...document.querySelectorAll(definition.selector)];
      const line = definition.rich ? candidates[34] : candidates.find(element => element.textContent.startsWith('Paragraph ') && element.getBoundingClientRect().top >= box.top + 20);
      if (!line) throw new Error('The passage to anchor was not visible.');
      host.scrollTop += line.getBoundingClientRect().top - box.top - 40;
    }
    window.zoomAnchors = definitions.map(definition => {
      const box = document.querySelector(definition.root).getBoundingClientRect(), x = (box.left + box.right) / 2, y = box.top + 60;
      const range = document.caretRangeFromPoint(x, y), element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      const line = element.closest(definition.rich ? 'p' : '.cm-line');
      if (!line?.textContent) throw new Error('The pointer must be over a passage.');
      const prefix = document.createRange(); prefix.selectNodeContents(line); prefix.setEnd(range.startContainer, range.startOffset);
      return { ...definition, text: line.textContent, offset: prefix.toString().length, top: range.getBoundingClientRect().top, x, y };
    });
    const last = zoomAnchors.at(-1); return { x: last.x, y: last.y };
  });
  const initial = await fontSize(rich(page, 'secondary'));
  await wheel(page, point, -70);
  await expect.poll(() => fontSize(rich(page, 'secondary'))).toBeGreaterThan(initial);
  const enlarged = await fontSize(rich(page, 'secondary'));
  await expect.poll(() => fontSize(page.getByTestId('editor').locator('.cm-scroller'))).toBe(enlarged);
  await expect(source).toBeFocused();
  await expect(page.locator('#source-pane-primary')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#markdown-editor-mode')).toHaveValue('source');
  await expect(page.locator('#toggle-preview')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => Math.max(...zoomAnchors.map(saved => {
    const line = [...document.querySelectorAll(saved.selector)].find(element => element.textContent === saved.text);
    if (!line) return 10000;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT); let node, offset = saved.offset;
    while ((node = walker.nextNode())) {
      if (offset > node.textContent.length) { offset -= node.textContent.length; continue; }
      const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
      return Math.abs(range.getBoundingClientRect().top - saved.top);
    }
    return 10000;
  })))).toBeLessThan(3);

  await sourceComposition(source, 'compositionstart');
  for (const editor of [source, rich(page, 'secondary')]) {
    await editor.evaluate((element, point) => element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: point.x, clientY: point.y,
    })), point);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await fontSize(rich(page, 'secondary'))).toBe(enlarged);
  expect(await fontSize(page.getByTestId('editor').locator('.cm-scroller'))).toBe(enlarged);
  await sourceComposition(source, 'compositionend');
  await wheel(page, point, -10);
  await expect.poll(() => fontSize(rich(page, 'secondary'))).toBeGreaterThan(enlarged);
  expect(await readFile(file, 'utf8')).toBe(text);
});
