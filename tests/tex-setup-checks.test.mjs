import assert from 'node:assert/strict';
import test from 'node:test';
import { requestTeXManagement } from '../scripts/tex-setup-checks.mjs';

const busy = () => Response.json({ error: 'Wait for the TeX operation or compilation to finish before continuing.' }, { status: 409 });

test('management checks wait for the browser to finish inspecting the selected TeX', async () => {
  let requests = 0;
  const request = async endpoint => {
    assert.equal(endpoint, '/api/tex/packages');
    return ++requests < 3 ? busy() : Response.json({ directory: 'selected-tex', packages: [{ name: 'siunitx' }] });
  };
  const response = await requestTeXManagement(request, '/api/tex/packages', undefined, undefined, { pollInterval: 1 });
  assert.equal(requests, 3);
  assert.deepEqual(await response.json(), { directory: 'selected-tex', packages: [{ name: 'siunitx' }] });
});

test('a package change is started once after inspection finishes', async () => {
  const input = { operation: 'packages', consent: true, packages: ['siunitx'], directory: 'selected-tex', revision: 'reviewed' };
  let requests = 0, started = 0;
  const request = async (endpoint, data, method) => {
    assert.equal(endpoint, '/api/tex/setup');
    assert.equal(method, 'POST');
    assert.deepEqual(data, input);
    if (++requests === 1) return busy();
    started++;
    return Response.json({ id: 'accepted-job', status: 'running' }, { status: 202 });
  };
  const response = await requestTeXManagement(request, '/api/tex/setup', input, 'POST', { pollInterval: 1 });
  assert.equal(started, 1);
  assert.equal(requests, 2);
  assert.deepEqual(await response.json(), { id: 'accepted-job', status: 'running' });
});

test('management checks return a stale review conflict without resending the operation', async () => {
  let requests = 0;
  const body = { error: 'The TeX removal plan has changed. Review it again.', preview: { revision: 'current' } };
  const response = await requestTeXManagement(async () => {
    requests++;
    return Response.json(body, { status: 409 });
  }, '/api/tex/setup/delete', { revision: 'outdated-preview' }, 'DELETE');
  assert.equal(requests, 1);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), body);
});

test('management checks report a busy timeout and leave transport failures to the caller', async () => {
  let requests = 0;
  await assert.rejects(requestTeXManagement(async () => { requests++; return busy(); }, '/api/tex/packages', undefined, undefined, { timeout: 0 }), /TeX management stayed busy/);
  assert.equal(requests, 1);
  const error = new Error('Connection closed after sending the request.');
  requests = 0;
  await assert.rejects(requestTeXManagement(async () => { requests++; throw error; }, '/api/tex/setup', { operation: 'packages' }), value => value === error);
  assert.equal(requests, 1);
});
