import test from 'node:test';
import assert from 'node:assert/strict';
import { historyHunks, restoreHistoryHunks } from '../web/src/history-diff.js';

test('restoring one paragraph leaves another edited paragraph in place', () => {
  const before = '見出し\n以前の段落😀\n共通の段落\n以前の結論\n';
  const current = '見出し\n新しい段落😀\n共通の段落\n新しい結論\n';
  const hunks = historyHunks(before, current);
  assert.equal(hunks.length, 2);
  assert.equal(restoreHistoryHunks(current, hunks, new Set([0])), '見出し\n以前の段落😀\n共通の段落\n新しい結論\n');
  assert.equal(restoreHistoryHunks(current, hunks, new Set([0, 1])), before);
});

test('history handles inserted and deleted lines, empty documents, and missing final newlines', () => {
  for (const [before, current] of [['', '追加'], ['削除\n', ''], ['a\nb\nc', 'a\nc'], ['a\nc', 'a\nb\nc'], ['a\n', 'a'], ['\n', '😀'], ['😀\n二\n', '😀\n三\n']]) {
    const hunks = historyHunks(before, current);
    assert.equal(restoreHistoryHunks(current, hunks, new Set(hunks.map((_, index) => index))), before, JSON.stringify({ before, current, hunks }));
  }
});

test('large rewrites use a bounded comparison and can still be restored', () => {
  for (const [before, current] of [
    ['先頭\n' + 'old\n'.repeat(2000) + '末尾\n', '先頭\n' + 'new\n'.repeat(2000) + '末尾\n'],
    ['\n'.repeat(21000), 'a' + '\n'.repeat(21000)],
    ['a\n'.repeat(21000), 'a\n'.repeat(20000) + 'b\n'.repeat(1000)],
  ]) {
    const hunks = historyHunks(before, current);
    assert.equal(hunks.length, 1);
    assert.equal(restoreHistoryHunks(current, hunks, new Set([0])), before);
  }
});

test('restoration refuses a changed text range', () => {
  const hunks = historyHunks('before\n', 'after\n');
  assert.throws(() => restoreHistoryHunks('a later edit\n', hunks, new Set([0])), /changed/);
});
