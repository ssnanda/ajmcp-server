import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog } from '../src/activity.js';

test('keeps only known fields and trims long strings', () => {
  const log = new ActivityLog();
  log.add({ t: 'x', route: '/v1/chat', status: 200, message: 'secret text', token: 'abc', error: 'e'.repeat(300) });
  const [e] = log.list();
  assert.equal(e.message, undefined);
  assert.equal(e.token, undefined);
  assert.equal(e.error.length, 120);
});

test('newest first, capped, and problems filter', () => {
  const log = new ActivityLog(3);
  for (let i = 1; i <= 5; i += 1) log.add({ route: '/r' + i, status: i === 4 ? 401 : 200 });
  assert.deepEqual(log.list().map((e) => e.route), ['/r5', '/r4', '/r3']);
  assert.deepEqual(log.list({ problemsOnly: true }).map((e) => e.route), ['/r4']);
  assert.equal(log.list({ limit: 1 }).length, 1);
});
