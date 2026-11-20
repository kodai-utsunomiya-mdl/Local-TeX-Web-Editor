import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, json, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const mode = page => page.locator('#markdown-editor-mode');
const rich = (page, secondary = false) => page.locator(`#markdown-rich-${secondary ? 'secondary' : 'primary'} .ProseMirror`);
const source = (page, secondary = false) => page.getByTestId(secondary ? 'editor-secondary' : 'editor').locator('.cm-content');
const sourceText = async (page, secondary = false) => (await source(page, secondary).locator('.cm-line').allTextContents()).join('\n');

const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Research notes' });

const originalParagraph = 'We compare a regularized linear model with the current baseline.';
const originalMarkdown = [
  '# Research notes',
  '',
  originalParagraph,
  '',
  '## Model',
  '',
  '$$',
  '\\mathcal{L}(w) = \\frac{1}{2n}\\|Xw-y\\|^2 + \\frac{\\lambda}{2}\\|w\\|^2.',
  '$$',
  '',
  '## Experiment plan',
  '',
  '- [x] Prepare the training data',
  '- [x] Record the baseline',
  '- [ ] Compare three values of the regularization parameter',
  '',
  '## Results',
  '',
  '| Model | Validation error | Next step |',
  '| --- | ---: | --- |',
  '| Baseline | 0.142 | Recorded |',
  '| Regularized model | 0.128 | Repeat with three seeds |',
  '',
  '> Keep preprocessing identical for every run.',
  '> Compare residuals on the same validation split.',
  '',
  '<!-- Keep this comment in the source. -->',
  '',
  '~~~python',
  'print("original")',
  '~~~',
  '',
  '[paper]: https://example.org/paper "Original title"',
  '',
].join('\n');

async function openMarkdown(page, session, text = originalMarkdown, name = 'notes.md') {
  const file = path.join(session.project, name);
  await writeFile(file, text);
  await openProject(session);
  await openEditor(page, session);
  await setAutoSave(page, false);
  await page.getByTestId(`file-${name}`).click();
  await expect(mode(page)).toHaveValue('rich');
  await expect(rich(page)).toBeVisible();
  return file;
}

async function appendToParagraph(page, text, addition, secondary = false) {
  const paragraph = rich(page, secondary).locator('p').filter({ hasText: text }).first();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(addition);
  await expect(paragraph).toHaveText(text + addition);
}

async function expectPreview(page, visible) {
  await expect(page.locator('#toggle-preview')).toHaveAttribute('aria-pressed', String(visible));
  if (visible) {
    await expect(page.locator('#app-shell')).not.toHaveClass(/\bpreview-hidden\b/);
    await expect(page.locator('#pdf-pane')).toBeVisible();
  } else {
    await expect(page.locator('#app-shell')).toHaveClass(/\bpreview-hidden\b/);
    await expect(page.locator('#pdf-pane')).toBeHidden();
  }
}

async function saveMarkdown(page, file, text) {
  await page.keyboard.press(`${modifier}+s`);
  await expect.poll(() => readFile(file, 'utf8')).toBe(text);
}

test('Markdown は直接編集で開き，ソースと往復しても元の記法が続く', async ({ page, session }, testInfo) => {
  const file = await openMarkdown(page, session);
  await expect(source(page)).toBeHidden();
  await expectPreview(page, false);
  await expect(rich(page).getByRole('heading', { name: 'Research notes', exact: true })).toBeVisible();
  await expect(rich(page).locator('table')).toBeVisible();
  await expect(rich(page).locator('.katex').first()).toBeVisible();
  await expect(page.locator('#toast')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('markdown-direct-editing.png') });

  await mode(page).selectOption('source');
  await expect(source(page)).toBeVisible();
  await expect(rich(page)).toBeHidden();
  await expectPreview(page, true);
  await expect(page.getByTestId('markdown-preview')).toBeVisible();
  await expect.poll(() => sourceText(page)).toBe(originalMarkdown);

  await mode(page).selectOption('rich');
  await expect(rich(page)).toBeVisible();
  await expectPreview(page, false);
  await mode(page).selectOption('source');
  await expect.poll(() => sourceText(page)).toBe(originalMarkdown);
  await saveMarkdown(page, file, originalMarkdown);
});

