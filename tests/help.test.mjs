import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvironmentInfo, getHelpLinks, getHelpShortcuts } from '../web/src/help.js';
import { setLanguage } from '../web/src/i18n.js';

test.beforeEach(() => setLanguage('en'));

test('ヘルプのリンクは表示言語とアプリの配布形態に対応する', () => {
  const english = getHelpLinks('en');
  const japanese = getHelpLinks('ja');
  assert.equal(english.guide, 'https://kodai-utsunomiya-mdl.github.io/Local-TeX-Web-Editor/');
  assert.equal(japanese.guide, english.guide + 'ja/');
  assert.equal(english.update, english.releases);
  assert.equal(japanese.update, japanese.releases);
  assert.match(english.issues, /\/Local-TeX-Web-Editor\/issues$/);
  assert.equal(getHelpLinks('ja', true).update, 'https://apps.microsoft.com/detail/9P6QF32N19HG?hl=ja-jp');
  assert.equal(getHelpLinks('en', true).update, 'https://apps.microsoft.com/detail/9P6QF32N19HG?hl=en-us');
});

test('ショートカットは Mac の修飾キーに対応し，補完とホイールは Ctrl を使う', () => {
  for (const modifier of ['Ctrl', 'Cmd']) {
    const rows = getHelpShortcuts(modifier), keys = rows.map(row => row[0]);
    assert.ok(keys.includes('F1'));
    assert.ok(keys.includes(`${modifier} + S`));
    assert.ok(keys.includes(`${modifier} + Shift + S`));
    assert.ok(keys.includes(`${modifier} + /`));
    assert.ok(keys.includes('Ctrl + Space'));
    assert.ok(keys.includes('Ctrl + wheel / pinch'));
    assert.ok(keys.includes(modifier === 'Cmd' ? 'Cmd + Shift + Z' : 'Ctrl + Y'));
    assert.ok(rows.every(([, label]) => !/[\u3040-\u30ff\u4e00-\u9fff]/.test(label)));
  }
});

test('環境情報には版とツールの利用状況を載せ，パスや原稿を含めない', () => {
  const secret = 'PRIVATE_PROJECT_TOKEN';
  const info = buildEnvironmentInfo({
    version: '0.1.6', platform: 'windows', architecture: 'amd64', executablePath: `C:\\Users\\${secret}\\app.exe`,
    packageIdentity: { fullName: secret, familyName: secret }, token: secret,
    latexmk: `C:\\TeX\\${secret}\\latexmk.exe`, synctex: '', toolError: secret,
    project: { root: `/home/${secret}`, files: [{ content: secret }] },
    build: { log: secret, root: secret },
    texPackages: { year: 2026, bin: secret, manager: secret, repository: `http://127.0.0.1/${secret}`, programs: [
      { name: 'pdflatex', path: secret, available: true }, { name: 'biber', path: secret, available: false },
      { name: secret, path: secret, available: true },
    ] },
  });
  assert.match(info, /App version: 0\.1\.6/);
  assert.match(info, /OS: Windows/);
  assert.match(info, /App architecture: x64 \(amd64\)/);
  assert.match(info, /Microsoft Store \(MSIX\)/);
  assert.match(info, /TeX Live: 2026/);
  assert.match(info, /latexmk: Available/);
  assert.match(info, /SyncTeX: Not found/);
  assert.match(info, /pdflatex: Available/);
  assert.match(info, /biber: Not found/);
  assert.doesNotMatch(info, /PRIVATE_PROJECT_TOKEN|C:\\|\/home\/|https?:/);
  const invalid = buildEnvironmentInfo({ version: secret + '/private', platform: secret, architecture: secret, texPackages: { year: secret, programs: {} } });
  assert.doesNotMatch(invalid, /PRIVATE_PROJECT_TOKEN/);
  assert.match(invalid, /App version: Unknown/);
  assert.match(invalid, /OS: Unknown/);
});
