import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const origin = 'http://127.0.0.1:41543';
const pixelPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAIAAAA7N+mxAAAAF0lEQVR4nGNUbipkIBcwka1zVPOI0QwArkYBKjdurAMAAAAASUVORK5CYII=', 'base64');
let javascript;

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { MarkdownRichEditor } from './markdown-rich-editor.js';
        import { EditorState } from '@codemirror/state';
        import { history, undo, redo, isolateHistory } from '@codemirror/commands';
        import { setLanguage } from './i18n.js';
        setLanguage('ja');
        window.richChanges = []; window.richSelections = []; window.richErrors = []; window.richLinks = []; window.revokedImages = [];
        const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { revokedImages.push(url); revoke(url); };
        let canonical;
        const applySource = transaction => {
          canonical = transaction.state;
          rich.setText(canonical.doc.toString(), transaction.changes);
          const selection = canonical.selection.main; rich.selectSource(selection.anchor, selection.head);
        };
        window.openRich = (text, path = 'notes/main.md', projectRoot = '/project/原稿') => {
          window.rich?.destroy();
          richChanges.length = richSelections.length = richErrors.length = richLinks.length = 0;
          canonical = EditorState.create({ doc: text, extensions: [history()] });
          window.rich = new MarkdownRichEditor({ host: document.getElementById('rich'), text, path, projectRoot, token: 'rich-test-token',
            onChange: change => {
              if (change.beforeText !== canonical.doc.toString()) throw new Error('The canonical source changed.');
              const transaction = canonical.update({ changes: change.changes, selection: change.selection, userEvent: change.userEvent,
                annotations: change.userEvent !== 'input.type' ? isolateHistory.of('full') : undefined });
              canonical = transaction.state; richChanges.push(change);
              rich.setText(canonical.doc.toString(), transaction.changes);
            },
            onSelectionChange: selection => { richSelections.push(selection); canonical = canonical.update({ selection }).state; },
            onUndo: () => undo({ state: canonical, dispatch: applySource }), onRedo: () => redo({ state: canonical, dispatch: applySource }),
            onFind: () => { window.findRequested = true; },
            onOpenFile: (path, options) => richLinks.push({ path, ...options }), onError: error => richErrors.push(String(error.message || error)),
          });
        };
        window.sourceText = () => canonical.doc.toString();
        window.selectRichText = text => { const from = rich.text.indexOf(text); rich.selectSource(from, from + text.length); rich.focus(); };
        window.pasteRich = (plain, html = '') => {
          const data = new DataTransfer(); data.setData('text/plain', plain); if (html) data.setData('text/html', html);
          rich.view.dom.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        };
        openRich('');`,
      resolveDir: path.join(repository, 'web/src'),
    },
    bundle: true, format: 'esm', write: false,
  });
  javascript = bundled.outputFiles[0].text;
});

async function openEditor(page, text) {
  const requests = [];
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/rich.js') return route.fulfill({ contentType: 'text/javascript', body: javascript });
    if (url.pathname === '/api/asset') {
      requests.push({ path: url.searchParams.get('path'), headers: request.headers() });
      return route.fulfill({ contentType: 'image/png', body: pixelPNG });
    }
    if (['/style.css', '/markdown-rich-editor.css'].includes(url.pathname)) return route.fulfill({ contentType: 'text/css', body: await readFile(path.join(repository, 'web/src', url.pathname.slice(1))) });
    if (/^\/katex\/(?:katex\.min\.css|fonts\/[\w.-]+\.(?:woff2?|ttf))$/.test(url.pathname)) {
      const contentType = url.pathname.endsWith('.css') ? 'text/css' : 'font/woff2';
      return route.fulfill({ contentType, body: await readFile(path.join(repository, 'node_modules/katex/dist', url.pathname.slice('/katex/'.length))) });
    }
    if (url.pathname !== '/') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ja"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/markdown-rich-editor.css"><link rel="stylesheet" href="/katex/katex.min.css">
      <style>body { display: flex; } #rich { width: 100%; height: 100%; }</style>
      </head><body><div id="rich"></div><script type="module" src="/rich.js"></script></body></html>` });
  });
  await page.goto(origin);
  await expect.poll(() => page.evaluate(() => Boolean(window.rich))).toBe(true);
  await page.evaluate(text => openRich(text), text);
  return requests;
}
async function checkErrors(page) { expect(await page.evaluate(() => richErrors)).toEqual([]); }

