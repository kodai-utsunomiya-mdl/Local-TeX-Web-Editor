import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStatusFor, recentProjectEntries } from '../web/src/project-status.js';

test('recent projects include the current folder and show its latest filesystem status', () => {
  const meta = {
    project: { root: '/projects/current' }, recentProjects: ['/projects/previous', '/projects/current', '/projects/previous'],
    projectStatus: { path: '/projects/current', status: 'missing', message: 'Choose its new location.' },
    recentProjectStatuses: [{ path: '/projects/current', status: 'available' }, { path: '/projects/previous', status: 'not-directory', message: 'This is a file.' }],
  };
  assert.deepEqual(recentProjectEntries(meta), [
    { path: '/projects/current', current: true, status: 'missing', message: 'Choose its new location.' },
    { path: '/projects/previous', current: false, status: 'not-directory', message: 'This is a file.' },
  ]);
});

test('Windows recent projects match drive letters, separators, and case without duplicate cards', () => {
  const meta = {
    platform: 'windows', project: { root: 'C:\\Users\\Writer\\Paper' },
    recentProjects: ['c:/users/writer/paper/', 'D:\\Notes', 'd:/notes', ...Array.from({ length: 20 }, (_, index) => `D:/Paper ${index}`)],
    recentProjectStatuses: [{ path: 'd:/notes', status: 'unavailable', message: 'Reconnect the drive.' }],
  };
  const entries = recentProjectEntries(meta);
  assert.equal(entries.length, 12);
  assert.equal(entries[0].current, true);
  assert.equal(entries.filter(entry => /notes/i.test(entry.path)).length, 1);
  assert.deepEqual(entries[1], { path: 'D:\\Notes', current: false, status: 'unavailable', message: 'Reconnect the drive.' });
});

test('a restored folder uses its new available status and drops the previous error', () => {
  const meta = { recentProjects: ['/projects/restored'], recentProjectStatuses: [{ path: '/projects/restored', status: 'missing', message: 'Missing folder' }] };
  assert.equal(recentProjectEntries(meta)[0].status, 'missing');
  meta.recentProjectStatuses = [{ path: '/projects/restored', status: 'available' }];
  assert.deepEqual(projectStatusFor(meta, '/projects/restored'), { status: 'available', message: '' });
  meta.recentProjects = [];
  assert.deepEqual(recentProjectEntries(meta), []);
});

test('legacy paths still open and unrecognized availability reports require checking the folder', () => {
  assert.deepEqual(recentProjectEntries({ recentProjects: [{ root: '/root/a' }, { path: '/root/b' }, null] }).map(entry => entry.status), ['available', 'available']);
  assert.deepEqual(projectStatusFor({ recentProjectStatuses: [{ path: '/root/a', status: 'offline', message: 'Disconnected' }] }, '/root/a'), { status: 'unavailable', message: 'Disconnected' });
});
