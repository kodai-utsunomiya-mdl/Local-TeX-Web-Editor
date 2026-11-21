import test from 'node:test';
import assert from 'node:assert/strict';
import { packageInstallCommands, packageSearchCommand } from '../web/src/tex-packages.js';

const windows = { shell: 'powershell', repository: 'https://tex.example/private', commandPrefix: "& 'C:\\texlive\\2025\\bin\\windows\\tlmgr.bat'" };
const mac = { shell: 'posix', commandPrefix: "'/Library/TeX/texbin/tlmgr'" };

test('package commands use the selected TeX installation and support reinstalling a missing program', () => {
  const commands = packageInstallCommands(windows, 'synctex synctex.windows synctex', { reinstall: true });
  assert.equal(commands, `${windows.commandPrefix} update --self\n${windows.commandPrefix} install --reinstall synctex synctex.windows`);
  assert.doesNotMatch(commands, /--repository/);
  assert.equal(packageInstallCommands(mac, 'latexmk'), "sudo '/Library/TeX/texbin/tlmgr' update --self\nsudo '/Library/TeX/texbin/tlmgr' install latexmk");
  assert.equal(packageInstallCommands(mac, 'latexmk', { administrator: false }), "'/Library/TeX/texbin/tlmgr' update --self\n'/Library/TeX/texbin/tlmgr' install latexmk");
});

test('package names cannot introduce terminal commands or options', () => {
  for (const names of ['', '  ', '--all', 'foo;whoami', 'foo\n$(whoami)', '`whoami`', "foo'", 'foo/bar', 'foo&bar']) {
    assert.equal(packageInstallCommands(windows, names), '', names);
    assert.equal(packageInstallCommands(mac, names), '', names);
  }
  assert.equal(packageInstallCommands({}, 'latexmk'), '');
});

test('missing file searches use an exact file ending and escape regular expression characters', () => {
  assert.equal(packageSearchCommand(windows, 'siunitx.sty'), `${windows.commandPrefix} search --global --file '/siunitx\\.sty$'`);
  assert.equal(packageSearchCommand(mac, 'foo+.cls'), "'/Library/TeX/texbin/tlmgr' search --global --file '/foo\\+\\.cls$'");
  for (const filename of ['../secret.sty', 'foo.sty; id', "foo'.sty", '$(whoami).sty', '--global', '']) assert.equal(packageSearchCommand(mac, filename), '');
});
