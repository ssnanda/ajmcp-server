import { isCliProvider, runCli, CliError } from './cli.js';
import { buildSystemPrompt } from './knowledge.js';
import { applyMaster } from './master.js';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'InputError'; this.status = status; }
}
export class ProviderError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'ProviderError'; this.code = code; this.status = status; }
}

export function validateMessages(messages, config) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > config.maxMessages) {
    throw new InputError(`messages must contain 1-${config.maxMessages} items`);
  }
  return messages.map((item) => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' ||
        !item.content.trim() || item.content.length > config.maxMessageChars) {
      throw new InputError('Each message needs role user/assistant and valid text content');
    }
    return { role: item.role, content: item.content.trim() };
  });
}

function getOpenAIOutput(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  return (data?.output || []).flatMap(x => x.content || [])
    .filter(x => x.type === 'output_text' && typeof x.text === 'string')
    .map(x => x.text).join('\n').trim();
}

async function fetchModel(fetchFn, url, options, timeoutMs) {
  let response;
  try {
    response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new ProviderError('provider_timeout', 504);
    throw new ProviderError('provider_unreachable');
  }
  if (!response.ok) {
    // Never return provider error bodies to callers; they may contain sensitive data.
    if (response.status === 429) throw new ProviderError('provider_rate_limited', 503);
    if (response.status === 401 || response.status === 403) throw new ProviderError('provider_auth_failed', 503);
    throw new ProviderError('provider_request_failed');
  }
  try { return await response.json(); } catch { throw new ProviderError('provider_invalid_response'); }
}

export async function listOllamaModels(config, fetchFn = fetch) {
  const data = await fetchModel(fetchFn, `${config.ollamaUrl}/api/tags`, { method: 'GET' }, config.providerTimeoutMs);
  if (!Array.isArray(data?.models)) throw new ProviderError('provider_invalid_response');
  return data.models.map((item) => String(item?.name || item?.model || '')).filter(Boolean).sort();
}

export async function generateReply(site, messages, config, fetchFn = fetch) {
  const validated = validateMessages(messages, config);
  site = applyMaster(site, config); // the master switch (when on) decides the provider and model for every call
  const provider = site.provider;
  const prepared = site.assistant ? { system: site.systemPrompt } : buildSystemPrompt(site, validated);
  if (prepared.direct) return { text: prepared.direct, provider, model: 'knowledge', usage: null };
  site = { ...site, systemPrompt: prepared.system };
  if (isCliProvider(provider)) {
    try { return await runCli(site, validated, config); }
    catch (error) {
      if (error instanceof CliError) throw new ProviderError(error.code, error.status);
      throw error;
    }
  }
  const model = site.model || (provider === 'openai' ? config.openaiModel : provider === 'ollama' ? config.ollamaModel : config.anthropicModel);
  if (!model || /^SET_SUPPORTED/.test(model)) throw new ProviderError('model_not_configured', 503);

  if (provider === 'openai') {
    if (!config.openaiApiKey) throw new ProviderError('provider_not_configured', 503);
    const body = { model, input: validated, max_output_tokens: site.assistant ? 8000 : 1024 };
    if (site.systemPrompt) body.instructions = site.systemPrompt;
    const data = await fetchModel(fetchFn, 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify(body)
    }, config.providerTimeoutMs);
    const text = getOpenAIOutput(data);
    if (!text) throw new ProviderError('provider_empty_reply');
    return { text, provider, model, usage: data.usage || null };
  }
  if (provider === 'anthropic') {
    if (!config.anthropicApiKey) throw new ProviderError('provider_not_configured', 503);
    const body = { model, max_tokens: site.assistant ? 8000 : 1024, messages: validated };
    if (site.systemPrompt) body.system = site.systemPrompt;
    const data = await fetchModel(fetchFn, 'https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      }, body: JSON.stringify(body)
    }, config.providerTimeoutMs);
    const text = (data?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    if (!text) throw new ProviderError('provider_empty_reply');
    return { text, provider, model, usage: data.usage || null };
  }
  if (provider === 'ollama') {
    const history = site.systemPrompt ? [{ role: 'system', content: site.systemPrompt }, ...validated] : validated;
    const data = await fetchModel(fetchFn, `${config.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: history, stream: false })
    }, config.providerTimeoutMs);
    const text = typeof data?.message?.content === 'string' ? data.message.content.trim() : '';
    if (!text) throw new ProviderError('provider_empty_reply');
    return { text, provider, model, usage: data.prompt_eval_count || data.eval_count ? { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 } : null };
  }
  throw new InputError('Unsupported provider');
}
