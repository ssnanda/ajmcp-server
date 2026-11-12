import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAjmcpServer } from '../src/server.js';
import { SettingsStore } from '../src/store.js';
import { hashPassword } from '../src/password.js';
import { validateLeadArgs, extractLead, LeadLimiter } from '../src/leads.js';

const TOKEN = 'T'.repeat(64);
const goodArgs = {
  visitor_name: 'Taylor Lee', email: 'Taylor@Example.com', phone: '704-555-0101', company_name: 'Lee Georgia LLC',
  entity_status: 'existing_other_state', formation_jurisdiction: 'Georgia', service_interest: ['foreign_qualification', 'registered_agent'],
  service_preference: 'assisted', preferred_contact_method: 'email', short_summary: 'Georgia LLC wants NC foreign qualification with team help.', contact_consent: true
};
const withLead = (text, args = goodArgs) => `${text}\n<lead>${JSON.stringify(args)}</lead>`;

async function fixture(modelText, { leadCapture = true, instructions = 'You are the NC LLC Agents assistant.' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ajmcp-leads-'));
  const config = loadConfig({
    DATA_DIR: dir, ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: await hashPassword('correct horse battery'), OPENAI_API_KEY: 'sk-test-key-1234567890',
    SITES_JSON: JSON.stringify({ sites: [{ id: 'one', token: TOKEN, provider: 'openai', model: 'm', systemPrompt: instructions }] })
  });
  const store = new SettingsStore(config);
  store.load();
  store.updateSite('one', { leadCapture, leadInstructions: 'Ask existing businesses whether they prefer to file themselves.' });
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ output_text: typeof modelText === 'function' ? modelText(calls.length) : modelText }) };
  };
  const server = createAjmcpServer(config, { store, fetchFn });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token = TOKEN, method = 'POST') => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, data: await res.json() };
  };
  const chat = (message, extra = {}) => post('/v1/ajcore/reply', { sessionId: 77, message, history: [], leadTool: true, ...extra });
  return { server, calls, chat, post, store, config };
}

test('validation: consent, name and email are required; a bad phone is dropped, not fatal', () => {
  assert.equal(validateLeadArgs({ ...goodArgs, contact_consent: false }).error, 'consent_required');
  assert.equal(validateLeadArgs({ ...goodArgs, contact_consent: 'true' }).error, 'consent_required');
  assert.equal(validateLeadArgs({ ...goodArgs, visitor_name: '' }).error, 'name_required');
  assert.equal(validateLeadArgs({ ...goodArgs, email: 'nope' }).error, 'valid_email_required');
  assert.equal(validateLeadArgs({ ...goodArgs, short_summary: '' }).error, 'summary_required');
  assert.equal(validateLeadArgs({ ...goodArgs, phone: '' }).payload.phone, '');
  assert.equal(validateLeadArgs({ ...goodArgs, phone: '555-01' }).payload.phone, '');
  const ok = validateLeadArgs({ ...goodArgs, service_interest: 'Mail forwarding', entity_status: 'martian' });
  assert.deepEqual(ok.payload.service_interest, ['other']);
  assert.equal(ok.payload.entity_status, 'unknown');
  assert.equal(ok.payload.marketing_consent, false);
  assert.equal(ok.payload.email, 'taylor@example.com');
});

test('the <lead> block is split from the visible reply', () => {
  const out = extractLead(withLead('Thanks Taylor.'));
  assert.equal(out.visible, 'Thanks Taylor.');
  assert.equal(out.raw.visitor_name, 'Taylor Lee');
  assert.deepEqual(extractLead('Just an answer.'), { visible: 'Just an answer.', raw: null, present: false });
  assert.equal(extractLead('Hi <lead>{broken</lead>').raw, null);
});

test('consent given: one call returns the reply and a validated lead for the plugin to save', async (t) => {
  const f = await fixture(withLead('Thanks Taylor. I will pass your details to our team.'));
  t.after(() => f.server.close());
  const { status, data } = await f.chat('Yes please, share my details. I am Taylor Lee, taylor@example.com, 704-555-0101.');
  assert.equal(status, 200);
  assert.equal(data.reply, 'Thanks Taylor. I will pass your details to our team.');
  assert.equal(f.calls.length, 1, 'a single model call, no tool round trip');
  assert.equal(data.lead.name, 'Taylor Lee');
  assert.equal(data.lead.email, 'taylor@example.com');
  assert.equal(data.lead.consent_given, true);
  assert.deepEqual(data.lead.service_interest, ['foreign_qualification', 'registered_agent']);
  assert.equal(data.reply.includes('<lead>'), false);
  assert.equal(JSON.stringify(data).includes('sk-test'), false);
  assert.match(f.calls[0].instructions, /LEAD CAPTURE/);
  assert.match(f.calls[0].instructions, /prefer to file themselves/);
});

