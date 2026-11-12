// One visitor-chat turn: a plain model call, plus lead capture when it is on for the site and the website's plugin
// says it can save leads. The reply comes back with an optional, already-validated `lead` that the plugin saves.
import { generateReply } from './provider.js';
import { leadPromptBlock, extractLead, validateLeadArgs } from './leads.js';

// The model is told not to claim a save; if it does anyway, that sentence is replaced (the plugin adds the true result).
const CLAIMS_DONE = /\b(saved|shared|submitted|recorded|forwarded|passed (it |them )?(on|along)|sent (it |them |your )|received your|got your|logged)\b/i;
const NEUTRAL = "Thanks. I'm passing your details to our team now.";

export async function runChat({ site, messages, context = {}, config, fetchFn, limiter }) {
  if (!site.leadCapture || !context.leadTool) return generateReply(site, messages, config, fetchFn);

  const turnSite = { ...site, systemPrompt: [site.systemPrompt, leadPromptBlock(site, context.visitor)].filter(Boolean).join('\n\n') };
  const reply = await generateReply(turnSite, messages, config, fetchFn);
  const { visible, raw, present } = extractLead(reply.text);
  if (!present) return { ...reply, text: visible };

  let lead = null;
  let leadError = '';
  const checked = raw ? validateLeadArgs(raw) : { ok: false, error: 'invalid_arguments' };
  if (!checked.ok) leadError = checked.error;
  else if (limiter && limiter.limited(site.id, context.conversationId)) leadError = 'rate_limited';
  else lead = checked.payload;

  // Whenever a lead is on its way (or was refused), the visible text must not announce a completed save.
  const text = CLAIMS_DONE.test(visible) || !visible ? NEUTRAL : visible;
  return { ...reply, text, ...(lead ? { lead } : { leadError }) };
}