test('開いた Markdown を変えずに表示し，装飾と入力を原稿の Undo で戻せる', async ({ page }) => {
  const original = '#  Title\n\nA sentence.\n\n~~~txt\nunchanged\n~~~\n\n[reference]: next.md\n';
  await openEditor(page, original);
  await expect(page.locator('.markdown-rich-document h1')).toHaveText('Title');
  expect(await page.evaluate(() => sourceText())).toBe(original);
  expect(await page.evaluate(() => richChanges.length)).toBe(0);
  expect(await page.evaluate(() => {
    const state = rich.view.state;
    rich.setDocument({ text: rich.text, path: rich.path, projectRoot: rich.projectRoot });
    return state === rich.view.state;
  })).toBe(true);
  await page.evaluate(() => selectRichText('sentence'));
  await page.keyboard.press('Control+b');
  await expect(page.locator('.markdown-rich-document strong')).toHaveText('sentence');
  expect(await page.evaluate(() => sourceText())).toContain('**sentence**');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.markdown-rich-document strong')).toHaveCount(0);
  expect(await page.evaluate(() => sourceText())).toBe(original);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.markdown-rich-document strong')).toHaveText('sentence');
  await page.evaluate(() => { rich.selectSource(rich.text.indexOf('sentence') + 8); rich.focus(); });
  await page.keyboard.type(' updated');
  expect(await page.evaluate(() => sourceText())).toContain('updated');
  expect(await page.evaluate(() => sourceText())).toContain('~~~txt\nunchanged\n~~~');
  await checkErrors(page);
});

test('表のセルを編集し，行列を増減して Enter と Tab で移動する', async ({ page }) => {
  await openEditor(page, '| A | B |\n| --- | --- |\n| one | two |\n');
  await page.evaluate(() => selectRichText('one')); await page.keyboard.type('edited');
  await expect(page.locator('td').first()).toHaveText('edited');
  await page.keyboard.press('Tab'); await page.keyboard.type(' plus');
  await expect(page.locator('td').nth(1)).toContainText('plus');
  await page.keyboard.press('Enter');
  await expect(page.locator('table tr')).toHaveCount(3);
  await page.keyboard.type('new row');
  expect(await page.evaluate(() => sourceText())).toContain('new row');
  await page.evaluate(() => { selectRichText('A'); rich.command('addRowBefore'); });
  await expect(page.locator('table tr')).toHaveCount(4);
  await expect(page.locator('table tr').first().locator('th')).toHaveCount(2);
  await expect(page.locator('table tr').nth(1).locator('th')).toHaveCount(0);
  await page.locator('table th').first().click();
  await page.locator('[data-rich-command="deleteRow"]').click();
  await expect(page.locator('table tr')).toHaveCount(3);
  await expect(page.locator('table tr').first().locator('th')).toHaveCount(2);
  await page.evaluate(() => { selectRichText('edited'); rich.command('addColumnAfter'); });
  await expect(page.locator('table tr').first().locator('th')).toHaveCount(3);
  await page.locator('[data-rich-command="deleteColumn"]').click();
  await expect(page.locator('table tr').first().locator('th')).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 650 });
  expect(await page.locator('#rich').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await checkErrors(page);
});

test('タスクのチェックと Markdown の入力規則を使い，リストを入れ子にできる', async ({ page }) => {
  await openEditor(page, '- [ ] First\n- [x] Second\n');
  const checks = page.locator('.rich-task-checkbox');
  await checks.first().check();
  expect(await page.evaluate(() => sourceText())).toContain('- [x] First');
  await page.evaluate(() => { selectRichText('Second'); rich.selectSource(rich.text.indexOf('Second') + 6); rich.focus(); });
  await page.keyboard.press('Enter'); await page.keyboard.type('Third');
  await expect(checks).toHaveCount(3); await expect(checks.nth(2)).not.toBeChecked();
  await page.keyboard.press('Tab'); await expect(page.locator('.markdown-rich-document ul ul')).toHaveCount(1);
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('.markdown-rich-document ul ul')).toHaveCount(0);
  await page.evaluate(() => openRich(''));
  await page.locator('.markdown-rich-document').click(); await page.keyboard.type('# Heading');
  await expect(page.locator('.markdown-rich-document h1')).toHaveText('Heading');
  await page.keyboard.press('Enter'); await page.keyboard.type('- [ ] New task');
  await expect(page.locator('.rich-task-checkbox')).toHaveCount(1);
  expect(await page.evaluate(() => sourceText())).toContain('- [ ] New task');
  await checkErrors(page);
});

test('数式を TeX で編集し，日本語の入力中にも同じ入力欄を使う', async ({ page }) => {
  await openEditor(page, 'Equation $`x^2`$.\n\n$$\na+b\n$$\n');
  await expect(page.locator('.rich-math .katex')).toHaveCount(2);
  await page.locator('.rich-math-preview').first().click();
  const input = page.locator('.rich-math-input').first();
  await input.fill('x_1^2');
  expect(await page.evaluate(() => sourceText())).toContain('$`x_1^2`$');
  expect(await input.evaluate(element => {
    const selection = element.selectionStart;
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    window.mathInputBefore = element;
    rich.setDocument({ text: rich.text, path: rich.path, projectRoot: rich.projectRoot });
    return document.activeElement === element && element.selectionStart === selection;
  })).toBe(true);
  await input.evaluate(element => {
    element.value = '\\text{日本語} + x';
    element.setSelectionRange(element.value.length, element.value.length);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日本語', isComposing: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
  });
  expect(await page.evaluate(() => mathInputBefore === document.querySelector('.rich-math-input'))).toBe(true);
  expect(await page.evaluate(() => sourceText())).toContain('\\text{日本語} + x');
  await input.press('Escape');
  await page.evaluate(() => rich.command('math', { displayMode: true }));
  await expect(page.locator('.rich-math-input:visible')).toHaveCount(1);
  await page.locator('.rich-math-input:visible').fill('\\frac{1}{n}');
  expect(await page.evaluate(() => sourceText())).toContain('\\frac{1}{n}');
  await page.evaluate(() => rich.setReadOnly(true));
  await expect(page.locator('.rich-math-input:visible')).toHaveAttribute('readonly', '');
  expect(await page.evaluate(() => rich.command('bold'))).toBe(false);
  await checkErrors(page);
});