test('the AI cannot announce a completed save: that sentence is replaced; the plugin adds the true result', async (t) => {
  const f = await fixture(withLead("Great, I've saved your details and shared them with our team."));
  t.after(() => f.server.close());
  const { data } = await f.chat('Yes.');
  assert.doesNotMatch(data.reply, /saved|shared them/);
  assert.match(data.reply, /passing your details/);
  assert.ok(data.lead);
});

test('no consent in the block: no lead is returned, with the reason', async (t) => {
  const f = await fixture(withLead('Thanks.', { ...goodArgs, contact_consent: false }));
  t.after(() => f.server.close());
  const { data } = await f.chat('my email is taylor@example.com');
  assert.equal(data.lead, undefined);
  assert.equal(data.leadError, 'consent_required');
});

test('missing email or name: no lead; missing phone is fine', async (t) => {
  const a = await fixture(withLead('Thanks.', { ...goodArgs, email: '' }));
  t.after(() => a.server.close());
  assert.equal((await a.chat('Yes.')).data.leadError, 'valid_email_required');
  const b = await fixture(withLead('Thanks.', { ...goodArgs, visitor_name: '' }));
  t.after(() => b.server.close());
  assert.equal((await b.chat('Yes.')).data.leadError, 'name_required');
  const c = await fixture(withLead('Thanks.', { ...goodArgs, phone: '' }));
  t.after(() => c.server.close());
  assert.equal((await c.chat('Yes.')).data.lead.phone, '');
});

test('visitor declines: ordinary answer, no lead', async (t) => {
  const f = await fixture('No problem. You can still ask questions here or see https://ncllcagents.com/service/.');
  t.after(() => f.server.close());
  const { data } = await f.chat("No, I don't want to give you my email.");
  assert.equal(data.lead, undefined);
  assert.equal(data.leadError, undefined);
  assert.match(data.reply, /No problem/);
});

test('lead capture off, or a plugin that cannot save leads: the AI gets no lead rules and never returns a lead', async (t) => {
  const off = await fixture(withLead('Thanks.'), { leadCapture: false });
  t.after(() => off.server.close());
  const a = await off.chat('Hi');
  assert.equal(off.calls[0].instructions.includes('LEAD CAPTURE'), false);
  assert.equal(a.data.lead, undefined);

  const on = await fixture('Hello!');
  t.after(() => on.server.close());
  await on.chat('Hi', { leadTool: false });
  assert.equal(on.calls[0].instructions.includes('LEAD CAPTURE'), false);
});

test('limits: at most 5 leads per conversation per hour', async (t) => {
  const f = await fixture(withLead('Thanks.'));
  t.after(() => f.server.close());
  const out = [];
  for (let i = 0; i < 7; i++) { const { data } = await f.chat('Yes.'); out.push(data.lead ? 'lead' : data.leadError); }
  assert.deepEqual(out, ['lead', 'lead', 'lead', 'lead', 'lead', 'rate_limited', 'rate_limited']);
  assert.equal(new LeadLimiter({ perConversation: 1 }).limited('s', 'c'), false);
});

