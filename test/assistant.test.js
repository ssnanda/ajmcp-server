import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { validateAssistantRequest, buildAssistantPrompt, parseAssistantOutput, runAssistantTurn } from '../src/assistant.js';

const config = loadConfig({ SITES_JSON: JSON.stringify({ sites: [{ id: 'one', token: 'A'.repeat(64), provider: 'openai', model: 'm' }] }), OPENAI_API_KEY: 'sk-test-key-1234567890' });
const tools = [{ name: 'list_posts', description: 'List posts', parameters: { type: 'object' } }, { name: 'create_draft', description: 'Create a draft', parameters: { type: 'object' } }];

test('request validation rejects bad roles, duplicate tools and oversize input', () => {
  assert.throws(() => validateAssistantRequest({ messages: [{ role: 'system', content: 'x' }], tools: [] }, config), /invalid_messages/);
  assert.throws(() => validateAssistantRequest({ messages: [{ role: 'user', content: 'x' }], tools: [tools[0], tools[0]] }, config), /invalid_tools/);
  assert.throws(() => validateAssistantRequest({ messages: [{ role: 'user', content: 'x'.repeat(config.maxAssistantChars + 1) }], tools: [] }, config), /request_too_large/);
  assert.throws(() => validateAssistantRequest({ messages: [{ role: 'tool', name: 'Bad Name', content: '{}' }], tools: [] }, config), /invalid_messages/);
});

test('prompt carries tools, tool results and the JSON protocol', () => {
  const req = validateAssistantRequest({ messages: [{ role: 'user', content: 'Write a blog' }, { role: 'tool', name: 'list_posts', content: '{"posts":[]}' }], tools }, config);
  const prompt = buildAssistantPrompt(req);
  assert.match(prompt, /- list_posts: List posts/);
  assert.match(prompt, /Tool result \(list_posts\): \{"posts":\[\]\}/);
  assert.match(prompt, /ONLY one JSON object/);
});

test('output parsing: plain JSON, fenced JSON, JSON inside prose, unknown tool, plain text', () => {
  const names = ['list_posts', 'create_draft'];
  assert.deepEqual(parseAssistantOutput('{"tool":"list_posts","arguments":{"limit":5}}', names), { type: 'tool', name: 'list_posts', arguments: { limit: 5 } });
  assert.equal(parseAssistantOutput('```json\n{"tool":"create_draft","arguments":{"title":"Hi {there}"}}\n```', names).arguments.title, 'Hi {there}');
  assert.equal(parseAssistantOutput('Sure, checking.\n{"tool":"list_posts","arguments":{}}', names).type, 'tool');
  assert.equal(parseAssistantOutput('{"tool":"delete_everything","arguments":{}}', names).type, 'text');
  assert.deepEqual(parseAssistantOutput('All done.', names), { type: 'text', text: 'All done.' });
});

test('a turn uses the assistant role, not the customer-chat persona, and returns a tool call', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ output_text: '{"tool":"list_posts","arguments":{"limit":3}}' }) }; };
  const site = { id: 'one', provider: 'openai', model: 'm', systemPrompt: 'Visitor chat prompt', knowledge: [{ title: 'K', text: 'secret kb' }] };
  const out = await runAssistantTurn(site, { messages: [{ role: 'user', content: 'What posts exist?' }], tools }, config, fetchFn);
  assert.deepEqual([out.type, out.name], ['tool', 'list_posts']);
  assert.match(seen[0].instructions, /AI assistant inside the WordPress admin/);
  assert.equal(JSON.stringify(seen[0]).includes('Visitor chat prompt'), false);
  assert.equal(JSON.stringify(seen[0]).includes('secret kb'), false);
  assert.equal(seen[0].max_output_tokens, 8000);
});
