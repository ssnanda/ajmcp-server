import test from 'node:test';
import assert from 'node:assert/strict';
import { identityForBearer } from '../src/auth.js';
import { Limiter } from '../src/limits.js';
const a = { id: 'site-a', token: 'a'.repeat(64), provider: 'openai' };
const b = { id: 'site-b', token: 'b'.repeat(64), provider: 'anthropic' };
const cfg = { adminToken: 'z'.repeat(64), sites: [a, b] };

test('bearer identity is scoped to provided token', () => {
  assert.equal(identityForBearer('Bearer ' + a.token, cfg).site.id, 'site-a');
  assert.equal(identityForBearer('Bearer ' + b.token, cfg).site.id, 'site-b');
  assert.equal(identityForBearer('Bearer ' + cfg.adminToken, cfg).kind, 'admin');
  assert.equal(identityForBearer('Bearer ' + 'x'.repeat(64), cfg), null);
  assert.equal(identityForBearer('Basic '+ a.token, cfg), null);
});

test('limiter rate limits per site, enforces global concurrency, and releases once', () => {
  let clock = 1000;
  const l = new Limiter({ rateLimitPerMinute: 2, maxConcurrent: 1 }, () => clock);
  const slot = l.acquire({ id: 'a' });
  assert.equal(slot.ok, true);
  assert.equal(l.acquire({ id: 'b' }).code, 'busy');
  slot.release(); slot.release();
  assert.equal(l.active, 0);
  assert.equal(l.acquire({ id: 'a' }).ok, true);
  assert.equal(l.acquire({ id: 'a' }).code, 'rate_limit');
  clock += 60001;
  assert.equal(l.acquire({ id: 'a' }).code, 'busy'); // earlier second slot still active
});
