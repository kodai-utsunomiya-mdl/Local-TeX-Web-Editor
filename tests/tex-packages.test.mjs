import test from 'node:test';
import assert from 'node:assert/strict';
import { teXPackagePresets } from '../web/src/tex-packages.js';

test('Windows package choices include the SyncTeX executable package and Japanese typesetting', () => {
  const choices = teXPackagePresets({ shell: 'powershell', programs: [] });
  assert.deepEqual(choices.basic, ['latexmk', 'synctex', 'synctex.windows']);
  assert.deepEqual(choices.japanese, ['collection-langjapanese', 'latexmk', 'synctex', 'synctex.windows']);
  assert.deepEqual(choices.suggested, choices.basic);
  assert.equal(choices.reinstall, false);
});

test('missing base programs supply the packages to review without adding available programs again', () => {
  const choices = teXPackagePresets({ shell: 'powershell', programs: [
    { name: 'latexmk', available: true, packages: ['latexmk'] },
    { name: 'synctex', available: false, packages: ['synctex', 'synctex.windows', 'synctex'] },
    { name: 'xelatex', available: false, packages: ['xetex'] },
  ] });
  assert.deepEqual(choices.suggested, ['synctex', 'synctex.windows']);
  assert.equal(choices.reinstall, true);
  assert.deepEqual(teXPackagePresets({ shell: 'posix' }).basic, ['latexmk', 'synctex']);
  assert.deepEqual(teXPackagePresets().suggested, ['latexmk', 'synctex']);
});