test('site API: the plugin reads and edits its own AI behavior and knowledge with the site token', async (t) => {
  const f = await fixture('ok');
  t.after(() => f.server.close());
  const cfg = await f.post('/v1/site/config', null, TOKEN, 'GET');
  assert.equal(cfg.data.instructions, 'You are the NC LLC Agents assistant.');
  assert.equal(cfg.data.leadCapture, true);

  const put = await f.post('/v1/site/config', { instructions: 'New rules.', strict: false, fallback: 'Call us.', leadCapture: false, leadInstructions: 'Be brief.', provider: 'anthropic' }, TOKEN, 'PUT');
  assert.equal(put.status, 200);
  assert.deepEqual([put.data.instructions, put.data.strict, put.data.fallback, put.data.leadCapture], ['New rules.', false, 'Call us.', false]);
  assert.equal(put.data.provider, 'openai', 'a website cannot change its own provider or model');

  const add = await f.post('/v1/site/knowledge', { title: 'Pricing', text: 'Registered agent is $98/year.' });
  assert.equal(add.status, 201);
  const id = add.data.id;
  assert.equal((await f.post('/v1/site/knowledge/' + id, null, TOKEN, 'GET')).data.text, 'Registered agent is $98/year.');
  assert.equal((await f.post('/v1/site/knowledge/' + id, { text: 'Registered agent is $98 per year.' }, TOKEN, 'PUT')).status, 200);
  const list = (await f.post('/v1/site/knowledge', null, TOKEN, 'GET')).data.documents;
  assert.deepEqual(list.map((d) => [d.title, d.source]), [['Pricing', 'manual']]);

  const sync1 = await f.post('/v1/site/knowledge/sync', { source: 'website', docs: [{ ref: 'p1', title: 'Home', text: 'Welcome.' }, { ref: 'p2', title: 'Services', text: 'We offer RA service.' }] }, TOKEN, 'PUT');
  assert.deepEqual(sync1.data, { count: 2, removed: 0 });
  const sync2 = await f.post('/v1/site/knowledge/sync', { source: 'website', docs: [{ ref: 'p2', title: 'Services', text: 'We offer RA service and more.' }] }, TOKEN, 'PUT');
  assert.deepEqual(sync2.data, { count: 1, removed: 1 });
  const after = (await f.post('/v1/site/knowledge', null, TOKEN, 'GET')).data.documents;
  assert.equal(after.filter((d) => d.source === 'website').length, 1);
  assert.equal(after.filter((d) => d.source === 'manual').length, 1, 'manual documents are never touched by a website sync');
  assert.equal((await f.post('/v1/site/knowledge/' + id, null, TOKEN, 'DELETE')).status, 200);
  assert.equal((await f.post('/v1/site/config', null, 'x'.repeat(64), 'GET')).status, 401);
});

// ── Text messages (AJPhone) and human handoff ────────────────────────────────
import { cleanSms, extractHandoff } from '../src/chat.js';

test('cleanSms: formatting removed, one tidy line, cut to a whole sentence', () => {
  assert.equal(cleanSms('**Registered Agent** is $98/year.\n\n- Fast\n- Reliable\nSee [our page](https://ncllcagents.com/service/).'), 'Registered Agent is $98/year. Fast Reliable See our page https://ncllcagents.com/service/.');
  const long = 'This is a sentence. '.repeat(60);
  const out = cleanSms(long, 100);
  assert.ok(out.length <= 100 && out.endsWith('.'), 'cut at a sentence end');
  assert.equal(cleanSms('Plain text stays.'), 'Plain text stays.');
});

test('extractHandoff: the tag is removed and its reason returned', () => {
  assert.deepEqual(extractHandoff('A team member will follow up. <handoff>asked for a person</handoff>'), { visible: 'A team member will follow up.', reason: 'asked for a person' });
  assert.deepEqual(extractHandoff('No tag here.'), { visible: 'No tag here.', reason: null });
});

test('text channel: short plain-text rules are added and the reply is cleaned', async (t) => {
  const f = await fixture('**Registered Agent** is $98 per year.\n\n- Includes our NC address\nSign up at https://ncllcagents.com/service/');
  t.after(() => f.server.close());
  const { status, data } = await f.post('/v1/chat', { messages: [{ role: 'user', content: 'how much for a registered agent' }], channel: 'sms', conversationId: 'sms:+17045550101' });
  assert.equal(status, 200);
  assert.match(f.calls[0].instructions, /CHANNEL: TEXT MESSAGE/);
  assert.match(f.calls[0].instructions, /NC LLC Agents assistant/, 'the site prompt and knowledge still apply');
  assert.equal(data.reply, 'Registered Agent is $98 per year. Includes our NC address Sign up at https://ncllcagents.com/service/');
  assert.equal(data.handoff, undefined);
});

test('web chat is unchanged: no text-message rules, no handoff rules', async (t) => {
  const f = await fixture('Hello **there**.');
  t.after(() => f.server.close());
  const { data } = await f.post('/v1/chat', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(f.calls[0].instructions.includes('CHANNEL: TEXT MESSAGE'), false);
  assert.equal(f.calls[0].instructions.includes('HUMAN HANDOFF'), false);
  assert.equal(data.reply, 'Hello **there**.', 'web chat keeps its formatting');
});

test('handoff: asked for only by callers that can act on it, and reported separately from the text', async (t) => {
  const f = await fixture('Sorry about that. A team member will follow up shortly. <handoff>customer upset about billing</handoff>');
  t.after(() => f.server.close());
  const { data } = await f.post('/v1/chat', { messages: [{ role: 'user', content: 'this is the third time, I want a person' }], channel: 'sms', handoff: true, conversationId: 'sms:+17045550101' });
  assert.match(f.calls[0].instructions, /HUMAN HANDOFF/);
  assert.equal(data.reply, 'Sorry about that. A team member will follow up shortly.');
  assert.equal(data.handoff, 'customer upset about billing');
  assert.equal(data.reply.includes('<handoff>'), false);
});