test('Markdown の貼付けとコードを編集し，外部更新で編集通知を増やさない', async ({ page }) => {
  await openEditor(page, 'Text\n');
  await page.evaluate(() => { selectRichText('Text'); pasteRich('## Pasted\n\n**bold** text\n\n```js\nconst x = 1;\n```\n'); });
  await expect(page.locator('.markdown-rich-document h2')).toHaveText('Pasted');
  await expect(page.locator('.markdown-rich-document strong')).toHaveText('bold');
  const language = page.locator('.rich-code-language'); await language.fill('typescript');
  expect(await page.evaluate(() => sourceText())).toContain('```typescript');
  await page.evaluate(() => selectRichText('const x = 1;')); await page.keyboard.type('const x: number = 2;');
  await expect(page.locator('.rich-code-block code')).toHaveText('const x: number = 2;');
  await page.evaluate(() => {
    window.countBeforeExternal = richChanges.length;
    rich.setText('New external text\n');
    rich.selectSource(3);
  });
  await expect(page.locator('.markdown-rich-document')).toContainText('New external text');
  expect(await page.evaluate(() => richChanges.length === countBeforeExternal)).toBe(true);
  await checkErrors(page);
});

test('ローカル画像を認証して表示し，外部画像はリンクにし，文書のリンクを開く', async ({ page }) => {
  const requests = await openEditor(page, '![図](../images/figure.png)\n\n![External](https://example.com/image.png)\n\n[Next](next.md#section)\n');
  const local = page.locator('.rich-image img');
  await expect(local).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => local.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0].path).toBe('images/figure.png');
  expect(requests[0].headers['x-local-token']).toBe('rich-test-token');
  expect(requests[0].headers['x-project-root']).toBe(encodeURIComponent('/project/原稿'));
  await expect(page.getByRole('link', { name: 'External' })).toHaveAttribute('href', 'https://example.com/image.png');
  await expect(page.locator('img[src^="https:"]')).toHaveCount(0);
  await page.getByRole('link', { name: 'Next' }).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => richLinks)).toEqual([{ path: 'notes/next.md', fragment: 'section' }]);
  const imageURL = await local.getAttribute('src');
  await page.evaluate(() => rich.setText('Text only\n'));
  expect(await page.evaluate(url => revokedImages.includes(url), imageURL)).toBe(true);
  await page.evaluate(() => { openRich('Text'); selectRichText('Text'); pasteRich('bad', '<a href="javascript:window.executedLink=true">bad</a>'); });
  const invalid = page.locator('a[data-rich-link]');
  await expect(invalid).toHaveAttribute('data-rich-link', 'javascript:window.executedLink=true');
  await expect(invalid).not.toHaveAttribute('href', /.+/);
  await invalid.click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => Boolean(window.executedLink))).toBe(false);
  await checkErrors(page);
});

test('画像を上書きした後，同じ画像の表示をまとめて更新する', async ({ page }) => {
  const original = '![First](../images/figure.png)\n\n![Second](../images/figure.png)\n\n![Other](../images/other.png)\n';
  const requests = await openEditor(page, original);
  const first = page.getByRole('img', { name: 'First', exact: true });
  const second = page.getByRole('img', { name: 'Second', exact: true });
  const other = page.getByRole('img', { name: 'Other', exact: true });
  await expect(first).toHaveAttribute('src', /^blob:/);
  await expect(second).toHaveAttribute('src', /^blob:/);
  await expect(other).toHaveAttribute('src', /^blob:/);
  const previous = await first.getAttribute('src'), otherURL = await other.getAttribute('src');
  expect(await second.getAttribute('src')).toBe(previous);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => rich.refreshImages('images/figure.png'))).toBe(true);
  await expect(first).toHaveAttribute('src', /^blob:/);
  await expect(first).not.toHaveAttribute('src', previous);
  await expect(second).toHaveAttribute('src', await first.getAttribute('src'));
  await expect(other).toHaveAttribute('src', otherURL);
  expect(requests.filter(request => request.path === 'images/figure.png')).toHaveLength(2);
  expect(requests.filter(request => request.path === 'images/other.png')).toHaveLength(1);
  expect(await page.evaluate(url => revokedImages.includes(url), previous)).toBe(true);
  expect(await page.evaluate(() => sourceText())).toBe(original);
  expect(await page.evaluate(() => richChanges.length)).toBe(0);
  await page.evaluate(() => { rich.refreshImages('images/figure.png'); rich.refreshImages('images/figure.png'); });
  await expect(first).toHaveAttribute('src', /^blob:/);
  await expect(second).toHaveAttribute('src', await first.getAttribute('src'));
  await checkErrors(page);
});
