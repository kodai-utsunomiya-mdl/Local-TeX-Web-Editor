import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTree, captureFileOrder, mapFileOrder, normalizeFileOrder, placeInFileOrder } from '../web/src/file-sorting.js';

const project = { directories: ['chapters', 'figures', 'chapters/empty'], files: [
  { path: 'a.tex' }, { path: 'b.tex' }, { path: 'c.tex' },
  { path: 'chapters/one.tex' }, { path: 'chapters/two.tex' },
] };
const entries = tree => tree.entries.map(entry => entry.path);

test('manual order starts from the visible sort and can place files among folders', () => {
  const before = captureFileOrder(project, { sort: 'name-desc' });
  assert.deepEqual(before[''], ['figures', 'chapters', 'c.tex', 'b.tex', 'a.tex']);
  const moved = placeInFileOrder(before, 'b.tex', { anchor: 'chapters' });
  assert.deepEqual(entries(buildFileTree(project, { sort: 'manual', fileOrder: moved })), ['figures', 'b.tex', 'chapters', 'c.tex', 'a.tex']);
  assert.deepEqual(before[''], ['figures', 'chapters', 'c.tex', 'b.tex', 'a.tex']);
  assert.deepEqual(entries(buildFileTree(project, { sort: 'name-asc', fileOrder: moved })), ['chapters', 'figures', 'a.tex', 'b.tex', 'c.tex']);
});

test('manual order survives filtering and appends newly created entries', () => {
  const order = { '': ['c.tex', 'b.tex', 'a.tex', 'chapters', 'figures'], chapters: ['chapters/two.tex', 'chapters/one.tex', 'chapters/empty'] };
  assert.deepEqual(entries(buildFileTree(project, { sort: 'manual', fileOrder: order, filter: '.tex' })), ['c.tex', 'b.tex', 'a.tex', 'chapters']);
  const added = { ...project, files: [...project.files, { path: 'new.tex' }] };
  assert.deepEqual(entries(buildFileTree(added, { sort: 'manual', fileOrder: order })), ['c.tex', 'b.tex', 'a.tex', 'chapters', 'figures', 'new.tex']);
});

test('renaming or moving a folder updates its nested orders and deletion removes them', () => {
  const order = captureFileOrder(project);
  order.chapters = ['chapters/two.tex', 'chapters/empty', 'chapters/one.tex'];
  const renamed = mapFileOrder(order, 'chapters', 'sections', true);
  assert.deepEqual(renamed.sections, ['sections/two.tex', 'sections/empty', 'sections/one.tex']);
  assert.deepEqual(renamed[''], ['sections', 'figures', 'a.tex', 'b.tex', 'c.tex']);
  assert.equal(renamed.chapters, undefined);
  const moved = mapFileOrder(renamed, 'sections', 'figures/sections', true);
  assert.deepEqual(moved[''], ['figures', 'a.tex', 'b.tex', 'c.tex']);
  assert.deepEqual(moved['figures/sections'], ['figures/sections/two.tex', 'figures/sections/empty', 'figures/sections/one.tex']);
  const removed = mapFileOrder(moved, 'figures/sections', '', true, true);
  assert.equal(removed['figures/sections'], undefined);
});

test('moving a file changes the destination order and leaves other siblings in place', () => {
  const order = mapFileOrder(captureFileOrder(project), 'b.tex', 'chapters/b.tex', false);
  const moved = placeInFileOrder(order, 'chapters/b.tex', { anchor: 'chapters/two.tex', after: true });
  assert.deepEqual(moved[''], ['chapters', 'figures', 'a.tex', 'c.tex']);
  assert.deepEqual(moved.chapters, ['chapters/empty', 'chapters/one.tex', 'chapters/two.tex', 'chapters/b.tex']);
});

test('stored manual orders accept only unique children of the specified folder', () => {
  assert.deepEqual(normalizeFileOrder({ '': ['a.tex', 'a.tex', 'chapters/a.tex', null], chapters: ['chapters/a.tex', 'b.tex'], bad: false }), { '': ['a.tex'], chapters: ['chapters/a.tex'] });
  const names = { directories: ['__proto__'], files: [{ path: '__proto__/one.tex' }] };
  const order = captureFileOrder(names);
  assert.deepEqual(Object.keys(order), ['', '__proto__']);
  assert.deepEqual(order.__proto__, ['__proto__/one.tex']);
  assert.deepEqual(captureFileOrder(names, { sort: 'manual', fileOrder: {} }).__proto__, ['__proto__/one.tex']);
  assert.deepEqual(placeInFileOrder({}, '__proto__/one.tex').__proto__, ['__proto__/one.tex']);
});
