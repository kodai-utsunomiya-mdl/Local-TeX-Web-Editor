import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePanelLayout, normalizePanelLayout } from '../web/src/panel-layout.js';

test('既存の配置ではプレビューを表示し，明示した表示設定を読み込む', () => {
  assert.deepEqual(normalizePanelLayout(), { sidebarWidth: null, editorRatio: .5, logHeight: null, previewVisible: true });
  assert.equal(normalizePanelLayout({ sidebarWidth: 300, editorRatio: .7, logHeight: 180 }).previewVisible, true);
  assert.deepEqual(normalizePanelLayout({ sidebarWidth: 300, editorRatio: .7, logHeight: 180, previewVisible: false }),
    { sidebarWidth: 300, editorRatio: .7, logHeight: 180, previewVisible: false });
  assert.deepEqual(normalizePanelLayout({ sidebarWidth: -1, editorRatio: Infinity, logHeight: NaN, previewVisible: 'false' }), normalizePanelLayout());
  assert.equal(normalizePanelLayout({ editorRatio: -3 }).editorRatio, 0);
  assert.equal(normalizePanelLayout({ editorRatio: 5 }).editorRatio, 1);
});

test('境界を左右の端へ動かしても，原稿とプレビューで残りの幅を使う', () => {
  for (const width of [901, 1000, 1031.46875, 1439.46875, 1920, 3840]) {
    for (const sidebarCollapsed of [false, true]) for (const editorRatio of [0, .2, .5, .8, 1]) {
      const layout = calculatePanelLayout({ width, height: 800, sidebarCollapsed, preferences: { editorRatio } });
      const { editor, previewWidth, editorSpace, editorFactor, previewFactor } = layout;
      assert.ok(editor.value >= 260);
      assert.ok(previewWidth >= 260 - 1e-10);
      assert.ok(Math.abs(editor.value + previewWidth - editorSpace) < 1e-10);
      assert.ok(editorFactor >= 1 && previewFactor >= 1);
      assert.ok(Math.abs(editorSpace * editorFactor / (editorFactor + previewFactor) - editor.value) < 1e-10);
      assert.equal(sidebarCollapsed ? 5 + editorSpace : layout.sidebar.value + 10 + editorSpace, width);
    }
  }
});

test('プレビューを隠すと原稿が広がり，再表示すると指定していた比率へ戻る', () => {
  const preferences = { sidebarWidth: 280, editorRatio: .73, logHeight: 240 };
  const original = calculatePanelLayout({ width: 1440, height: 800, preferences });
  const hidden = calculatePanelLayout({ width: 1440, height: 800, preferences: { ...preferences, previewVisible: false } });
  assert.equal(hidden.editor.value, 1440 - 280 - 5);
  assert.equal(hidden.previewWidth, 0);
  assert.equal(hidden.preferences.editorRatio, preferences.editorRatio);
  assert.equal(hidden.log.value, 240);
  const restored = calculatePanelLayout({ width: 1440, height: 800, preferences: { ...hidden.preferences, previewVisible: true } });
  assert.equal(restored.editor.value, original.editor.value);
  assert.equal(restored.previewWidth, original.previewWidth);
  const withoutSidebar = calculatePanelLayout({ width: 1440, height: 800, sidebarCollapsed: true, preferences: hidden.preferences });
  assert.equal(withoutSidebar.editor.value, 1440);
});

test('狭い画面では表示中の画面で幅を使い，画面を広げると元の配置へ戻る', () => {
  const preferences = { sidebarWidth: 700, editorRatio: .68, logHeight: 600 };
  const wide = calculatePanelLayout({ width: 1440, height: 820, preferences });
  const narrow = calculatePanelLayout({ width: 800, height: 420, singlePane: true, preferences });
  assert.equal(narrow.sidebar.value, 535);
  assert.equal(narrow.editor.value, 260);
  assert.equal(narrow.previewWidth, 0);
  assert.equal(narrow.log.value, 260);
  assert.equal(narrow.preferences.sidebarWidth, 700);
  assert.equal(narrow.preferences.logHeight, 600);
  const phone = calculatePanelLayout({ width: 390, height: 550, overlay: true, singlePane: true, preferences });
  assert.equal(phone.editor.value, 390);
  assert.equal(phone.sidebar.value, 350);
  const restored = calculatePanelLayout({ width: 1440, height: 820, preferences: phone.preferences });
  assert.equal(restored.editor.value, wide.editor.value);
  assert.equal(restored.sidebar.value, wide.sidebar.value);
  assert.equal(restored.log.value, wide.log.value);
});

test('幅と高さが小さい場合も，列とログを利用可能な範囲に収める', () => {
  for (const width of [15, 200, 519.5]) for (const previewVisible of [false, true]) {
    const layout = calculatePanelLayout({ width, height: 100, preferences: { previewVisible, editorRatio: .9 } });
    assert.ok(layout.editor.minimum >= 0);
    assert.ok(layout.editor.value <= layout.editorSpace);
    assert.ok(layout.previewWidth >= 0);
    assert.ok(layout.log.value <= 50);
    assert.ok(Number.isFinite(layout.editorFactor) && Number.isFinite(layout.previewFactor));
  }
  assert.equal(calculatePanelLayout({ width: 0, height: 800 }), null);
  assert.equal(calculatePanelLayout({ width: 1440, height: 0 }), null);
});
