import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const release = 'https://github.com/kodai-utsunomiya-mdl/Local-TeX-Web-Editor/releases/download';
for (const file of ['README.md', 'README.ja.md']) {
  test(file + ' offers the Windows and macOS downloads for the packaged version', async () => {
    const markdown = await readFile(new URL(file, root), 'utf8');
    const buttons = [...markdown.matchAll(/\]\(docs\/download-(windows|macos)\.svg\)\]\(([^)\s]+)\)/g)];
    const expected = ['windows-x64', 'macos-universal'].map(platform =>
      release + '/v' + version + '/local-tex-web-editor-' + version + '-' + platform + '.zip');
    assert.deepEqual(buttons.map(match => match[2]).sort(), expected.sort());
    assert.ok(markdown.split('\n').some(line => line.startsWith('**v' + version + '**')));
  });
}
