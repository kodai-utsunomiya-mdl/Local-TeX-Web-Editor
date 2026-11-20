import test from 'node:test';
import assert from 'node:assert/strict';
import { fileTemplatePathSuggestion, fileTemplatePreview } from '../web/src/file-template-picker.js';

test('テンプレートのファイル名を，右クリックで指定したフォルダー内の候補にする', () => {
  assert.equal(fileTemplatePathSuggestion({ templatePath: 'parts/main.tex' }), 'main.tex');
  assert.equal(fileTemplatePathSuggestion({ current: 'notes/', folder: 'notes', templatePath: 'parts/日本語.md' }), 'notes/日本語.md');
  assert.equal(fileTemplatePathSuggestion({ current: 'notes/old.tex', folder: 'notes', previousSuggestion: 'notes/old.tex', templatePath: 'notes.md' }), 'notes/notes.md');
  assert.equal(fileTemplatePathSuggestion({ current: 'nested/notes/', folder: 'nested/notes/', templatePath: 'sections\\body.tex' }), 'nested/notes/body.tex');
});

test('入力済みのファイル名はテンプレートを替えても変えない', () => {
  assert.equal(fileTemplatePathSuggestion({ current: 'my-paper.tex', templatePath: 'main.tex' }), 'my-paper.tex');
  assert.equal(fileTemplatePathSuggestion({ current: 'notes/my.md', folder: 'notes', templatePath: 'main.tex', edited: true }), 'notes/my.md');
  assert.equal(fileTemplatePathSuggestion({ current: '', templatePath: 'main.tex', edited: true }), '');
  assert.equal(fileTemplatePathSuggestion({ current: 'notes/', folder: 'notes', templatePath: 'main.tex', edited: true }), 'notes/');
});

test('プレビューを短く表示する場合も元の全文や Unicode の文字を変えない', () => {
  const ordinary = '# 日本語\n\n<script>example</script>\n';
  assert.deepEqual(fileTemplatePreview(ordinary), { content: ordinary, truncated: false });
  const original = 'abc😀def';
  assert.deepEqual(fileTemplatePreview(original, 4), { content: 'abc', truncated: true });
  assert.deepEqual(fileTemplatePreview(original, 5), { content: 'abc😀', truncated: true });
  assert.equal(original, 'abc😀def');
  assert.deepEqual(fileTemplatePreview(''), { content: '', truncated: false });
});
