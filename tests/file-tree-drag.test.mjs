import test from 'node:test';
import assert from 'node:assert/strict';
import { fileTreeDropDestination, fileTreeDropPlacement, fileTreeKeyboardDrop, fileTreeScrollSpeed, validFileTreeDrop } from '../web/src/file-tree-drag.js';

const file = path => ({ path, directory: false });
const folder = path => ({ path, directory: true });

test('ファイルは行の前後，フォルダーは行の前後と中央を選べる', () => {
  const bounds = { top: 100, height: 32 };
  assert.equal(fileTreeDropPlacement(bounds, 101), 'before');
  assert.equal(fileTreeDropPlacement(bounds, 116), 'after');
  assert.equal(fileTreeDropPlacement(bounds, 101, true), 'before');
  assert.equal(fileTreeDropPlacement(bounds, 116, true), 'inside');
  assert.equal(fileTreeDropPlacement(bounds, 131, true), 'after');
  assert.equal(fileTreeDropPlacement({ top: 100, height: 16 }, 108, true), 'inside');
  for (const y of [99, 133, NaN, Infinity]) assert.equal(fileTreeDropPlacement(bounds, y, true), null);
  assert.equal(fileTreeDropPlacement({ top: 100, height: 0 }, 100, true), null);
});

test('前後の位置は対象と同じ階層，中への移動は対象フォルダーを使う', () => {
  const source = file('chapter/本文.md');
  for (const placement of ['before', 'after']) {
    const request = { source, target: file('appendix/existing.md'), placement };
    assert.ok(validFileTreeDrop(request));
    assert.equal(fileTreeDropDestination(request), 'appendix/本文.md');
  }
  const inside = { source, target: folder('figures'), placement: 'inside' };
  assert.ok(validFileTreeDrop(inside));
  assert.equal(fileTreeDropDestination(inside), 'figures/本文.md');
  const root = { source, target: folder(''), placement: 'root' };
  assert.ok(validFileTreeDrop(root));
  assert.equal(fileTreeDropDestination(root), '本文.md');
});

test('フォルダーを自分自身やその子へ移す要求を受け付けない', () => {
  const source = folder('chapter');
  for (const placement of ['before', 'after', 'inside']) {
    assert.equal(validFileTreeDrop({ source, target: folder('chapter'), placement }), false);
    assert.equal(validFileTreeDrop({ source, target: folder('chapter/sub'), placement }), false);
    assert.equal(validFileTreeDrop({ source, target: file('chapter/sub/body.md'), placement }), false);
  }
  assert.ok(validFileTreeDrop({ source, target: folder('chapter-two'), placement: 'inside' }));
  assert.ok(validFileTreeDrop({ source: folder('chapter/sub'), target: folder('chapter-two'), placement: 'after' }));
});

test('同じフォルダーへの移動やファイル内への移動を受け付けない', () => {
  assert.equal(validFileTreeDrop({ source: file('chapter/body.md'), target: folder('chapter'), placement: 'inside' }), false);
  assert.equal(validFileTreeDrop({ source: file('body.md'), target: folder(''), placement: 'root' }), false);
  assert.equal(validFileTreeDrop({ source: file('body.md'), target: file('notes.md'), placement: 'inside' }), false);
  assert.equal(validFileTreeDrop({ source: file('body.md'), target: folder('chapter'), placement: 'root' }), false);
  assert.equal(validFileTreeDrop({ source: folder(''), target: folder('chapter'), placement: 'inside' }), false);
  assert.equal(validFileTreeDrop({ source: file('body.md'), target: folder(''), placement: 'before' }), false);
  assert.equal(validFileTreeDrop({ source: file('body.md'), target: folder('chapter'), placement: 'unknown' }), false);
  assert.equal(validFileTreeDrop(null), false);
});

test('Alt と上下のキーで同じ階層の隣の行へ移す要求を作る', () => {
  const entries = [file('intro.md'), folder('chapter'), file('chapter/body.md'), file('notes.md')];
  assert.deepEqual(fileTreeKeyboardDrop(entries, 'chapter', -1), { source: folder('chapter'), target: file('intro.md'), placement: 'before' });
  assert.deepEqual(fileTreeKeyboardDrop(entries, 'chapter', 1), { source: folder('chapter'), target: file('notes.md'), placement: 'after' });
  assert.equal(fileTreeKeyboardDrop(entries, 'intro.md', -1), null);
  assert.equal(fileTreeKeyboardDrop(entries, 'notes.md', 1), null);
  assert.equal(fileTreeKeyboardDrop(entries, 'chapter/body.md', 1), null);
  assert.equal(fileTreeKeyboardDrop(entries, 'missing.md', 1), null);
  assert.equal(fileTreeKeyboardDrop(entries, 'notes.md', 0), null);
});

test('一覧の端に近いほど速くスクロールし，中央や外側では止まる', () => {
  const bounds = { top: 100, height: 300 };
  assert.equal(fileTreeScrollSpeed(bounds, 100), -480);
  assert.equal(fileTreeScrollSpeed(bounds, 400), 480);
  assert.ok(fileTreeScrollSpeed(bounds, 110) < fileTreeScrollSpeed(bounds, 130));
  assert.ok(fileTreeScrollSpeed(bounds, 390) > fileTreeScrollSpeed(bounds, 370));
  for (const y of [99, 250, 401, NaN]) assert.equal(fileTreeScrollSpeed(bounds, y), 0);
  assert.ok(fileTreeScrollSpeed({ top: 0, height: 30 }, 2) < 0);
  assert.ok(fileTreeScrollSpeed({ top: 0, height: 30 }, 28) > 0);
  assert.equal(fileTreeScrollSpeed({ top: 0, height: 0 }, 0), 0);
});
