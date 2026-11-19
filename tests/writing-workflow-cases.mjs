import { expect } from '@playwright/test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const clean = value => value.replaceAll('\r\n', '\n');
const source = (page, second = false) => page.getByTestId(second ? 'editor-secondary' : 'editor').locator('.cm-content');
async function replaceSource(page, text, second = false) {
  await source(page, second).click();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(text);
}
async function tool(page, id) {
  await page.locator('#writing-menu > summary').click();
  await page.locator(`#${id}`).click();
}
const tabs = page => page.locator('#editor-tabs .tab-select').evaluateAll(nodes => nodes.map(node => node.dataset.path));

export function registerWritingWorkflowTests({ test, openProject, openEditor, setAutoSave, json, compileFromUI }) {
  test('Markdown の装飾，リンク，コードを編集ボタンで挿入し，Undo で戻せる', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await writeFile(path.join(session.project, 'format.md'), 'Draft phrase\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-format.md').click();
    const toolbar = page.locator('#markdown-editing');
    await expect(toolbar).toBeVisible();
    await source(page).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.press('Shift+End');
    await toolbar.getByRole('button', { name: '太字', exact: true }).click();
    await expect(page.getByTestId('markdown-document').locator('strong')).toHaveText('Draft phrase');
    await page.keyboard.press(`${modifier}+z`);
    await expect(page.getByTestId('markdown-document').locator('strong')).toHaveCount(0);
    await source(page).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.press('Shift+End');
    await toolbar.getByRole('button', { name: 'リンクを挿入', exact: true }).click();
    await expect(page.locator('#markdown-link-label')).toHaveValue('Draft phrase');
    await page.locator('#markdown-link-label').fill('Paper to read');
    await page.locator('#markdown-link-url').fill('https://example.com/paper');
    await page.locator('#markdown-link-confirm').click();
    await expect(page.getByTestId('markdown-document').getByRole('link', { name: 'Paper to read' })).toHaveAttribute('href', 'https://example.com/paper');
    await source(page).click(); await page.keyboard.press(`${modifier}+End`); await page.keyboard.press('Enter');
    await toolbar.getByRole('button', { name: 'コードブロック', exact: true }).click();
    await page.locator('#markdown-code-language').fill('python');
    await page.locator('#markdown-code-input').fill('print("Hello")');
    await page.locator('#markdown-code-confirm').click();
    await expect(page.getByTestId('markdown-document').locator('pre code')).toHaveText('print("Hello")\n');
    await page.screenshot({ path: testInfo.outputPath('markdown-editing-controls.png') });
    await page.keyboard.press(`${modifier}+z`);
    await expect(page.getByTestId('markdown-document').locator('pre code')).toHaveCount(0);
    await expect(page.getByTestId('markdown-document').getByRole('link', { name: 'Paper to read' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('保存の応答を待つ間に入力した原稿も，自動保存が続く', async ({ page, session }) => {
    await openProject(session); await openEditor(page, session);
    let release, received;
    const waiting = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { received = resolve; });
    let first = true;
    await page.route('**/api/file', async route => {
      if (route.request().method() === 'PUT' && first) { first = false; received(); await waiting; }
      await route.continue();
    });
    try {
      await source(page).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.insertText('% first save\n');
      await requested;
      await page.keyboard.insertText('% entered while saving\n');
      await page.waitForTimeout(1900);
      release();
      await expect.poll(() => readFile(path.join(session.project, 'main.tex'), 'utf8')).toContain('% entered while saving');
      await expect(page.locator('#save-status')).toHaveText('保存済み');
    } finally { release(); }
  });

  test('二つの原稿で編集と Undo を行い，タブの順番と配置を再読み込み後に戻す', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const first = '\\section{First}\nFirst document.\n';
    const second = '\\section{Second}\nSecond document.\n';
    await writeFile(path.join(session.project, 'first.tex'), first);
    await writeFile(path.join(session.project, 'second.tex'), second);
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'gray');
    expect(await page.locator('#editor .cm-scroller').evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Consolas/);
    await page.getByTestId('file-first.tex').click();
    await page.getByTestId('file-second.tex').click();
    await page.locator('#split-editors').click();
    await page.locator('#primary-document').selectOption('first.tex');
    await page.locator('#secondary-document').selectOption('second.tex');
    await expect(source(page)).toContainText('First document.');
    await expect(source(page, true)).toContainText('Second document.');
    await source(page).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.insertText('% left\n');
    await source(page, true).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.insertText('% right\n');
    await page.keyboard.press(`${modifier}+Shift+s`);
    await expect.poll(async () => clean(await readFile(path.join(session.project, 'first.tex'), 'utf8'))).toBe('% left\n' + first);
    await expect.poll(async () => clean(await readFile(path.join(session.project, 'second.tex'), 'utf8'))).toBe('% right\n' + second);

    await page.locator('#secondary-document').selectOption('first.tex');
    await source(page, true).click(); await page.keyboard.press(`${modifier}+Home`); await page.keyboard.insertText('% shared\n');
    await expect(source(page)).toContainText('% shared');
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).not.toContainText('% shared');
    await expect(source(page, true)).not.toContainText('% shared');
    await page.keyboard.press(modifier === 'Meta' ? 'Meta+Shift+z' : 'Control+y');
    await expect(source(page)).toContainText('% shared');
    await expect(source(page, true)).toContainText('% shared');
    await page.keyboard.press(`${modifier}+s`);
    await page.locator('#secondary-document').selectOption('second.tex');
    await page.locator('.editor-tab').filter({ has: page.locator('[data-path="first.tex"]') }).dragTo(page.locator('.editor-tab').filter({ has: page.locator('[data-path="main.tex"]') }));
    await expect.poll(() => tabs(page)).toEqual(['first.tex', 'main.tex', 'second.tex']);
    await page.locator('#source-splitter').focus(); await page.keyboard.press('ArrowRight');
    const ratio = await page.locator('#source-splitter').getAttribute('aria-valuenow');
    expect(Number(ratio)).toBeGreaterThan(50);
    await page.screenshot({ path: testInfo.outputPath('two-source-editors.png') });
    await expect.poll(async () => (await json(session, `/api/storage?key=${encodeURIComponent('session:' + session.project)}`)).value?.tabs).toEqual(['first.tex', 'main.tex', 'second.tex']);
    await page.reload();
    await expect(page.locator('#primary-document')).toHaveValue('first.tex');
    await expect(page.locator('#secondary-document')).toHaveValue('second.tex');
    await expect(page.locator('#source-splitter')).toHaveAttribute('aria-valuenow', ratio);
    await expect(source(page)).toContainText('% shared');
    await expect(source(page, true)).toContainText('% right');
    await expect.poll(() => tabs(page)).toEqual(['first.tex', 'main.tex', 'second.tex']);
    await page.locator('.editor-tab').filter({ has: page.locator('[data-path="first.tex"]') }).locator('.tab-close').click();
    await expect(page.locator('#primary-document')).toHaveValue('main.tex');
    await expect(source(page, true)).toContainText('% right');
    await page.locator('#close-second-editor').click();
    await expect(page.getByTestId('editor-secondary')).not.toBeVisible();
    expect(errors).toEqual([]);
  });

  test('未保存の原稿を含めて本文を検索し，選んだ置換と履歴の一部を原稿へ反映する', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await writeFile(path.join(session.project, 'alpha.tex'), 'needle alpha\n\nKeep Alpha\n\nOriginal final\n');
    await writeFile(path.join(session.project, 'beta.tex'), 'needle beta\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-alpha.tex').click();
    const current = 'needle alpha edited\n\nKeep Alpha\n\nOriginal final\n';
    await replaceSource(page, current);
    await page.keyboard.press(`${modifier}+Shift+f`);
    await page.getByTestId('project-search-query').fill('needle');
    await page.getByTestId('project-search-replacement').fill('found');
    await page.getByTestId('run-project-search').click();
    await expect(page.getByTestId('project-search-status')).toContainText('2 件');
    const group = page.locator('.project-search-file').filter({ has: page.getByRole('heading', { name: 'alpha.tex (1)', exact: true }) });
    await expect(group).toContainText('alpha edited');
    await group.locator('input[data-match]').check();
    await page.getByTestId('replace-project-selection').click();
    await expect(page.getByTestId('project-search-status')).toContainText('1 ファイルを保存');
    await page.getByTestId('close-project-search').click();
    expect(clean(await readFile(path.join(session.project, 'alpha.tex'), 'utf8'))).toBe(current.replace('needle', 'found'));
    expect(clean(await readFile(path.join(session.project, 'beta.tex'), 'utf8'))).toBe('needle beta\n');
    await expect(source(page)).toContainText('found alpha edited');
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).toContainText('needle alpha edited');
    await page.keyboard.press(`${modifier}+s`);
    await tool(page, 'document-history');
    await page.getByTestId('history-label').fill('Before revising the paragraphs');
    await page.getByTestId('record-history').click();
    await expect(page.getByTestId('history-status')).toContainText('現在の内容を記録');
    await page.getByTestId('edit-history-dialog').getByRole('button', { name: '閉じる', exact: true }).click();
    await replaceSource(page, 'Rewritten first\n\nKeep Alpha\n\nChanged final\n');
    await page.keyboard.press(`${modifier}+s`);
    await tool(page, 'document-history');
    await page.getByTestId('history-entries').getByRole('button').filter({ hasText: 'Before revising the paragraphs' }).click();
    await expect(page.getByTestId('history-changes').locator('input[data-hunk]')).toHaveCount(2);
    await page.getByTestId('history-changes').locator('input[data-hunk]').first().check();
    await page.screenshot({ path: testInfo.outputPath('selected-edit-history.png') });
    await page.getByTestId('restore-history-selection').click();
    await expect(source(page)).toContainText('needle alpha edited');
    await expect(source(page)).toContainText('Changed final');
    await source(page).click(); await page.keyboard.press(`${modifier}+z`);
    await expect(source(page)).toContainText('Rewritten first');
    await expect(source(page)).toContainText('Changed final');
    expect(errors).toEqual([]);
  });

  test('引用と相互参照の定義や使用箇所を開き，名前の変更を確認して保存する', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await writeFile(path.join(session.project, 'definitions.tex'), '\\section{Introduction}\n\\label{sec:workflow}\nA definition.\n');
    await writeFile(path.join(session.project, 'uses.tex'), 'See \\ref{sec:workflow} and \\cite{workflow2026}.\n% \\ref{sec:workflow}\n');
    await writeFile(path.join(session.project, 'workflow.bib'), '@article{workflow2026,\n title={A writing workflow},\n author={Writer, A.},\n year={2026}\n}\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-uses.tex').click();
    await tool(page, 'reference-tools');
    await page.locator('[data-reference-key="workflow2026"]').click();
    await expect(page.locator('.reference-details')).toContainText('A writing workflow');
    await page.locator('[data-reference-key="sec:workflow"]').click();
    await page.locator('.reference-details').getByRole('button', { name: 'definitions.tex:2', exact: true }).click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'definitions.tex');
    await page.locator('#editor-pane [data-navigation-back]').click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-path', 'uses.tex');
    await tool(page, 'reference-tools');
    await page.locator('[data-reference-key="sec:workflow"]').click();
    await page.getByTestId('reference-new-key').fill('sec:revised');
    await page.getByTestId('reference-preview-rename').click();
    await expect(page.getByTestId('reference-change-list')).toContainText('definitions.tex');
    await expect(page.getByTestId('reference-change-list')).toContainText('uses.tex');
    await page.screenshot({ path: testInfo.outputPath('rename-a-reference.png') });
    await page.getByTestId('reference-apply-rename').click();
    await expect(page.locator('.reference-status')).toContainText('名前を変更しました');
    expect(await readFile(path.join(session.project, 'definitions.tex'), 'utf8')).toContain('\\label{sec:revised}');
    expect(await readFile(path.join(session.project, 'uses.tex'), 'utf8')).toContain('See \\ref{sec:revised}');
    expect(await readFile(path.join(session.project, 'uses.tex'), 'utf8')).toContain('% \\ref{sec:workflow}');
    expect(errors).toEqual([]);
  });

  test('画像とコピーした表を挿入し，自分のテンプレートから新しいプロジェクトを作る', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await writeFile(path.join(session.project, 'notes.md'), '# Notes\n\n');
    await openProject(session); await openEditor(page, session); await setAutoSave(page, false);
    await page.getByTestId('file-notes.md').click();
    await source(page).click(); await page.keyboard.press(`${modifier}+End`);
    await tool(page, 'insert-image');
    await page.locator('#insert-image-file').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaXjwHwAE1AKEf31AsgAAAABJRU5ErkJggg==', 'base64') });
    await page.locator('#insert-image-path').fill('figures/pasted.png');
    await page.locator('#insert-image-caption').fill('A small figure');
    await page.locator('#insert-image-confirm').click();
    await expect(page.locator('#insert-image-dialog')).not.toBeVisible();
    await expect(source(page)).toContainText('figures/pasted.png');
    expect((await stat(path.join(session.project, 'figures', 'pasted.png'))).size).toBeGreaterThan(0);
    await tool(page, 'insert-table');
    await page.locator('#insert-table-input').fill('Name\tValue\nA&B\t2');
    await expect(page.locator('#insert-table-source')).toHaveValue(/\| Name \| Value \|/);
    await page.locator('#insert-table-confirm').click();
    await expect(source(page)).toContainText('| Name | Value |');
    await source(page).click(); await page.keyboard.press(`${modifier}+s`);
    const notes = clean(await readFile(path.join(session.project, 'notes.md'), 'utf8'));
    await tool(page, 'project-templates');
    await expect(page.locator('#template-list .template-card')).toHaveCount(4);
    await page.locator('#template-capture > summary').click();
    await page.locator('#template-capture-name').fill('My writing template');
    await page.locator('#template-save-current').click();
    await expect(page.locator('#template-list .template-card')).toHaveCount(5);
    await expect(page.locator('#template-list [aria-selected="true"]')).toContainText('My writing template');
    await page.locator('#template-parent').fill(session.temp);
    await page.locator('#template-project-name').fill('created-from-template');
    await page.screenshot({ path: testInfo.outputPath('user-project-template.png') });
    await page.locator('#template-create-project').click();
    await expect(page.locator('#template-dialog')).not.toBeVisible();
    const created = path.join(session.temp, 'created-from-template');
    await expect(page.locator('#project-root')).toHaveText(created);
    await page.getByTestId('file-notes.md').click();
    expect(clean(await readFile(path.join(created, 'notes.md'), 'utf8'))).toBe(notes);
    expect((await stat(path.join(created, 'figures', 'pasted.png'))).size).toBeGreaterThan(0);
    await expect(page.getByTestId('markdown-document')).toContainText('A&B');
    expect(errors).toEqual([]);
  });

  test('アウトラインと PDF から移動した原稿の行に，上端から同じ余白を付ける', async ({ page, session }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const lines = Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1}.`);
    lines[35] = '\\section{First destination}'; lines[170] = '\\section{Later destination}'; lines[198] = '\\section{Last destination}';
    await writeFile(path.join(session.project, 'positions.tex'), lines.join('\n'));
    await openProject(session); await openEditor(page, session);
    const { finished } = await compileFromUI(page, session);
    expect(finished.status, finished.log).toBe('success');
    await expect(page.getByTestId('pdf-canvas')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('file-positions.tex').click();
    await page.getByTestId('outline-tab').click();
    const offset = () => page.locator('#editor .synctex-line').evaluate(element => element.getBoundingClientRect().top - element.closest('.cm-scroller').getBoundingClientRect().top);
    const checkPosition = async line => {
      await expect(page.getByTestId('editor')).toHaveAttribute('data-line', String(line));
      await expect.poll(offset).toBeGreaterThan(25);
      await expect.poll(offset).toBeLessThan(105);
    };
    for (const line of [171, 36, 199]) {
      await page.locator(`#outline-tree .outline-link[data-line="${line}"]`).click();
      await checkPosition(line);
    }
    await page.route('**/api/synctex/inverse', route => route.fulfill({ json: { path: 'positions.tex', line: 171, column: 1 } }));
    await page.getByTestId('pdf-canvas').dblclick({ position: { x: 100, y: 100 } });
    await checkPosition(171);
    await page.screenshot({ path: testInfo.outputPath('source-destination-spacing.png') });
    await page.locator('#editor-pane [data-navigation-back]').click();
    await expect(page.getByTestId('editor')).toHaveAttribute('data-line', '199');
    expect(errors).toEqual([]);
  });
}
