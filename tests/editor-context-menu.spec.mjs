import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as editorTest, openProject, openEditor, setAutoSave } from './editor-fixtures.mjs';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = (page, pane = 'primary') => page.getByTestId(pane === 'primary' ? 'editor' : 'editor-secondary').locator('.cm-content');
const rich = (page, pane = 'primary') => page.locator(`#markdown-rich-${pane} .ProseMirror`);
const menu = page => page.getByRole('menu', { name: 'Insert into the document', exact: true });
const sourceText = async (page, pane = 'primary') => (await source(page, pane).locator('.cm-line').allTextContents()).join('\n');

const test = editorTest.extend({
  pageErrors: [async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await use(errors);
    expect(errors).toEqual([]);
  }, { auto: true }],
});
test.use({ interfaceLanguage: 'en', projectDirectory: 'Insert context menu' });

async function openFiles(page, session, files, active) {
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(session.project, name), content);
  await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
  await page.getByTestId(`file-${active}`).click();
}
async function selectText(page, line, from, to) {
  await line.click(); await page.keyboard.press('Home');
  for (let index = 0; index < from; index++) await page.keyboard.press('ArrowRight');
  for (let index = from; index < to; index++) await page.keyboard.press('Shift+ArrowRight');
}
async function pointAtText(line, offset) {
  return line.evaluate((element, offset) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (offset <= node.textContent.length) {
        const range = document.createRange(); range.setStart(node, offset); range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + 0.2, y: rect.top + Math.max(1, rect.height / 2) };
      }
      offset -= node.textContent.length;
    }
    throw new Error('The text position was not found.');
  }, offset);
}
async function rightClickText(page, line, offset) {
  const point = await pointAtText(line, offset);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await expect(menu(page)).toBeVisible();
}


