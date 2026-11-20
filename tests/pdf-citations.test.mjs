import test from 'node:test';
import assert from 'node:assert/strict';
import { citationDestinationFromHref, citationsForDestination } from '../web/src/pdf-citations.js';
import { extractCitations } from '../web/src/tex-tools.js';

const entries = extractCitations(String.raw`
@article{smith2026, title={Learning with {Gaussian} features}, author={A. Smith}, year=2026}
@book{alpha:beta/1+2@3, title={日本語の文献}, author={著者}, year=2025}
@book{café,日本語={field}, title={Café and TeX}}
@article{日本語%2026, title={日本語で書かれた題名}}
`, 'references.bib');

test('citation destinations find the full BibTeX key for hyperref, natbib, and biblatex', () => {
  for (const destination of ['cite.smith2026', 'cite.0@smith2026', 'cite.12@smith2026']) {
    const [entry] = citationsForDestination(destination, entries);
    assert.equal(entry.title, 'Learning with Gaussian features');
    assert.equal(entry.author, 'A. Smith');
    assert.equal(entry.year, '2026');
  }
  assert.equal(citationsForDestination('cite.alpha:beta/1+2@3', entries)[0].title, '日本語の文献');
  assert.equal(citationsForDestination('cite.4@alpha:beta/1+2@3', entries)[0].key, 'alpha:beta/1+2@3');
});

test('PDF.js destination hashes decode Latin-1, Unicode, and percent signs once', () => {
  for (const key of ['smith2026', 'café', '日本語%2026', 'alpha:beta/1+2@3']) {
    const href = `#${escape(`cite.${key}`)}`;
    assert.equal(citationDestinationFromHref(href), `cite.${key}`);
    assert.equal(citationsForDestination(citationDestinationFromHref(href), entries)[0].key, key);
  }
  assert.equal(citationDestinationFromHref('http://127.0.0.1:41539/#cite.%2520'), 'cite.%20');
  assert.equal(citationDestinationFromHref('#cite.%uD83D%uDCDA'), 'cite.📚');
  assert.equal(citationDestinationFromHref('#cite.%bad%'), 'cite.ºd%');
});

test('non-citation destinations and similar keys do not receive a bibliography title', () => {
  for (const destination of ['smith2026', 'section.smith2026', 'cite.smith', 'cite.smith2026.extra', 'cite.', 'cite.unknown', 'cite.one@smith2026', 'cite.0@missing', [1, { name: 'XYZ' }, 0, 0, null], null]) {
    assert.deepEqual(citationsForDestination(destination, entries), []);
  }
  assert.equal(citationDestinationFromHref('/no-fragment'), '');
  assert.equal(citationDestinationFromHref(null), '');
});

test('each adjacent citation has its own title and duplicate titles are listed once', () => {
  const repeated = [...entries, { ...entries[0], path: 'duplicate.bib' }, { ...entries[0], title: 'Another article using the same key', path: 'other.bib' }];
  assert.deepEqual(citationsForDestination('cite.smith2026', repeated).map(entry => [entry.title, entry.path]), [
    ['Learning with Gaussian features', 'references.bib'], ['Another article using the same key', 'other.bib'],
  ]);
  assert.deepEqual(['cite.smith2026', 'cite.alpha:beta/1+2@3'].map(destination => citationsForDestination(destination, entries)[0].title), ['Learning with Gaussian features', '日本語の文献']);
});

test('an existing key containing a numbered prefix is looked up as a complete key', () => {
  const named = [{ key: '0@smith2026', title: 'A key with an at sign' }, ...entries];
  assert.equal(citationsForDestination('cite.0@smith2026', named)[0].title, 'A key with an at sign');
  assert.equal(citationsForDestination('cite.2@0@smith2026', named)[0].title, 'A key with an at sign');
  assert.deepEqual(citationsForDestination('cite.untitled', [{ key: 'untitled', title: '' }]), []);
});
