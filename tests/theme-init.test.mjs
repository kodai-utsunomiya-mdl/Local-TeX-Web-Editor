import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../web/src/theme-init.js', import.meta.url), 'utf8');

function initialTheme({ appearance = null, legacy = null, systemDark = false, blocked = false } = {}) {
  const root = { dataset: {}, style: {} };
  runInNewContext(script, {
    document: { documentElement: root },
    localStorage: { getItem(key) {
      if (blocked) throw new Error('Browser storage is unavailable');
      return key.endsWith('-appearance') ? JSON.stringify(appearance) : legacy;
    } },
    matchMedia: () => ({ matches: systemDark }),
  });
  return { theme: root.dataset.theme, colorScheme: root.style.colorScheme };
}

test('the first paint uses dark mode even when the operating system uses light mode', () => {
  assert.deepEqual(initialTheme(), { theme: 'dark', colorScheme: 'dark' });
  assert.deepEqual(initialTheme({ systemDark: true }), { theme: 'dark', colorScheme: 'dark' });
  assert.deepEqual(initialTheme({ blocked: true }), { theme: 'dark', colorScheme: 'dark' });
});

test('a saved appearance mode is applied before the editor loads', () => {
  assert.deepEqual(initialTheme({ appearance: { mode: 'light' }, legacy: 'dark', systemDark: true }), { theme: 'light', colorScheme: 'light' });
  assert.deepEqual(initialTheme({ appearance: { mode: 'dark' }, legacy: 'light' }), { theme: 'dark', colorScheme: 'dark' });
  assert.deepEqual(initialTheme({ appearance: { mode: 'system' }, systemDark: false }), { theme: 'light', colorScheme: 'light' });
  assert.deepEqual(initialTheme({ appearance: { mode: 'system' }, systemDark: true }), { theme: 'dark', colorScheme: 'dark' });
});

test('older light and dark preferences still apply before the editor loads', () => {
  assert.deepEqual(initialTheme({ legacy: 'light', systemDark: true }), { theme: 'light', colorScheme: 'light' });
  assert.deepEqual(initialTheme({ legacy: 'dark' }), { theme: 'dark', colorScheme: 'dark' });
  assert.deepEqual(initialTheme({ appearance: { mode: 'unknown' }, legacy: 'unknown' }), { theme: 'dark', colorScheme: 'dark' });
});