test('TeX の選択範囲へ表を挿入し，キーボードと標準のメニューも使える', async ({ page, session }, testInfo) => {
  await openFiles(page, session, { 'context.tex': 'LEFT TARGET RIGHT\nSecond line\n' }, 'context.tex');
  const line = source(page).locator('.cm-line').first();
  await selectText(page, line, 5, 11); await rightClickText(page, line, 7);
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Insert an image', 'Insert a table']);
  await page.screenshot({ path: testInfo.outputPath('tex-insert-context-menu.png') });
  await menu(page).getByRole('menuitem', { name: 'Insert a table', exact: true }).click();
  const table = page.locator('#insert-table-dialog'); await expect(table).toBeVisible();
  await page.locator('#insert-table-input').fill('A\tB\n1\t2');
  await expect(page.locator('#insert-table-source')).toHaveValue(/\\begin\{tabular\}/);
  await page.locator('#insert-table-confirm').click(); await expect(table).not.toBeVisible();
  await expect.poll(() => sourceText(page)).toContain('\\begin{tabular}');
  const inserted = await sourceText(page);
  expect(inserted).toMatch(/^LEFT /); expect(inserted).toContain(' RIGHT\nSecond line\n'); expect(inserted).not.toContain('TARGET');
  await expect(source(page)).toBeFocused();
  await page.keyboard.press('Shift+F10'); await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(menu(page).getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu(page)).not.toBeVisible(); await expect(source(page)).toBeFocused();
  await page.keyboard.press('Shift+F10'); await page.keyboard.press('Enter');
  await expect(page.locator('#insert-image-dialog')).toBeVisible();
  await page.locator('#insert-image-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source(page)).toBeFocused();
  await page.evaluate(() => document.addEventListener('contextmenu', event => { window.standardContextAllowed = !event.defaultPrevented; }, { once: true }));
  const point = await pointAtText(source(page).locator('.cm-line').first(), 2);
  await page.keyboard.down('Shift'); await page.mouse.click(point.x, point.y, { button: 'right' }); await page.keyboard.up('Shift');
  await expect(menu(page)).not.toBeVisible(); expect(await page.evaluate(() => standardContextAllowed)).toBe(true);
  await page.keyboard.press('Escape');
});


test('Markdown のソースでは選択範囲外のクリック位置へリンクを挿入する', async ({ page, session }) => {
  await openFiles(page, session, { 'notes.md': 'First chosen end\n' }, 'notes.md');
  await page.locator('#markdown-editor-mode').selectOption('source'); await expect(source(page)).toBeVisible();
  const line = source(page).locator('.cm-line').first();
  await selectText(page, line, 0, 5); await rightClickText(page, line, 14);
  await expect(menu(page).getByRole('menuitem')).toHaveCount(6);
  await menu(page).getByRole('menuitem', { name: 'Insert a link', exact: true }).click();
  await expect(page.locator('#markdown-link-label')).toHaveValue('');
  await page.locator('#markdown-link-label').fill('New'); await page.locator('#markdown-link-url').fill('next.md');
  await page.locator('#markdown-link-confirm').click();
  await expect.poll(() => sourceText(page)).toBe('First chosen e[New](next.md)nd\n');
  await expect(source(page)).toBeFocused();
  await page.keyboard.press(`${modifier}+z`); await expect.poll(() => sourceText(page)).toBe('First chosen end\n');
  await page.keyboard.press('Shift+F10'); await menu(page).getByRole('menuitem', { name: 'New Markdown page', exact: true }).click();
  await expect(page.locator('#markdown-page-dialog')).toBeVisible();
  await page.locator('#markdown-page-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source(page)).toBeFocused();
});


test('直接編集の範囲をリンクにし，クリックした数式を同じダイアログで編集する', async ({ page, session }, testInfo) => {
  await openFiles(page, session, { 'notes.md': 'Before target after\n\nEquation $`x`$.\n' }, 'notes.md');
  await expect(rich(page)).toBeVisible();
  const first = rich(page).locator('p').first();
  await selectText(page, first, 7, 13); await rightClickText(page, first, 9);
  await page.screenshot({ path: testInfo.outputPath('markdown-insert-context-menu.png') });
  await menu(page).getByRole('menuitem', { name: 'Insert a link', exact: true }).click();
  await expect(page.locator('#markdown-link-label')).toHaveValue('target');
  await page.locator('#markdown-link-url').fill('next.md'); await page.locator('#markdown-link-confirm').click();
  await expect(first.locator('a')).toHaveText('target'); await expect(first).toHaveText('Before target after');
  await rich(page).locator('.rich-math-preview').click({ button: 'right' }); await expect(menu(page)).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Insert math', exact: true }).click();
  await expect(page.locator('#markdown-math-input')).toHaveValue('x');
  await page.locator('#markdown-math-input').fill('y^2'); await page.locator('#markdown-math-confirm').click();
  await expect(rich(page).locator('.rich-math')).toHaveCount(1);
  await expect.poll(() => sourceText(page)).toContain('Equation $`y^2`$.');
  await expect(rich(page)).toBeFocused();
  await page.keyboard.press('Shift+F10'); await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(rich(page)).toBeFocused();
});


test('二つ目のペインの選択範囲へ挿入し，キャンセルするとその原稿へ戻る', async ({ page, session }) => {
  await openFiles(page, session, { 'notes.md': 'Primary document\n', 'second.md': 'Second TARGET end\n' }, 'notes.md');
  await page.locator('#split-editors').click(); await page.locator('#secondary-document').selectOption('second.md');
  await expect(rich(page, 'secondary')).toBeVisible();
  const second = rich(page, 'secondary').locator('p').first();
  await selectText(page, second, 7, 13);
  await rich(page).locator('p').first().click();
  await rightClickText(page, second, 9);
  await menu(page).getByRole('menuitem', { name: 'Code block', exact: true }).click();
  await expect(page.locator('#markdown-code-input')).toHaveValue('TARGET');
  await page.locator('#markdown-code-language').fill('js'); await page.locator('#markdown-code-input').fill('const value = 1;');
  await page.locator('#markdown-code-confirm').click();
  await expect(rich(page, 'secondary').locator('code')).toHaveText('const value = 1;');
  await expect.poll(() => sourceText(page, 'secondary')).toContain('```js\nconst value = 1;\n```');
  await expect.poll(() => sourceText(page)).toBe('Primary document\n');
  await expect(rich(page, 'secondary')).toBeFocused();
  await page.keyboard.press('Shift+F10'); await menu(page).getByRole('menuitem', { name: 'Insert an image', exact: true }).click();
  await expect(page.locator('#insert-image-dialog')).toBeVisible();
  await page.locator('#insert-image-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rich(page, 'secondary')).toBeFocused();
});
