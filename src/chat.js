// One visitor-chat turn. Without lead capture this is a plain model call. With it, the model may answer with a
// create_lead tool call; the server validates and runs it, hands the verified result back, and only then lets the
// model write the visitor-facing text. A save that failed can never be reported to the visitor as a success.
import { randomBytes } from 'node:crypto';
import { generateReply } from './provider.js';
import { parseAssistantOutput } from './assistant.js';
import { LEAD_TOOL, leadPromptBlock } from './leads.js';

const MAX_TOOL_CALLS = 2;
// After a failed save, a reply that sounds like success is replaced; one that admits the problem is kept.
const SOUNDS_LIKE_SUCCESS = /\b(saved|shared|submitted|recorded|forwarded|passed (it |them )?(on|along)|sent (it |them |your )|received your|got your|logged)\b/i;
const ADMITS_PROBLEM = /\b(couldn'?t|could not|can'?t|cannot|unable|wasn'?t able|weren'?t able|not able|didn'?t|did not|failed|unfortunately|problem|trouble)\b/i;
const FAILURE_REPLY = "I couldn't submit your details just now. Please contact our team directly and they will help you right away.";

export async function runChat({ site, messages, context = {}, config, fetchFn, leads }) {
  if (!site.leadCapture || !leads || !leads.available()) return generateReply(site, messages, config, fetchFn);

  const nonce = randomBytes(6).toString('hex');
  const turnSite = { ...site, systemPrompt: [site.systemPrompt, leadPromptBlock(site, nonce, context.visitor)].filter(Boolean).join('\n\n') };
  const roomy = { ...config, maxMessages: config.maxMessages + 2 * (MAX_TOOL_CALLS + 1) };
  const convo = messages.slice();
  let lead = null;
  let failed = false;

  for (let step = 0; step <= MAX_TOOL_CALLS; step++) {
    const reply = await generateReply(turnSite, convo, roomy, fetchFn);
    const parsed = parseAssistantOutput(reply.text, [LEAD_TOOL]);
    if (parsed.type === 'text') {
      const text = failed && SOUNDS_LIKE_SUCCESS.test(parsed.text) && !ADMITS_PROBLEM.test(parsed.text) ? FAILURE_REPLY : parsed.text;
      return { ...reply, text, lead };
    }
    if (step === MAX_TOOL_CALLS) break;      // asked for a tool again after its results: stop and use the safe reply
    lead = await leads.save(site, parsed.arguments, context);
    failed = lead.status === 'failed';
    convo.push(
      { role: 'assistant', content: JSON.stringify({ tool: LEAD_TOOL, arguments: parsed.arguments }) },
      { role: 'user', content: `[${nonce}] ${LEAD_TOOL} result: ${JSON.stringify(lead)}. ${failed ? 'It FAILED: do not say anything was saved.' : 'It succeeded.'} Now reply to the visitor in plain text.` }
    );
  }
  const text = lead && !failed ? 'Thank you. Your details have been shared with our team.' : FAILURE_REPLY;
  return { text, provider: site.provider, model: site.model || '', usage: null, lead };
}
