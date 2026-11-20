import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseMarkdown } from '../web/src/markdown-rich-document.js';
import { test as editorTest, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const toolbar = page => page.getByRole('toolbar', { name: 'Markdown editing', exact: true });
const button = (page, command) => toolbar(page).locator(`[data-markdown-command="${command}"]`);
const mode = page => page.locator('#markdown-editor-mode');
const rich = page => page.locator('#markdown-rich-primary .ProseMirror');
const source = page => page.getByTestId('editor').locator('.cm-content');
const sourceText = async page => (await source(page).locator('.cm-line').allTextContents()).join('\n');
const mathDialog = page => page.locator('#markdown-math-dialog');
const mathInput = page => page.locator('#markdown-math-input');
const mathPreview = page => page.locator('#markdown-math-source');
const mathPlacement = page => page.locator('#markdown-math-placement');
const mathDelimiter = page => page.locator('#markdown-math-delimiter');
const confirmMath = page => page.locator('#markdown-math-confirm');

const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Markdown toolbar' });

async function openMarkdown(page, session, text) {
  const file = path.join(session.project, 'notes.md');
  await writeFile(file, text);
  await openProject(session);
  await openEditor(page, session);
  await setAutoSave(page, false);
  await page.getByTestId('file-notes.md').click();
  await expect(mode(page)).toHaveValue('rich');
  await expect(rich(page)).toBeVisible();
  return file;
}

async function expectPressed(page, states) {
  for (const [command, value] of Object.entries(states)) {
    await expect(button(page, command)).toHaveAttribute('aria-pressed', String(value));
  }
}

test('入力前の書式切り替えと複数の装飾がボタンへ反映され，アイコンから挿入操作を選べる', async ({ page, session }, testInfo) => {
  const initial = 'First paragraph.\n\nPlain second paragraph.\n';
  await openMarkdown(page, session, initial);
  for (const name of ['Insert an image', 'Insert a table', 'New Markdown page']) {
    const control = toolbar(page).getByRole('button', { name, exact: true });
    await expect(control).toHaveText('');
    await expect(control).toHaveAttribute('title', name);
    await expect(control.locator('svg')).toHaveCount(1);
  }

  const first = rich(page).locator('p').first();
  await first.click();
  await page.keyboard.press('End');
  await page.keyboard.press(`${modifier}+b`);
  await expectPressed(page, { bold: true, italic: false, strike: false });
  await page.keyboard.press(`${modifier}+i`);
  await page.keyboard.press(`${modifier}+Shift+x`);
  await expectPressed(page, { bold: true, italic: true, strike: true });
  await expect.poll(() => sourceText(page)).toBe(initial);
  expect(await button(page, 'bold').evaluate(node => getComputedStyle(node).boxShadow)).not.toBe('none');
  await page.keyboard.insertText(' combined');
  for (const selector of ['strong', 'em', 's']) await expect(first.locator(selector)).toContainText('combined');
  await expectPressed(page, { bold: true, italic: true, strike: true });
  await page.screenshot({ path: testInfo.outputPath('markdown-toolbar-active.png') });

  await button(page, 'bold').click();
  await expectPressed(page, { bold: false, italic: true, strike: true });
  await button(page, 'italic').click();
  await button(page, 'strike').click();
  await expectPressed(page, { bold: false, italic: false, strike: false });
  await page.keyboard.insertText(' plain');
  for (const selector of ['strong', 'em', 's']) await expect(first.locator(selector)).not.toContainText('plain');

  await rich(page).locator('p').nth(1).click();
  await page.keyboard.press('End');
  await expectPressed(page, { bold: false, italic: false, strike: false, inlineCode: false });
  await button(page, 'inlineCode').click();
  await expectPressed(page, { inlineCode: true });
  await page.keyboard.insertText('code');
  await expect(rich(page).locator('p').nth(1).locator('code')).toHaveText('code');
  await page.keyboard.press('Home');
  await expectPressed(page, { inlineCode: false });
});

test('選択範囲とカーソルの移動に合わせて装飾，リスト，引用，コードの状態が変わる', async ({ page, session }) => {
  await openMarkdown(page, session, [
    '**Bold** plain *italic* and `code`.', '',
    '> - Quoted bullet', '>', '> - [ ] Quoted task', '>', '> 1. Quoted number', '',
    '~~~js', 'const value = 1;', '~~~', '',
  ].join('\n'));
  const first = rich(page).locator('p').first();
  await first.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expectPressed(page, { bold: 'mixed', italic: 'mixed', inlineCode: 'mixed', quote: false });
  await first.locator('strong').click();
  await expectPressed(page, { bold: true, italic: false, inlineCode: false });
  await first.locator('code').click();
  await expectPressed(page, { bold: false, italic: false, inlineCode: true, codeBlock: false });

  for (const [text, command] of [['Quoted bullet', 'bullet'], ['Quoted task', 'task'], ['Quoted number', 'ordered']]) {
    await rich(page).getByText(text, { exact: true }).click();
    await expectPressed(page, { bullet: command === 'bullet', ordered: command === 'ordered', task: command === 'task', quote: true, codeBlock: false });
  }
  await rich(page).locator('.rich-code-block code').click();
  await expectPressed(page, { codeBlock: true, inlineCode: false, quote: false, bullet: false, task: false, ordered: false });
});

test('ソースで数式の記法を変更でき，プレビューと前回選んだ形式を同じ挿入画面で使える', async ({ page, session }, testInfo) => {
  const file = await openMarkdown(page, session, 'Before x + y after.\n');
  await mode(page).selectOption('source');
  await source(page).locator('.cm-line').filter({ hasText: 'Before' }).click();
  await page.keyboard.press('Home');
  for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight');
  for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight');
  await button(page, 'math').click();
  await expect(mathInput(page)).toHaveValue('x + y');
  await expect(mathPlacement(page)).toHaveValue('inline');
  await expect(mathDelimiter(page)).toHaveValue('$`');
  await expect(mathPreview(page)).toHaveValue('$`x + y`$');
  await expect(mathDialog(page).locator('.katex')).toHaveCount(1);
  await mathInput(page).fill('x + y\n+ z');
  await expect(confirmMath(page)).toBeDisabled();
  await expect(mathDialog(page).getByRole('alert')).toContainText('one line');
  await mathInput(page).fill('x + y');
  await confirmMath(page).click();
  await expect(mathDialog(page)).toBeHidden();
  await expect.poll(() => sourceText(page)).toBe('Before $`x + y`$ after.\n');

  for (const [delimiter, expression] of [['$', '$x + y$'], ['\\(', '\\(x + y\\)']]) {
    await button(page, 'math').click();
    await expect(mathInput(page)).toHaveValue('x + y');
    await mathDelimiter(page).selectOption(delimiter);
    await expect(mathPreview(page)).toHaveValue(expression);
    await confirmMath(page).click();
    await expect(mathDialog(page)).toBeHidden();
    await expect.poll(() => sourceText(page)).toBe(`Before ${expression} after.\n`);
  }

  await button(page, 'math').click();
  await mathPlacement(page).selectOption('display');
  await mathInput(page).fill('x + y\n+ z');
  await expect(mathDelimiter(page)).toBeHidden();
  await expect(mathPreview(page)).toHaveValue('$$\nx + y\n+ z\n$$');
  await page.setViewportSize({ width: 390, height: 850 });
  const bounds = await mathDialog(page).evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: node.clientWidth, scrollWidth: node.scrollWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
  await expect(confirmMath(page)).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('markdown-math-dialog-narrow.png') });
  await confirmMath(page).click();
  await expect(mathDialog(page)).toBeHidden();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const expected = 'Before \n\n$$\nx + y\n+ z\n$$\n\n after.\n';
  await expect.poll(() => sourceText(page)).toBe(expected);
  await source(page).press(`${modifier}+s`);
  await expect.poll(() => readFile(file, 'utf8')).toBe(expected);

  await source(page).press(`${modifier}+End`);
  await button(page, 'math').click();
  await expect(mathInput(page)).toHaveValue('');
  await expect(mathPlacement(page)).toHaveValue('display');
  await mathPlacement(page).selectOption('inline');
  await expect(mathDelimiter(page)).toHaveValue('\\(');
  await mathDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(mathDialog(page)).toBeHidden();
  await expect.poll(() => sourceText(page)).toBe(expected);

  await mode(page).selectOption('rich');
  await button(page, 'math').click();
  await expect(mathPlacement(page)).toHaveValue('inline');
  await expect(mathDelimiter(page)).toHaveValue('\\(');
  await mathInput(page).press('Escape');
  await expect(mathDialog(page)).toBeHidden();
  expect(await readFile(file, 'utf8')).toBe(expected);
});

