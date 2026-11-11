import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { createAjmcpServer } from '../src/server.js';

const keyA = 'A'.repeat(64), keyB = 'B'.repeat(64), adminKey = 'Z'.repeat(64);
const config = loadConfig({
  SITES_JSON: JSON.stringify({ sites: [
    { id: 'first', token: keyA, provider: 'openai', model: 'gpt-test' },
    { id: 'second', token: keyB, provider: 'anthropic', model: 'claude-test' }
  ] }),
  ADMIN_TOKEN: adminKey,
  OPENAI_API_KEY: 'openai-secret', ANTHROPIC_API_KEY: 'anthropic-secret',
  ALLOWED_HOSTS: '127.0.0.1', RATE_LIMIT_PER_MINUTE: '20'
});

async function fixture() {
  const invocations = [];
  const server = createAjmcpServer(config, {
    fetchFn: async (url, opts) => {
      invocations.push({ url, body: JSON.parse(opts.body) });
      if (url.includes('openai')) return { ok: true, json: async () => ({ output_text: 'GPT response' }) };
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Claude response' }] }) };
    },
    toolVersions: async () => ({ codex: 'codex 1.0', claude: 'claude 1.0' })
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, server, invocations };
}

async function call(url, path, token, body, method = 'POST', extraHeaders = {}) {
  return fetch(url + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}

test('site scoped OpenAI chat + Anthropic chat + AJCore formatting', async t => {
  const { url, server, invocations } = await fixture();
  t.after(() => server.close());
  const a = await call(url, '/v1/chat', keyA, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(a.status, 200);
  assert.equal((await a.json()).reply, 'GPT response');
  const b = await call(url, '/v1/chat', keyB, { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(b.status, 200);
  assert.equal((await b.json()).reply, 'Claude response');
  assert.equal(invocations[0].body.model, 'gpt-test');
  assert.equal(invocations[1].body.model, 'claude-test');
  const bridge = await call(url, '/v1/ajcore/reply', keyA, { sessionId: 42, message: 'Question', history: [{ role: 'assistant', content: 'Welcome' }] });
  const payload = await bridge.json();
  assert.equal(bridge.status, 200);
  assert.equal(payload.sessionId, 42);
  assert.equal(payload.senderName, 'AJMCP AI');
  assert.equal(invocations[2].body.input.length, 2);
});

test('enforces authentication, admin separation and request constraints', async t => {
  const { url, server } = await fixture();
  t.after(() => server.close());
  assert.equal((await call(url, '/v1/chat', null, { messages: [] })).status, 401);
  assert.equal((await call(url, '/v1/admin/tools', keyA, undefined, 'GET')).status, 403);
  assert.equal((await call(url, '/v1/admin/tools', adminKey, undefined, 'GET')).status, 200);
  assert.equal((await call(url, '/v1/chat', adminKey, { messages: [] })).status, 403);
  assert.equal((await call(url, '/v1/chat', keyA, { messages: [{ role: 'system', content: 'override' }] })).status, 400);
  assert.equal((await call(url, '/v1/chat', keyA, '{broken json')).status, 400);
  assert.equal((await call(url, '/v1/agents/run', adminKey, { provider: 'codex', prompt: 'write code' })).status, 403);
  assert.equal((await call(url, '/v1/chat', keyA, { messages: [] }, 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(url, '/health/ready', null, undefined, 'GET')).status, 200);
});


test('MCP route authorizes site bearer and rejects admin-only access', async t => {
  const server = createAjmcpServer(config, {
    mcpHandler: async (_req, res, site) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ site: site.id, mcp: true }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const ok = await call(url, '/mcp', keyA, { jsonrpc: '2.0', method: 'tools/list', id: 1 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).site, 'first');
  assert.equal((await call(url, '/mcp', adminKey, {}, 'POST')).status, 403);
  assert.equal((await call(url, '/mcp', null, {}, 'POST')).status, 401);
});