test('段落を直接編集して保存し，再読み込み後も本文と編集していない記法が一致する', async ({ page, session }) => {
  const file = await openMarkdown(page, session);
  const addition = ' The next run will use the same train and validation split.';
  const expected = originalMarkdown.replace(originalParagraph, originalParagraph + addition);
  await appendToParagraph(page, originalParagraph, addition);
  await saveMarkdown(page, file, expected);

  await page.reload();
  await expect(mode(page)).toHaveValue('rich');
  await expect(rich(page)).toBeVisible();
  await expect(rich(page).locator('p').filter({ hasText: originalParagraph }).first()).toHaveText(originalParagraph + addition);
  await expectPreview(page, false);
  await mode(page).selectOption('source');
  await expect.poll(() => sourceText(page)).toBe(expected);
  expect(await readFile(file, 'utf8')).toBe(expected);
});

test('直接編集とソースの両方から同じ文書の Undo と Redo を使える', async ({ page, session }) => {
  const initial = '# Notes\n\nFirst paragraph.\n';
  const file = await openMarkdown(page, session, initial);
  const afterParagraph = initial.replace('First paragraph.', 'First paragraph. Edited in the rich view.');
  await appendToParagraph(page, 'First paragraph.', ' Edited in the rich view.');
  await mode(page).selectOption('source');
  await source(page).press(`${modifier}+z`);
  await expect.poll(() => sourceText(page)).toBe(initial);
  await source(page).press(`${modifier}+Shift+Z`);
  await expect.poll(() => sourceText(page)).toBe(afterParagraph);

  await mode(page).selectOption('rich');
  await rich(page).getByRole('heading', { name: 'Notes', exact: true }).click();
  await page.keyboard.press('End');
  await rich(page).press(`${modifier}+z`);
  await expect(rich(page).locator('p')).toHaveText('First paragraph.');
  await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest('p')?.textContent)).toBe('First paragraph.');
  await rich(page).press(`${modifier}+Shift+Z`);
  await expect(rich(page).locator('p')).toHaveText('First paragraph. Edited in the rich view.');

  await mode(page).selectOption('source');
  await source(page).press(`${modifier}+Home`);
  await page.keyboard.press('End');
  await page.keyboard.insertText(' revised');
  const afterHeading = afterParagraph.replace('# Notes', '# Notes revised');
  await expect.poll(() => sourceText(page)).toBe(afterHeading);
  await mode(page).selectOption('rich');
  await expect(rich(page).getByRole('heading', { name: 'Notes revised', exact: true })).toBeVisible();
  await rich(page).press(`${modifier}+z`);
  await expect(rich(page).getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
  await mode(page).selectOption('source');
  await source(page).press(`${modifier}+Shift+Z`);
  await expect.poll(() => sourceText(page)).toBe(afterHeading);
  await saveMarkdown(page, file, afterHeading);
});

