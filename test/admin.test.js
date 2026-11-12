import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAjmcpServer } from '../src/server.js';
import { SettingsStore } from '../src/store.js';
import { hashPassword, verifyPassword } from '../src/password.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ajmcp-admin-'));
  const config = loadConfig({
    DATA_DIR: dir, ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: await hashPassword('correct horse battery'),
    OPENAI_API_KEY: 'sk-env-openai-key-1234567890'
  });
  const store = new SettingsStore(config);
  store.load();
  const calls = [];
  const server = createAjmcpServer(config, { store, fetchFn: async (url, opts) => {
    calls.push(url);
    if (url.includes('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }) };
    return { ok: true, json: async () => ({ output_text: 'OK' }) };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let setCookieHeader = '';
  const call = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(url + path, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const set = res.headers.get('set-cookie');
    if (set) { cookie = set.split(';')[0]; setCookieHeader = set; }
    return { res, data: await res.json().catch(() => ({})) };
  };
  return { dir, config, server, url, call, calls, get cookie() { return cookie; }, get setCookieHeader() { return setCookieHeader; } };
}

test('password hashing verifies only the right password', async () => {
  const hash = await hashPassword('s3cret-value');
  assert.ok(await verifyPassword('s3cret-value', hash));
  assert.ok(!(await verifyPassword('other', hash)));
  assert.ok(!(await verifyPassword('x', 'not-a-hash')));
});

test('admin requires login, then manages sites; tokens are hashed and work immediately', async (t) => {
  const fx = await fixture();
  const { dir, server, url, call, config } = fx;
  t.after(() => server.close());

  assert.equal((await call('/admin/api/state')).res.status, 401);
  assert.equal((await call('/admin/api/login', 'POST', { username: 'admin', password: 'wrong' })).res.status, 401);
  assert.equal((await call('/admin/api/login', 'POST', { username: 'admin', password: 'correct horse battery' })).res.status, 200);

  const cookie = fx.cookie; const setCookieHeader = fx.setCookieHeader;
  const sessionsText = readFileSync(join(dir, 'sessions.json'), 'utf8');
  assert.equal(sessionsText.includes(cookie.split('=')[1]), false, 'raw session id must not be stored');
  assert.equal(statSync(join(dir, 'sessions.json')).mode & 0o777, 0o600);
  assert.match(setCookieHeader, /Max-Age=2592000/, 'remembered by default (30 days)');

  const state = (await call('/admin/api/state')).data;
  assert.equal(state.sites.length, 0);
  assert.equal(state.keys.openai.source, 'environment');
  assert.equal(JSON.stringify(state).includes('sk-env'), false);

  const created = await call('/admin/api/sites', 'POST', { id: 'blog', provider: 'openai', model: 'gpt-a', systemPrompt: 'hi' });
  assert.equal(created.res.status, 201);
  const token = created.data.token;
  assert.match(token, /^[a-f0-9]{64}$/);

  const saved = readFileSync(join(dir, 'settings.json'), 'utf8');
  assert.equal(saved.includes(token), false, 'plain token must never be stored');
  assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);

  const chat = await fetch(url + '/v1/chat', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(chat.status, 200);

  await call('/admin/api/sites/blog', 'PUT', { disabled: true });
  const blocked = await fetch(url + '/v1/chat', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(blocked.status, 401);

  const rotated = (await call('/admin/api/sites/blog/rotate', 'POST')).data.token;
  assert.notEqual(rotated, token);
  assert.equal((await call('/admin/api/sites/blog/test', 'POST')).data.ok, true);
  assert.deepEqual((await call('/admin/api/models?provider=openai')).data.models, ['gpt-a', 'gpt-b']);

  const doc = await call('/admin/api/sites/blog/knowledge', 'POST', { title: 'Hours', text: 'We are open 9 to 5.' });
  assert.equal(doc.res.status, 201);
  const withDoc = (await call('/admin/api/state')).data.sites[0];
  assert.equal(withDoc.knowledge[0].title, 'Hours');
  assert.equal(JSON.stringify(withDoc).includes('open 9 to 5'), false, 'document text is not sent back in state');
  const ask = await call('/admin/api/sites/blog/test', 'POST', { question: 'When are you open?' });
  assert.equal(ask.data.ok, true);
  assert.equal((await call('/admin/api/sites/blog/knowledge/' + doc.data.id, 'DELETE')).res.status, 200);
  assert.equal((await call('/admin/api/state')).data.sites[0].knowledge.length, 0);

  assert.equal((await call('/admin/api/sites', 'POST', { id: 'blog' })).res.status, 409);
  assert.equal((await call('/admin/api/sites/blog', 'DELETE')).res.status, 200);
  assert.equal(config.sites.length, 0);
});

test('keys are masked, password change works, cross-origin writes are refused', async (t) => {
  const { server, call, config } = await fixture();
  t.after(() => server.close());
  await call('/admin/api/login', 'POST', { username: 'admin', password: 'correct horse battery' });

  const keys = await call('/admin/api/keys', 'PUT', { anthropic: 'sk-ant-abcdefghijklmnopqrstuvwxyz' });
  assert.equal(keys.data.anthropic.hint, 'wxyz');
  assert.equal(JSON.stringify(keys.data).includes('sk-ant'), false);
  assert.equal(config.anthropicApiKey, 'sk-ant-abcdefghijklmnopqrstuvwxyz');

  const evil = await call('/admin/api/sites', 'POST', { id: 'evil-site' }, { origin: 'https://evil.example' });
  assert.equal(evil.res.status, 403);

  assert.equal((await call('/admin/api/password', 'POST', { current: 'nope', next: 'a-new-long-password' })).res.status, 403);
  assert.equal((await call('/admin/api/password', 'POST', { current: 'correct horse battery', next: 'a-new-long-password' })).res.status, 200);
  assert.ok(await verifyPassword('a-new-long-password', config.adminPasswordHash));
});

test('admin UI is not served when no admin login is configured', async (t) => {
  const config = loadConfig({ SITES_JSON: JSON.stringify({ sites: [{ id: 'one', token: 'A'.repeat(64), provider: 'openai', model: 'm' }] }) });
  const server = createAjmcpServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin`);
  assert.equal(res.status, 401);
});

test('a remembered login survives a server restart; a password change signs other sessions out', async (t) => {
  const first = await fixture();
  t.after(() => first.server.close());
  await first.call('/admin/api/login', 'POST', { username: 'admin', password: 'correct horse battery' });
  const cookie = first.cookie;
  first.server.close();

  // New process, same data directory and same admin hash.
  const config = loadConfig({ DATA_DIR: first.dir, ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: first.config.adminPasswordHash });
  const store = new SettingsStore(config);
  store.load();
  const second = createAjmcpServer(config, { store });
  second.listen(0, '127.0.0.1');
  await once(second, 'listening');
  t.after(() => second.close());
  const base = `http://127.0.0.1:${second.address().port}`;
  assert.equal((await fetch(base + '/admin/api/state', { headers: { cookie } })).status, 200, 'still signed in after restart');

  // The deploy script issuing a new password hash (--reset-admin) invalidates old sessions.
  const reset = loadConfig({ DATA_DIR: first.dir, ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: await hashPassword('a brand new password') });
  const third = createAjmcpServer(reset, { store: new SettingsStore(reset) });
  third.listen(0, '127.0.0.1');
  await once(third, 'listening');
  t.after(() => third.close());
  assert.equal((await fetch(`http://127.0.0.1:${third.address().port}/admin/api/state`, { headers: { cookie } })).status, 401);
});

test('named access tokens: AJOps gets its own, replacing keeps one per label, revoking stops it, the primary token is untouched', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const { url, call } = f;
  await call('/admin/api/login', 'POST', { username: 'admin', password: 'correct horse battery' });
  const site = await call('/admin/api/sites', 'POST', { id: 'ncllcagents', provider: 'openai', model: 'm' });
  const primary = site.data.token;
  const chat = (token) => fetch(url + '/v1/site/config', { headers: { authorization: `Bearer ${token}` } });

  const first = await call('/admin/api/sites/ncllcagents/tokens', 'POST', { label: 'AJOps' });
  assert.equal(first.res.status, 201);
  assert.match(first.data.token, /^[a-f0-9]{64}$/);
  assert.equal((await chat(first.data.token)).status, 200, 'the new token works');
  assert.equal((await chat(primary)).status, 200, 'the primary token still works');

  // Connecting again replaces the old AJOps token instead of piling up.
  const second = await call('/admin/api/sites/ncllcagents/tokens', 'POST', { label: 'AJOps', replace: true });
  assert.equal((await chat(second.data.token)).status, 200);
  assert.equal((await chat(first.data.token)).status, 401, 'the replaced token no longer works');
  const listed = (await call('/admin/api/state')).data.sites[0].tokens;
  assert.deepEqual(listed.map((x) => x.label), ['AJOps']);
  assert.equal(JSON.stringify(listed).includes(second.data.token), false, 'tokens are never listed in full');

  assert.equal((await call('/admin/api/sites/ncllcagents/tokens', 'POST', { label: '<script>' })).res.status, 400);
  assert.equal((await call('/admin/api/sites/missing/tokens', 'POST', { label: 'AJOps' })).res.status, 404);

  const revoked = await call(`/admin/api/sites/ncllcagents/tokens/${listed[0].id}`, 'DELETE');
  assert.equal(revoked.res.status, 200);
  assert.equal((await chat(second.data.token)).status, 401, 'a revoked token stops working immediately');
  assert.equal((await chat(primary)).status, 200);

  // Disabling the site turns every token off; extra tokens are stored only as hashes.
  const third = await call('/admin/api/sites/ncllcagents/tokens', 'POST', { label: 'Test' });
  assert.equal(readFileSync(join(f.dir, 'settings.json'), 'utf8').includes(third.data.token), false);
  await call('/admin/api/sites/ncllcagents', 'PUT', { disabled: true });
  assert.equal((await chat(third.data.token)).status, 401);
});
