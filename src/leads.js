// Lead capture in the visitor chat. The model may end a reply with a <lead>{...}</lead> block once the visitor has
// agreed to share their details. The server checks that block (explicit consent, name, valid email) and returns it
// next to the reply; the website's plugin saves it in AJCore and adds the real confirmation. The AI never confirms a save.

export const LEAD_TOOL = 'create_lead';
export const ENTITY_STATUSES = ['startup', 'existing_nc', 'existing_other_state', 'existing_other_country', 'unknown'];
export const SERVICES = ['registered_agent', 'domestic_formation', 'foreign_qualification', 'agent_change', 'other'];
export const PREFERENCES = ['essentials', 'assisted', 'unknown'];
export const CONTACT_METHODS = ['email', 'phone', 'text', 'unspecified'];

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const pick = (value, allowed, fallback) => (allowed.includes(String(value)) ? String(value) : fallback);

export const CONSENT_TEXT = 'Visitor agreed in chat to share their details with the team for follow-up about their request.';

/** Returns { ok: true, payload } for AJCore, or { ok: false, error }. Nothing here trusts the model. */
export function validateLeadArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid_arguments' };
  if (args.contact_consent !== true) return { ok: false, error: 'consent_required' };
  const name = clean(args.visitor_name, 120);
  if (name.length < 2) return { ok: false, error: 'name_required' };
  const email = clean(args.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: 'valid_email_required' };
  const summary = clean(args.short_summary, 600);
  if (!summary) return { ok: false, error: 'summary_required' };

  const digits = String(args.phone ?? '').replace(/\D+/g, '');
  const phoneOk = digits.length === 10 || (digits.length === 11 && digits[0] === '1');
  const services = (Array.isArray(args.service_interest) ? args.service_interest : [args.service_interest])
    .map((s) => clean(s, 40).toLowerCase().replace(/[\s-]+/g, '_')).filter(Boolean)
    .map((s) => (SERVICES.includes(s) ? s : 'other'));
  return {
    ok: true,
    payload: {
      name, email,
      phone: phoneOk ? String(args.phone).trim().slice(0, 30) : '',      // an unusable phone number is dropped, not an error
      company: clean(args.company_name, 120),
      entity_status: pick(args.entity_status, ENTITY_STATUSES, 'unknown'),
      formation_jurisdiction: clean(args.formation_jurisdiction, 80),
      business_type: clean(args.business_type, 80),
      service_interest: [...new Set(services)].slice(0, 5),
      service_preference: pick(args.service_preference, PREFERENCES, 'unknown'),
      preferred_contact_method: pick(args.preferred_contact_method, CONTACT_METHODS, 'unspecified'),
      conversation_summary: summary,
      marketing_consent: args.marketing_consent === true,
      consent_given: true,
      consent_text: CONSENT_TEXT
    }
  };
}

/** The instruction block added to the site's prompt while lead capture is on. */
export function leadPromptBlock(site, visitor = {}) {
  const known = [visitor.name && `name: ${clean(visitor.name, 120)}`, visitor.email && `email: ${clean(visitor.email, 254)}`, visitor.phone && `phone: ${clean(visitor.phone, 30)}`].filter(Boolean);
  return [
    'LEAD CAPTURE',
    'You can pass the visitor to the team as a lead.',
    '- Only after the visitor has clearly agreed (answered yes) to share their details with the team for follow-up, and you have their name and email. Phone is optional.',
    '- Never for a visitor who declined, only asked a question, or has not been asked yet.',
    '- To pass the lead on, write your normal short reply to the visitor, then on a new line add exactly one block: <lead>{"visitor_name":"","email":"","phone":"","company_name":"","entity_status":"' + ENTITY_STATUSES.join('|') + '","formation_jurisdiction":"","business_type":"","service_interest":["' + SERVICES.join('"|"') + '"],"service_preference":"' + PREFERENCES.join('|') + '","preferred_contact_method":"' + CONTACT_METHODS.join('|') + '","short_summary":"1-3 factual sentences","contact_consent":true}</lead>',
    '- Do NOT say the details were saved, sent or shared. The system confirms that itself once the team receives them. You may say you are passing them on.',
    '- Never ask for SSNs, EINs, ID scans, bank or card details, or passwords.',
    site.leadInstructions ? `Qualification instructions for this website:\n${site.leadInstructions}` : '',
    known.length ? `Contact details already on file from the chat form (the visitor has NOT yet agreed to share them with the team): ${known.join(', ')}.` : ''
  ].filter(Boolean).join('\n');
}

const LEAD_BLOCK = /<lead>([\s\S]*?)<\/lead>/i;

/** Splits a model reply into its visible text and the raw lead object (or null). */
export function extractLead(text) {
  const match = LEAD_BLOCK.exec(String(text));
  const visible = String(text).replace(/<lead>[\s\S]*?<\/lead>/gi, '').replace(/<\/?lead>/gi, '').trim();
  if (!match) return { visible, raw: null, present: false };
  try { return { visible, raw: JSON.parse(match[1]), present: true }; } catch { return { visible, raw: null, present: true }; }
}

/** Limits how often one chat or one website can push leads (an hour window). */
export class LeadLimiter {
  constructor({ now = () => Date.now(), perConversation = 5, perSite = 60 } = {}) { Object.assign(this, { now, perConversation, perSite }); this.hits = new Map(); }
  limited(siteId, conversationId) {
    const cutoff = this.now() - 3_600_000;
    const touch = (key, max) => {
      const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
      if (list.length >= max) { this.hits.set(key, list); return true; }
      list.push(this.now()); this.hits.set(key, list); return false;
    };
    return touch(`s:${siteId}`, this.perSite) || (conversationId ? touch(`c:${siteId}:${conversationId}`, this.perConversation) : false);
  }
}
