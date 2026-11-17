import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getLanguage, setLanguage, t } from '../web/src/i18n.js';
import { english } from '../web/src/locales/en.js';
import { renderMarkdownHTML } from '../web/src/markdown-preview.js';

test('a new installation uses English and the UI can switch languages', () => {
  assert.equal(getLanguage(), 'en');
  assert.equal(t('コンパイル'), 'Compile');
  setLanguage('ja');
  assert.equal(t('コンパイル'), 'コンパイル');
  setLanguage('en');
  assert.equal(t('設定'), 'Settings');
});

test('translated messages insert document names without changing their content', () => {
  const name = '原稿/設定とコンパイル {value1}.tex';
  setLanguage('en');
  assert.equal(t('{value0} を閉じる', { value0: name }), `Close ${name}`);
  setLanguage('ja');
  assert.equal(t('{value0} を閉じる', { value0: name }), `${name} を閉じる`);
  setLanguage('en');
});

test('language changes translate Markdown controls and leave document text intact', () => {
  const content = '# 設定\n\nコンパイルと原稿を日本語で書く．\n\n- [x] 実験を確認する';
  setLanguage('ja');
  const japanese = renderMarkdownHTML(content);
  setLanguage('en');
  const englishHTML = renderMarkdownHTML(content);
  assert.match(japanese, /aria-label="完了"/);
  assert.match(englishHTML, /aria-label="Complete"/);
  assert.equal(englishHTML.replace('aria-label="Complete"', 'aria-label="完了"'), japanese);
});

test('all static UI labels have English translations with the same parameters', async () => {
  for (const [key, value] of Object.entries(english)) {
    assert.ok(value.trim(), key);
    const parameters = text => [...new Set(text.match(/\{[A-Za-z]\w*\}/g) || [])].sort();
    assert.deepEqual(parameters(value), parameters(key), key);
  }
  for (const file of ['index.html', 'pdf-search.js']) {
    const source = await readFile(new URL(`../web/src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
      const key = match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
      assert.ok(english[key], `${file}: ${key}`);
    }
  }
});