test('直接編集で選んだ TeX を数式にし，既存の式を各記法と独立した数式へ変更できる', async ({ page, session }, testInfo) => {
  const file = await openMarkdown(page, session, 'x + y\n\nNext paragraph.\n');
  await rich(page).locator('p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await button(page, 'math').click();
  await expect(mathInput(page)).toHaveValue('x + y');
  await expect(mathDelimiter(page)).toHaveValue('$`');
  const tex = '\\alpha + \\beta';
  await mathInput(page).fill(tex);
  await expect(mathPreview(page)).toHaveValue(`$\`${tex}\`$`);
  await page.screenshot({ path: testInfo.outputPath('markdown-math-dialog.png') });
  await confirmMath(page).click();
  await expect(mathDialog(page)).toBeHidden();
  await expect(rich(page).locator('.rich-math-inline .katex')).toHaveCount(1);
  await expect(rich(page).locator('.rich-math-input:visible')).toHaveCount(0);
  await expect.poll(() => sourceText(page)).toBe(`$\`${tex}\`$\n\nNext paragraph.\n`);

  for (const [delimiter, expression] of [['$', `$${tex}$`], ['\\(', `\\(${tex}\\)`]]) {
    await button(page, 'math').click();
    await expect(mathInput(page)).toHaveValue(tex);
    await mathDelimiter(page).selectOption(delimiter);
    await expect(mathPreview(page)).toHaveValue(expression);
    await confirmMath(page).click();
    await expect(mathDialog(page)).toBeHidden();
    await expect(rich(page).locator('.rich-math')).toHaveCount(1);
    await expect(rich(page).locator('.rich-math-input:visible')).toHaveCount(0);
    await expect.poll(() => sourceText(page)).toBe(`${expression}\n\nNext paragraph.\n`);
  }

  await button(page, 'math').click();
  await mathPlacement(page).selectOption('display');
  const displayTeX = '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}';
  await mathInput(page).fill(displayTeX);
  await confirmMath(page).click();
  await expect(mathDialog(page)).toBeHidden();
  await expect(rich(page).locator('.rich-math-block .katex')).toHaveCount(1);
  await expect(rich(page).locator('.rich-math-inline')).toHaveCount(0);
  await expect(rich(page).getByText('Next paragraph.', { exact: true })).toBeVisible();
  await mode(page).selectOption('source');
  const savedText = await sourceText(page);
  const savedDocument = parseMarkdown(savedText);
  expect(savedDocument.childCount).toBe(2);
  expect(savedDocument.firstChild.type.name).toBe('math_block');
  expect(savedDocument.firstChild.attrs.tex.trim()).toBe(displayTeX);
  expect(savedDocument.lastChild.textContent).toBe('Next paragraph.');
  await source(page).press(`${modifier}+s`);
  await expect.poll(() => readFile(file, 'utf8')).toBe(savedText);
});

test('表のセルでは行内数式を選び，行と列を変えずに挿入できる', async ({ page, session }) => {
  await openMarkdown(page, session, 'Paragraph.\n\n| Name | Value |\n| --- | --- |\n| Result | x + y |\n');
  await rich(page).locator('p').first().click();
  await page.keyboard.press('End');
  await button(page, 'math').click();
  await mathPlacement(page).selectOption('display');
  await mathDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(mathDialog(page)).toBeHidden();

  const table = rich(page).locator('table');
  const cell = table.locator('tr').nth(1).locator('td').nth(1);
  await cell.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await button(page, 'math').click();
  await expect(mathPlacement(page)).toHaveValue('inline');
  await expect(mathPlacement(page).locator('option[value="display"]')).toBeDisabled();
  await expect(page.locator('#markdown-math-table-help')).toHaveText('Use inline math in table cells.');
  await expect(page.locator('#markdown-math-table-help')).toBeVisible();
  await expect(mathInput(page)).toHaveValue('x + y');
  await expect(mathPreview(page)).toHaveValue('$`x + y`$');
  await confirmMath(page).click();
  await expect(mathDialog(page)).toBeHidden();
  await expect(table.locator('tr')).toHaveCount(2);
  await expect(table.locator('th')).toHaveCount(2);
  await expect(table.locator('td')).toHaveCount(2);
  await expect(cell.locator('.rich-math-inline .katex')).toHaveCount(1);
  await expect(rich(page).locator('.rich-math-block')).toHaveCount(0);
  await expect.poll(() => sourceText(page)).toContain('| Result | $`x + y`$ |');

  await rich(page).locator('p').first().click();
  await page.keyboard.press('End');
  await button(page, 'math').click();
  await expect(mathPlacement(page)).toHaveValue('display');
  await expect(mathPlacement(page).locator('option[value="display"]')).toBeEnabled();
  await expect(page.locator('#markdown-math-table-help')).toBeHidden();
  await mathDialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
});
