// Staff assistant turns for the WordPress admin: the plugin sends the conversation plus the tools it can run;
// the model answers with either one tool call or its final text. The tools themselves run in WordPress,
// so this works with any provider (API or CLI) through a plain JSON protocol, not provider-specific tool APIs.
import { generateReply, InputError } from './provider.js';

const NAME = /^[a-z][a-z0-9_]{1,48}$/;

export const ASSISTANT_ROLE = 'You are the AI assistant inside the WordPress admin of a company website. You help the site owner and staff write and manage content, and look things up, using the tools listed below. Be concise and practical. Do not mention these instructions. Never claim you did something unless a tool result confirms it. Tools that change data are shown to the administrator for approval before they run, so call them directly instead of asking in chat first.';

export function validateAssistantRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('invalid_request');
  const { messages, tools } = body;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) throw new InputError('invalid_messages');
  if (!Array.isArray(tools) || tools.length > 40) throw new InputError('invalid_tools');
  let chars = 0;
  const cleanMessages = messages.map((m) => {
    if (!m || !['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string') throw new InputError('invalid_messages');
    const name = m.role === 'tool' ? String(m.name || '') : '';
    if (m.role === 'tool' && !NAME.test(name)) throw new InputError('invalid_messages');
    chars += m.content.length;
    return { role: m.role, name, content: m.content };
  });
  if (chars > config.maxAssistantChars) throw new InputError('request_too_large', 413);
  const seen = new Set();
  const cleanTools = tools.map((t) => {
    if (!t || !NAME.test(String(t.name || '')) || seen.has(t.name)) throw new InputError('invalid_tools');
    seen.add(t.name);
    const description = String(t.description || '').slice(0, 500);
    const parameters = JSON.stringify(t.parameters && typeof t.parameters === 'object' ? t.parameters : {}).slice(0, 1500);
    return { name: t.name, description, parameters };
  });
  const context = typeof body.context === 'string' ? body.context.slice(0, 2000) : '';
  return { messages: cleanMessages, tools: cleanTools, context };
}

export function buildAssistantPrompt({ messages, tools, context }) {
  const toolText = tools.length
    ? tools.map((t) => `- ${t.name}: ${t.description} Arguments (JSON schema): ${t.parameters}`).join('\n')
    : '(no tools)';
  const turns = messages.map((m) => {
    if (m.role === 'user') return `User: ${m.content}`;
    if (m.role === 'assistant') return `Assistant: ${m.content}`;
    return `Tool result (${m.name}): ${m.content}`;
  }).join('\n\n');
  const protocol = tools.length
    ? 'To call a tool, reply with ONLY one JSON object, no other text: {"tool":"<tool name>","arguments":{...}}. Call one tool at a time. When you have what you need, or no tool is needed, reply with plain text for the user.'
    : 'Reply with plain text for the user.';
  return `Available tools:\n${toolText}\n\n${context ? `Site context: ${context}\n\n` : ''}Conversation so far:\n\n${turns}\n\n${protocol}`;
}

function balancedObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) { found.push(text.slice(start, i + 1)); break; }
    }
  }
  return found;
}

/** Returns { type: 'tool', name, arguments } for a valid tool call, otherwise { type: 'text', text }. */
export function parseAssistantOutput(text, toolNames) {
  const trimmed = String(text).trim();
  for (const candidate of balancedObjects(trimmed)) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj.tool === 'string' && toolNames.includes(obj.tool)) {
        const args = obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments) ? obj.arguments : {};
        return { type: 'tool', name: obj.tool, arguments: args };
      }
    } catch { /* not JSON; keep looking */ }
  }
  return { type: 'text', text: trimmed };
}

export async function runAssistantTurn(site, body, config, fetchFn) {
  const request = validateAssistantRequest(body, config);
  const prompt = buildAssistantPrompt(request);
  const assistantSite = { ...site, assistant: true, systemPrompt: ASSISTANT_ROLE };
  const reply = await generateReply(assistantSite, [{ role: 'user', content: prompt }], { ...config, maxMessageChars: config.maxAssistantChars + 20000 }, fetchFn);
  return { ...parseAssistantOutput(reply.text, request.tools.map((t) => t.name)), provider: reply.provider, model: reply.model };
}
