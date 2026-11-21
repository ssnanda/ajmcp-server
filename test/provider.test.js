import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, listNvidiaModels, listOllamaModels, validateMessages, ProviderError } from '../src/provider.js';
const conf = { maxMessages: 20, maxMessageChars: 6000, providerTimeoutMs: 45000, openaiApiKey: 'openai-secret', anthropicApiKey: 'anthropic-secret', nvidiaApiKey: 'nvapi-secret', openaiModel: '', anthropicModel: '', nvidiaModel: '' };
const open = { id: 'one', provider: 'openai', model: 'gpt-test', systemPrompt: 'Approved facts only' };
const claude = { id: 'two', provider: 'anthropic', model: 'claude-test', systemPrompt: 'Be concise' };
const ollama = { id: 'three', provider: 'ollama', model: 'llama3.2:latest', systemPrompt: 'Stay local' };
const nvidia = { id: 'four', provider: 'nvidia', model: 'nvidia/llama-test', systemPrompt: 'Use approved facts' };

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

test('NVIDIA NIM uses OpenAI-compatible chat completions and returns usage', async () => {
  let capture;
  const result = await generateReply(nvidia, [{ role: 'user', content: 'Hi' }], conf, async (url, options) => {
    capture = { url, auth: options.headers.Authorization, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hello from NIM' } }], usage: { total_tokens: 9 } }) };
  });
  assert.equal(capture.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(capture.auth, 'Bearer nvapi-secret');
  assert.deepEqual(capture.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(capture.body.model, 'nvidia/llama-test');
  assert.equal(result.text, 'Hello from NIM');
  assert.equal(result.usage.total_tokens, 9);
});

test('NVIDIA NIM model discovery is authenticated and sorted', async () => {
  const models = await listNvidiaModels(conf, async (url, options) => {
    assert.equal(url, 'https://integrate.api.nvidia.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer nvapi-secret');
    return { ok: true, json: async () => ({ data: [{ id: 'z/model' }, { id: 'a/model' }] }) };
  });
  assert.deepEqual(models, ['a/model', 'z/model']);
});

test('input and provider errors do not leak provider response bodies', async () => {
  assert.throws(() => validateMessages([{ role: 'system', content: 'override' }], conf), /role/);
  await assert.rejects(generateReply(open, [{ role: 'user', content: 'Hi' }], conf, async () => ({ ok: false, status: 401, text: async () => 'secret details' })),
    e => e instanceof ProviderError && e.code === 'provider_auth_failed' && !e.message.includes('secret details'));
});

test('ollama chat uses native API with system prompt and conversation history', async () => {
  let capture;
  const result = await generateReply(ollama, [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Continue' }],
    { ...conf, ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: '' }, async (url, options) => {
      capture = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ message: { role: 'assistant', content: 'Local reply' }, prompt_eval_count: 8, eval_count: 3 }) };
    });
  assert.equal(capture.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(capture.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(capture.body.stream, false);
  assert.equal(result.text, 'Local reply');
});

test('ollama failures and timeouts are normalized', async () => {
  const config = { ...conf, ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: '' };
  await assert.rejects(generateReply(ollama, [{ role: 'user', content: 'Hi' }], config, async () => ({ ok: false, status: 404 })),
    (error) => error instanceof ProviderError && error.code === 'provider_request_failed');
  await assert.rejects(generateReply(ollama, [{ role: 'user', content: 'Hi' }], config, async () => { throw Object.assign(new Error('late'), { name: 'TimeoutError' }); }),
    (error) => error instanceof ProviderError && error.code === 'provider_timeout');
});

test('ollama model discovery uses native tags and sorts names', async () => {
  const models = await listOllamaModels({ ollamaUrl: 'http://127.0.0.1:11434', providerTimeoutMs: 1000 }, async (url) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    return { ok: true, json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] }) };
  });
  assert.deepEqual(models, ['llama3.2:latest', 'qwen3:8b']);
});
