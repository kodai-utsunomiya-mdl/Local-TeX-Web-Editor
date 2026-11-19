import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance, resolveAppearance } from '../web/src/appearance.js';

test('外観の初期値を選び，既存のライトとダークの設定を引き継ぐ', () => {
  const defaults = { mode: 'system', palette: 'gray', accent: 'teal', editorFont: 'consolas' };
  assert.deepEqual(normalizeAppearance(), defaults);
  assert.deepEqual(normalizeAppearance(null, 'dark'), { ...defaults, mode: 'dark' });
  assert.deepEqual(normalizeAppearance(undefined, 'light'), { ...defaults, mode: 'light' });
  assert.deepEqual(normalizeAppearance({ mode: 'system', palette: 'warm', accent: 'purple', editorFont: 'menlo' }, 'dark'),
    { mode: 'system', palette: 'warm', accent: 'purple', editorFont: 'menlo' });
  assert.deepEqual(normalizeAppearance({ mode: 'unknown', palette: '__proto__', accent: 'constructor', editorFont: 'url(example)' }), defaults);
});

test('システムモードは OS の設定に従い，明示したモードは同じまま使う', () => {
  assert.equal(resolveAppearance({ mode: 'system' }, false).theme, 'light');
  assert.equal(resolveAppearance({ mode: 'system' }, true).theme, 'dark');
  assert.equal(resolveAppearance({ mode: 'light' }, true).theme, 'light');
  assert.equal(resolveAppearance({ mode: 'dark' }, false).theme, 'dark');
  for (const font of ['default', 'cascadia', 'consolas', 'menlo', 'monospace']) {
    assert.match(resolveAppearance({ editorFont: font }).fontFamily, /(?:^|, )monospace$/);
  }
  assert.match(resolveAppearance({ editorFont: 'consolas' }).fontFamily, /^Consolas,/);
  assert.match(resolveAppearance({ editorFont: 'menlo' }).fontFamily, /^Menlo,/);
});

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + .05) / (Math.min(...values) + .05);
}

test('各配色とアクセントで本文，補足，ボタン，選択部分の文字を読めるコントラストにする', () => {
  for (const mode of ['light', 'dark']) for (const palette of ['default', 'gray', 'warm']) for (const accent of ['teal', 'blue', 'purple', 'orange', 'gray']) {
    const { colors } = resolveAppearance({ mode, palette, accent });
    for (const [foreground, background, minimum] of [
      ['text', 'surface', 7], ['secondary', 'subtle', 4.5], ['muted', 'subtle', 4.5],
      ['accent', 'surface', 4.5], ['accent', 'accent-soft', 4.5], ['text', 'selection', 4.5],
    ]) {
      assert.ok(contrast(colors[foreground], colors[background]) >= minimum, `${mode}, ${palette}, ${accent}: ${foreground} on ${background}`);
    }
    assert.ok(contrast('#ffffff', colors['accent-button']) >= 4.5, `${mode}, ${accent}: button`);
    assert.ok(contrast('#ffffff', colors['accent-dark']) >= 4.5, `${mode}, ${accent}: button hover`);
    assert.match(colors['line-highlight'], /^#[a-f\d]{8}$/i);
  }
});