test('プレビューの開閉を編集モードごとに記録し，TeX では最初からプレビューを表示する', async ({ page, session }) => {
  await openMarkdown(page, session, '# Notes\n\nPreview preferences.\n');
  await expectPreview(page, false);
  await page.locator('#toggle-preview').click();
  await expectPreview(page, true);
  await expect(page.locator('#markdown-scroll-sync')).toBeHidden();
  await mode(page).selectOption('source');
  await expectPreview(page, true);
  await expect(page.locator('#markdown-scroll-sync')).toBeVisible();
  await page.locator('#toggle-preview').click();
  await expectPreview(page, false);
  await mode(page).selectOption('rich');
  await expectPreview(page, true);
  await mode(page).selectOption('source');
  await expectPreview(page, false);

  await page.locator('#editor-tabs .tab-select[data-path="main.tex"]').click();
  await expectPreview(page, true);
  await expect(page.locator('#pdf-preview')).toBeVisible();
  await page.locator('#editor-tabs .tab-select[data-path="notes.md"]').click();
  await expect(mode(page)).toHaveValue('source');
  await expectPreview(page, false);
  await expect.poll(async () => (await json(session, '/api/storage?key=preferences')).value).toMatchObject({
    markdownEditorModes: { primary: 'source' }, previewVisibility: { rich: true, markdown: false, source: true },
  });

  await page.reload();
  await expect(mode(page)).toHaveValue('source');
  await expect(source(page)).toBeVisible();
  await expectPreview(page, false);
  await mode(page).selectOption('rich');
  await expect(rich(page)).toBeVisible();
  await expectPreview(page, true);
  await page.locator('#editor-tabs .tab-select[data-path="main.tex"]').click();
  await expectPreview(page, true);
});

test('同じ Markdown を 2 つのペインでソースと直接編集にし，両方の変更を反映する', async ({ page, session }, testInfo) => {
  const initial = '# Shared notes\n\nText shared between panes.\n';
  const file = await openMarkdown(page, session, initial);
  await mode(page).selectOption('source');
  await page.locator('#split-editors').click();
  await page.locator('#primary-document').selectOption('notes.md');
  await page.locator('#secondary-document').selectOption('notes.md');
  await expect(mode(page)).toHaveValue('rich');
  await expect(source(page)).toBeVisible();
  await expect(rich(page, true)).toBeVisible();
  await expect(source(page, true)).toBeHidden();
  await expect(rich(page)).toBeHidden();

  const changedSource = '# Shared notes\n\nChanged in the source pane.\n';
  await source(page).click();
  await expect(mode(page)).toHaveValue('source');
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(changedSource);
  await expect(rich(page, true).locator('p')).toHaveText('Changed in the source pane.');
  await appendToParagraph(page, 'Changed in the source pane.', ' Edited in the rich pane.', true);
  await expect(mode(page)).toHaveValue('rich');
  const expected = changedSource.replace('Changed in the source pane.', 'Changed in the source pane. Edited in the rich pane.');
  await expect.poll(() => sourceText(page)).toBe(expected);
  await saveMarkdown(page, file, expected);
  await page.screenshot({ path: testInfo.outputPath('markdown-two-editors.png') });
});

test('長い Markdown で表示を切り替え，ホームで再読み込みしても編集位置へ戻る', async ({ page, session }) => {
  const text = '# Long notes\n\n' + Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1} in the long document.\n\n`).join('');
  await openMarkdown(page, session, text);
  await mode(page).selectOption('source');
  await source(page).click();
  await page.keyboard.press(`${modifier}+End`);
  await mode(page).selectOption('rich');
  const lastParagraph = rich(page).locator('p').filter({ hasText: 'Paragraph 100 ' });
  await expect(lastParagraph).toBeInViewport();
  await page.keyboard.press(`${modifier}+Home`);
  await mode(page).selectOption('source');
  await expect(source(page).locator('.cm-line').filter({ hasText: '# Long notes' })).toBeInViewport();
  await page.keyboard.press(`${modifier}+End`);
  await mode(page).selectOption('rich');
  await expect(lastParagraph).toBeInViewport();
  await expect.poll(() => page.locator('#markdown-rich-primary').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);

  await page.locator('#go-home').click();
  await expect(page.locator('#welcome')).toBeVisible();
  const meta = await json(session, '/api/state');
  const savedPosition = async () => (await json(session, `/api/storage?${new URLSearchParams({ key: `session:${meta.project.root}` })}`)).value?.workspace?.primary?.richScrollTop || 0;
  await expect.poll(savedPosition).toBeGreaterThan(1000);
  await page.reload();
  await expect(rich(page)).toBeVisible();
  await expect(lastParagraph).toBeInViewport();
  expect(await savedPosition()).toBeGreaterThan(1000);
});
