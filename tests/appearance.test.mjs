import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance, normalizeHexColor, resolveAppearance } from '../web/src/appearance.js';

test('外観の初期値を選び，既存のライトとダークの設定を引き継ぐ', () => {
  const defaults = { mode: 'dark', palette: 'gray', accent: 'blue', editorFont: 'consolas' };
  assert.deepEqual(normalizeAppearance(), defaults);
  assert.deepEqual(normalizeAppearance(null, 'dark'), { ...defaults, mode: 'dark' });
  assert.deepEqual(normalizeAppearance(undefined, 'light'), { ...defaults, mode: 'light' });
  assert.deepEqual(normalizeAppearance({ palette: 'black' }), { ...defaults, palette: 'black' });
  assert.deepEqual(normalizeAppearance({ accent: 'teal' }), { ...defaults, accent: 'teal' });
  assert.deepEqual(normalizeAppearance({ mode: 'system', palette: 'warm', accent: 'purple', editorFont: 'menlo' }, 'dark'),
    { mode: 'system', palette: 'warm', accent: 'purple', editorFont: 'menlo' });
  assert.deepEqual(normalizeAppearance({ mode: 'unknown', palette: '__proto__', accent: 'constructor', editorFont: 'url(example)' }), defaults);
  assert.equal(normalizeAppearance({ editorFont: 'default' }).editorFont, 'cascadia');
});

test('システムモードは OS の設定に従い，明示したモードは同じまま使う', () => {
  assert.equal(resolveAppearance(undefined, false).theme, 'dark');
  assert.equal(resolveAppearance(undefined, true).theme, 'dark');
  assert.equal(resolveAppearance({ mode: 'system' }, false).theme, 'light');
  assert.equal(resolveAppearance({ mode: 'system' }, true).theme, 'dark');
  assert.equal(resolveAppearance({ mode: 'light' }, true).theme, 'light');
  assert.equal(resolveAppearance({ mode: 'dark' }, false).theme, 'dark');
  for (const font of ['default', 'cascadia', 'consolas', 'menlo', 'monaco', 'sfmono', 'dejavu', 'liberation', 'fira', 'jetbrains', 'monospace']) {
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
  for (const mode of ['light', 'dark']) for (const palette of ['default', 'gray', 'black', 'warm', 'navy', 'forest', 'plum']) for (const accent of ['teal', 'blue', 'purple', 'orange', 'gray', 'green', 'red', 'pink']) {
    const { colors } = resolveAppearance({ mode, palette, accent });
    for (const [foreground, background, minimum] of [
      ['text', 'surface', 7], ['secondary', 'subtle', 4.5], ['muted', 'subtle', 4.5],
      ['accent', 'surface', 4.5], ['accent', 'accent-soft', 4.5], ['text', 'selection', 4.5],
      ['popup-text', 'popup-surface', 4.5], ['popup-muted', 'popup-surface', 4.5],
      ['popup-text', 'popup-accent-soft', 4.5], ['popup-accent', 'popup-accent-soft', 4.5],
      ['popup-border', 'surface', 3], ['popup-border', 'popup-surface', 3],
    ]) {
      assert.ok(contrast(colors[foreground], colors[background]) >= minimum, `${mode}, ${palette}, ${accent}: ${foreground} on ${background}`);
    }
    assert.ok(contrast('#ffffff', colors['accent-button']) >= 4.5, `${mode}, ${accent}: button`);
    assert.ok(contrast('#ffffff', colors['accent-dark']) >= 4.5, `${mode}, ${accent}: button hover`);
    assert.match(colors['line-highlight'], /^#[a-f\d]{8}$/i);
    assert.notEqual(colors['popup-surface'], colors.surface);
    for (const status of ['success', 'warning', 'danger']) {
      assert.ok(contrast(colors[status], colors[`${status}-bg`]) >= 4.5, `${mode}, ${palette}: ${status}`);
      assert.ok(contrast(colors[status], colors.surface) >= 4.5, `${mode}, ${palette}: ${status} on surface`);
    }
  }
});

test('カラーコードを読み取り，ライトとダークの設定を別々に保存する', () => {
  assert.equal(normalizeHexColor(' #AbC '), '#aabbcc');
  assert.equal(normalizeHexColor('00FF88'), '#00ff88');
  for (const value of ['', '#12', '#11223344', 'red', 'url(example)', {}, null]) assert.equal(normalizeHexColor(value), '');
  const input = { customColors: { light: { background: '#FaFAF0', foreground: '#234', accent: 'ab0000', extra: 'ignored' }, dark: { background: '#12212C', foreground: '#DDEEFF', accent: '#DEF' }, system: { background: '#f00' } } };
  const appearance = normalizeAppearance(input);
  assert.deepEqual(appearance.customColors, {
    light: { background: '#fafaf0', foreground: '#223344', accent: '#ab0000' },
    dark: { background: '#12212c', foreground: '#ddeeff', accent: '#ddeeff' },
  });
  assert.equal(input.customColors.light.background, '#FaFAF0');
  const light = resolveAppearance({ ...appearance, mode: 'light' }).colors, dark = resolveAppearance({ ...appearance, mode: 'dark' }).colors;
  assert.equal(light.surface, '#fafaf0'); assert.equal(light.text, '#223344'); assert.equal(light['accent-button'], '#ab0000');
  assert.equal(dark.surface, '#12212c'); assert.equal(dark.text, '#ddeeff'); assert.equal(dark['accent-button'], '#ddeeff');
  assert.ok(contrast(dark['accent-on-button'], dark['accent-button']) >= 4.5);
  assert.ok(contrast(dark['accent-on-button-hover'], dark['accent-dark']) >= 4.5);
  assert.deepEqual(normalizeAppearance({ customColors: { light: { background: '#bad-color' }, dark: {} } }), normalizeAppearance());
});

test('指定した背景色に合わせて補足，通知，警告の文字色と周囲の色を更新する', () => {
  for (const mode of ['light', 'dark']) for (const background of ['#000000', '#ffffff', '#12212c', '#aabbcc', '#6b6b6b', '#737373', '#777777', '#0000ff']) {
    const { colors } = resolveAppearance({ mode, customColors: { [mode]: { background, accent: '#ffe08a' } } });
    assert.equal(colors.surface, background);
    for (const key of ['secondary', 'muted']) assert.ok(contrast(colors[key], colors.subtle) >= 4.5, `${background}: ${key}`);
    for (const key of ['success', 'warning', 'danger']) {
      assert.ok(contrast(colors[key], colors[`${key}-bg`]) >= 4.5, `${background}: ${key}`);
      assert.ok(contrast(colors[key], colors.surface) >= 4.5, `${background}: ${key} on surface`);
      assert.notEqual(colors[`${key}-bg`], background);
    }
    assert.ok(contrast(colors['accent-on-button'], colors['accent-button']) >= 4.5);
    assert.notEqual(colors.hover, colors.surface);
    assert.notEqual(colors['popup-surface'], colors.surface);
    for (const key of ['popup-text', 'popup-muted', 'popup-accent', 'popup-warning', 'popup-danger']) {
      for (const surface of ['popup-surface', 'popup-accent-soft']) assert.ok(contrast(colors[key], colors[surface]) >= 4.5, `${background}: ${key} on ${surface}`);
    }
    for (const surface of ['surface', 'popup-surface']) assert.ok(contrast(colors['popup-border'], colors[surface]) >= 3, `${background}: popup border on ${surface}`);
  }
});
