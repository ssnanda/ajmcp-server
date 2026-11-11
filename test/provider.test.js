import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, validateMessages, ProviderError } from '../src/provider.js';
const conf = { maxMessages: 20, maxMessageChars: 6000, providerTimeoutMs: 45000, openaiApiKey: 'openai-secret', anthropicApiKey: 'anthropic-secret', openaiModel: '', anthropicModel: '' };
const open = { id: 'one', provider: 'openai', model: 'gpt-test', systemPrompt: 'Approved facts only' };
const claude = { id: 'two', provider: 'anthropic', model: 'claude-test', systemPrompt: 'Be concise' };

test('openai request uses configured model/prompt and extracts response text', async () => {
  let capture;
  const result = await generateReply(open, [{ role: 'user', content: 'Hi' }], conf, async (url, options) => {
    capture = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'Hello!' }] }], usage: { total_tokens: 7 } }) };
  });
  assert.equal(capture.url, 'https://api.openai.com/v1/responses');
  assert.equal(capture.body.model, 'gpt-test');
  assert.equal(capture.body.instructions, open.systemPrompt);
  assert.equal(result.text, 'Hello!');
});

test('anthropic request uses site-specific provider and supported headers', async () => {
  const result = await generateReply(claude, [{ role: 'user', content: 'Hi' }], conf, async (url, opt) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(opt.headers['x-api-key'], conf.anthropicApiKey);
    assert.equal(JSON.parse(opt.body).model, 'claude-test');
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Hello Claude' }] }) };
  });
  assert.equal(result.text, 'Hello Claude');
});

test('input and provider errors do not leak provider response bodies', async () => {
  assert.throws(() => validateMessages([{ role: 'system', content: 'override' }], conf), /role/);
  await assert.rejects(generateReply(open, [{ role: 'user', content: 'Hi' }], conf, async () => ({ ok: false, status: 401, text: async () => 'secret details' })),
    e => e instanceof ProviderError && e.code === 'provider_auth_failed' && !e.message.includes('secret details'));
});
