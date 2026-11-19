import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeAssetPath, assetInsertion, suggestedAssetName, parseTable, tableInsertion, tableToTSV } from '../web/src/insert-content.js';
import { importsEnglish } from '../web/src/locales/imports-en.js';

test('image insertion uses the relative path from a chapter and quotes text separately', () => {
  assert.equal(relativeAssetPath('chapters/results.tex', 'figures/実験 1.png'), '../figures/実験 1.png');
  const source = assetInsertion({ documentPath: 'chapters/results.tex', assetPath: 'figures/実験 1.png', caption: 'A&B at 50% with x_1', label: 'fig:results', width: '0.75' });
  assert.match(source, /width=0\.75\\linewidth/);
  assert.ok(source.includes('\\detokenize{../figures/実験 1.png}'));
  assert.ok(source.includes('\\caption{A\\&B at 50\\% with x\\_1}'));
  assert.ok(source.includes('\\label{fig:results}'));
  assert.throws(() => assetInsertion({ documentPath: 'main.tex', assetPath: 'x%foo.png' }));
});

test('Markdown images and PDF links escape brackets, spaces, and parentheses', () => {
  assert.equal(assetInsertion({ documentPath: 'notes/chapter.md', assetPath: 'figures/chart (1).png', caption: 'A [figure]' }), '![A \\[figure\\]](../figures/chart%20%281%29.png)\n');
  assert.equal(assetInsertion({ documentPath: 'notes.md', assetPath: 'figures/result.pdf', caption: 'Result' }), '[Result](figures/result.pdf)\n');
  assert.equal(assetInsertion({ documentPath: 'notes.md', assetPath: 'figures/result[1].pdf' }), '[figures/result\\[1\\].pdf](figures/result%5B1%5D.pdf)\n');
  const long = suggestedAssetName('x'.repeat(220) + '.jpeg', 'image/jpeg');
  assert.ok(long.length <= 155); assert.ok(long.endsWith('.jpeg'));
  assert.equal(suggestedAssetName('plot%test.png'), 'plot_test.png');
});

test('copied TSV preserves quoted tabs, quoted newlines, quotes, and empty cells', () => {
  const rows = parseTable('Name\tDescription\tValue\r\n"A\tB"\t"First line\nSecond ""line"""\t\r\n');
  assert.deepEqual(rows, [['Name', 'Description', 'Value'], ['A\tB', 'First line\nSecond "line"', '']]);
  assert.deepEqual(parseTable('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']]);
  assert.deepEqual(parseTable('a,b\tc\nx,y\td'), [['a,b', 'c'], ['x,y', 'd']]);
});

test('table limits stop large pastes and malformed quoted cells', () => {
  assert.throws(() => parseTable('"not closed'), /table-quotes/);
  assert.throws(() => parseTable('"a"tail,b'), /table-quotes/);
  assert.throws(() => parseTable(Array(501).fill('a\tb').join('\n')), /table-too-large/);
  assert.throws(() => parseTable(Array(51).fill('a').join('\t')), /table-too-large/);
  assert.deepEqual(parseTable(''), []);
  assert.deepEqual(parseTable('a\tb\nc'), [['a', 'b'], ['c', '']]);
});

test('TeX tables escape literal content and support line breaks inside a cell', () => {
  const source = tableInsertion([['Name', 'Value'], ['x_1 & y', '50%\n$3']], { format: 'tex', header: true });
  assert.ok(source.includes('x\\_1 \\& y'));
  assert.ok(source.includes('\\shortstack[l]{50\\%\\\\\\$3}'));
  assert.ok(source.startsWith('\\begin{tabular}{ll}\n\\hline\n'));
  assert.ok(source.endsWith('\\hline\n\\end{tabular}\n'));
});

test('Markdown tables escape literal punctuation and can add an empty header', () => {
  const source = tableInsertion([['a|b', '<tag>'], ['x\ny', '*value*']], { format: 'markdown', header: false });
  assert.equal(source, '|  |  |\n| --- | --- |\n| a\\|b | &lt;tag&gt; |\n| x y | \\*value\\* |\n');
  assert.equal(tableInsertion([['Literal values'], ['&copy; ~~old~~ $x$']]), '| Literal values |\n| --- |\n| &amp;copy; \\~\\~old\\~\\~ \\$x\\$ |\n');
});

test('editing the table preview round trips newlines, quotes, and tabs through TSV', () => {
  const rows = [['Name', 'Value'], ['a\tb', '"first"\nsecond']];
  assert.deepEqual(parseTable(tableToTSV(rows), 'tab'), rows);
  assert.deepEqual(parseTable(tableToTSV([['Name'], [''], ['']]), 'tab'), [['Name'], [''], ['']]);
});

test('English labels preserve every interpolation parameter', () => {
  const parameters = value => [...new Set(value.match(/\{[A-Za-z]\w*\}/g) || [])].sort();
  for (const [key, value] of Object.entries(importsEnglish)) {
    assert.ok(value.trim()); assert.deepEqual(parameters(value), parameters(key), key);
  }
});
