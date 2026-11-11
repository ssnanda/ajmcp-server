import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const tok = 'a'.repeat(64);
const valid = { SITES_JSON: JSON.stringify({ sites: [{ id: 'one', token: tok, provider: 'openai', model: 'test-model' }] }) };

test('requires configured tenants and rejects placeholder secrets', () => {
  assert.throws(() => loadConfig({}), /Configure/);
  assert.throws(() => loadConfig({ SITES_JSON: JSON.stringify({ sites: [{ id: 'one', token: 'REPLACE_WITH_SECRET' }] }) }), /secret/);
});

test('enforces tenant uniqueness and distinct admin token', () => {
  const sites = { sites: [{ id: 'one', token: tok }, { id: 'two', token: tok }] };
  assert.throws(() => loadConfig({ SITES_JSON: JSON.stringify(sites) }), /Duplicate/);
  assert.throws(() => loadConfig({ ...valid, ADMIN_TOKEN: tok }), /Admin token/);
});

test('parses options and uses reasonable limits for invalid values', () => {
  const config = loadConfig({ ...valid, MAX_MESSAGES: '99999', MAX_CONCURRENT: '3' });
  assert.equal(config.maxMessages, 20);
  assert.equal(config.maxConcurrent, 3);
  assert.equal(config.sites[0].provider, 'openai');
});
