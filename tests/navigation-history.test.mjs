import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationHistory, connectPDFNavigation } from '../web/src/navigation-history.js';

test('navigation returns to the exact position before a PDF reference link', async () => {
  let position = { kind: 'pdf', main: 'paper.tex', pageNumber: 3, top: 412.4, left: 14, zoom: '1.5' };
  const original = structuredClone(position);
  const history = new NavigationHistory({ capture: () => position, restore: value => { position = value; } });
  await history.navigate(() => { position = { ...position, pageNumber: 12, top: 700 }; });
  position = { ...position, top: 680 };
  const afterReading = structuredClone(position);
  assert.equal(history.canBack, true);
  await history.back();
  assert.deepEqual(position, original);
  await history.forward();
  assert.deepEqual(position, afterReading);
});

test('nested source and preview moves become one navigation entry', async () => {
  let position = { path: 'intro.tex', line: 40 };
  const history = new NavigationHistory({ capture: () => position, restore: value => { position = value; }, limit: 2 });
  await history.navigate(async () => {
    position = { path: 'appendix.tex', line: 1 };
    await history.navigate(() => { position = { path: 'appendix.tex', line: 80 }; });
  });
  assert.equal(history.previous.length, 1);
  await history.back();
  assert.deepEqual(position, { path: 'intro.tex', line: 40 });
  await history.navigate(() => { position = { path: 'methods.tex', line: 5 }; });
  assert.equal(history.canForward, false);
  for (let line = 6; line < 10; line++) await history.navigate(() => { position = { path: 'methods.tex', line }; });
  assert.equal(history.previous.length, 2);
});

test('unavailable destinations stay in history and project changes discard pending jumps', async () => {
  let position = { path: 'a.tex' };
  let missing = true;
  const history = new NavigationHistory({ capture: () => position, restore: value => { if (missing) return false; position = value; } });
  await history.navigate(() => { position = { path: 'b.tex' }; });
  assert.equal(await history.back(), false);
  assert.equal(history.canBack, true);
  missing = false;
  assert.equal(await history.back(), true);
  await history.navigate(async () => { history.clear(); position = { path: 'other-project.tex' }; });
  assert.equal(history.canBack, false);
  assert.equal(history.canForward, false);
});

test('PDF navigation waits for a named destination before recording its result', async () => {
  let page = 1;
  const service = {
    async goToDestination() { await Promise.resolve(); page = 5; },
    goToPage(value) { page = value; }, setHash() {}, executeNamedAction() {},
  };
  const history = new NavigationHistory({ capture: () => ({ page }), restore: value => { page = value.page; } });
  connectPDFNavigation(service, action => history.navigate(action), async () => {});
  await service.goToDestination('appendix');
  assert.equal(page, 5);
  await history.back();
  assert.equal(page, 1);
});

test('source edits move the saved offsets in both navigation directions', async () => {
  let location = { source: { path: 'main.tex', anchor: 10, head: 12 } };
  const history = new NavigationHistory({ capture: () => location, restore: value => { location = value; } });
  await history.navigate(() => { location = { source: { path: 'appendix.tex', anchor: 80, head: 80 } }; });
  await history.navigate(() => { location = { source: { path: 'main.tex', anchor: 200, head: 210 } }; });
  await history.back();
  history.mapEntries(entry => entry.source.path === 'main.tex' ? {
    ...entry, source: { ...entry.source, anchor: entry.source.anchor + 6, head: entry.source.head + 6 },
  } : entry);
  await history.back();
  assert.deepEqual(location.source, { path: 'main.tex', anchor: 16, head: 18 });
  await history.forward(); await history.forward();
  assert.deepEqual(location.source, { path: 'main.tex', anchor: 206, head: 216 });
});
