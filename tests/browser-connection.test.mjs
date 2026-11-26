import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreBrowserToken, browserTokenKey } from '../web/src/browser-connection.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('a restored tab can use the connection after its browser session ends', () => {
  const localStorage = storage(), sessionStorage = storage();
  assert.equal(restoreBrowserToken('launch-key', { localStorage, sessionStorage }), 'launch-key');
  const restartedSession = storage();
  assert.equal(restoreBrowserToken('', { localStorage, sessionStorage: restartedSession }), 'launch-key');
  assert.equal(restartedSession.getItem(browserTokenKey), 'launch-key');
});

test('a fresh launch replaces a previous browser connection', () => {
  const localStorage = storage(), sessionStorage = storage();
  restoreBrowserToken('old-key', { localStorage, sessionStorage });
  assert.equal(restoreBrowserToken('new-key', { localStorage, sessionStorage }), 'new-key');
  assert.equal(localStorage.getItem(browserTokenKey), 'new-key');
  assert.equal(sessionStorage.getItem(browserTokenKey), 'new-key');
});

test('the launch URL works when the browser does not allow saved connections', () => {
  const blocked = { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } };
  assert.equal(restoreBrowserToken('launch-key', { localStorage: blocked, sessionStorage: blocked }), 'launch-key');
  assert.equal(restoreBrowserToken('', { localStorage: blocked, sessionStorage: blocked }), '');
});
