// One visitor-chat turn: a plain model call, plus lead capture when it is on for the site and the website's plugin
// says it can save leads. The reply comes back with an optional, already-validated `lead` that the plugin saves.
import { generateReply } from './provider.js';
import { leadPromptBlock, extractLead, validateLeadArgs } from './leads.js';

// Text-message replies: short, plain, no formatting.
const SMS_BLOCK = [
  'CHANNEL: TEXT MESSAGE (SMS)',
  '- You are replying to a text message. Keep it short: usually one or two sentences, under 320 characters.',
  '- Plain text only: no markdown, no bullet lists, no bold, no emojis. Write links as plain URLs.',
  '- Do not ask more than one question.'
].join('\n');

const HANDOFF_BLOCK = [
  'HUMAN HANDOFF',
  '- If the person asks for a human, is upset, has an urgent problem, or you cannot answer from the knowledge, still reply helpfully and then add, after your reply, exactly: <handoff>short reason</handoff>',
  '- In that reply, say a team member will follow up. Do not add the tag otherwise.'
].join('\n');

const HANDOFF_TAG = /<handoff>([\s\S]*?)<\/handoff>/i;

/** Splits a reply into its visible text and a handoff reason (or null). */
export function extractHandoff(text) {
  const match = HANDOFF_TAG.exec(String(text));
  const visible = String(text).replace(/<handoff>[\s\S]*?<\/handoff>/gi, '').replace(/<\/?handoff>/gi, '').trim();
  return { visible, reason: match ? String(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200) || 'requested' : null };
}

/** Markdown and formatting removed, whitespace collapsed, cut to a whole sentence under the limit. */
export function cleanSms(text, max = 480) {
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (out.length > max) {
    const cut = out.slice(0, max);
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    out = sentence > max * 0.5 ? cut.slice(0, sentence + 1) : cut.slice(0, cut.lastIndexOf(' ')).trim() + '…';
  }
  return out;
}

/** Applies the channel and handoff rules around one model call. */
async function reply(site, messages, context, config, fetchFn) {
  const blocks = [site.systemPrompt, context.channel === 'sms' ? SMS_BLOCK : '', context.handoff ? HANDOFF_BLOCK : ''].filter(Boolean);
  const turnSite = blocks.length > 1 ? { ...site, systemPrompt: blocks.join('\n\n') } : site;
  const raw = await generateReply(turnSite, messages, config, fetchFn);
  const { visible, reason } = extractHandoff(raw.text);
  const text = context.channel === 'sms' ? cleanSms(visible) : visible;
  return { ...raw, text, ...(reason !== null ? { handoff: reason } : {}) };
}

// The model is told not to claim a save; if it does anyway, that sentence is replaced (the plugin adds the true result).
const CLAIMS_DONE = /\b(saved|shared|submitted|recorded|forwarded|passed (it |them )?(on|along)|sent (it |them |your )|received your|got your|logged)\b/i;
const NEUTRAL = "Thanks. I'm passing your details to our team now.";

export async function runChat({ site, messages, context = {}, config, fetchFn, limiter }) {
  if (!site.leadCapture || !context.leadTool) return reply(site, messages, context, config, fetchFn);

  const withLeads = { ...site, systemPrompt: [site.systemPrompt, leadPromptBlock(site, context.visitor)].filter(Boolean).join('\n\n') };
  const answer = await reply(withLeads, messages, context, config, fetchFn);
  const { visible, raw, present } = extractLead(answer.text);
  if (!present) return { ...answer, text: visible };

  let lead = null;
  let leadError = '';
  const checked = raw ? validateLeadArgs(raw) : { ok: false, error: 'invalid_arguments' };
  if (!checked.ok) leadError = checked.error;
  else if (limiter && limiter.limited(site.id, context.conversationId)) leadError = 'rate_limited';
  else lead = checked.payload;

  // Whenever a lead is on its way (or was refused), the visible text must not announce a completed save.
  const text = CLAIMS_DONE.test(visible) || !visible ? NEUTRAL : visible;
  return { ...answer, text, ...(lead ? { lead } : { leadError }) };
}
