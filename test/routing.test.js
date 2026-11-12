import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ConversationStore, routeChat, MAX_HOPS } from '../src/routing.js';
import { extractTransfer, routingBlock } from '../src/chat.js';

const sites = (over = {}) => [
  { id: 'front', token: 'f'.repeat(64), provider: 'openai', model: 'm', systemPrompt: 'FRONT DESK', transferTargets: ['nc', 'office'], routeLabel: '', ...over.front },
  { id: 'nc', token: 'n'.repeat(64), provider: 'openai', model: 'm', systemPrompt: 'NC LLC AGENTS', routeLabel: 'NC LLC Agents: registered agent', transferTargets: ['front', 'office'], ...over.nc },
  { id: 'office', token: 'o'.repeat(64), provider: 'openai', model: 'm', systemPrompt: 'OFFICE SPACE', routeLabel: 'University Place Office Suites', transferTargets: ['front'], ...over.office }
];

function setup(script, over) {
  const config = loadConfig({ OPENAI_API_KEY: 'sk-test-key-1234567890', SITES_JSON: JSON.stringify({ sites: sites(over) }) });
  const seen = [];
  // The fake model decides by who is asking (its instructions) and what the customer last said.
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const who = /FRONT DESK/.test(body.instructions) ? 'front' : /NC LLC AGENTS/.test(body.instructions) ? 'nc' : 'office';
    const last = body.input.at(-1).content;
    seen.push({ who, last, instructions: body.instructions });
    return { ok: true, json: async () => ({ output_text: script(who, last, body.instructions) }) };
  };
  const convs = new ConversationStore('');
  const ask = (text, key = '704|705', extra = {}) => routeChat({ entry: config.sites[0], convs, key, messages: [{ role: 'user', content: text }], context: { channel: 'sms', handoff: true }, config, fetchFn, ...extra });
  return { config, convs, seen, ask };
}

const script = (who, last) => {
  if (who === 'front') return /registered agent/i.test(last) ? 'Happy to help. <transfer>nc|wants registered agent</transfer>' : /office/i.test(last) ? 'One moment. <transfer>office|needs office</transfer>' : 'What do you need help with?';
  if (who === 'nc') return /office/i.test(last) ? 'Sure. <transfer>office|changed topic</transfer>' : 'NC LLC Agents here: registered agent is $98/year.';
  return /registered/i.test(last) ? 'Sure. <transfer>nc|changed topic</transfer>' : 'Office space: when would you like to tour?';
};

test('transfer tag is parsed and removed from the text', () => {
  assert.deepEqual(extractTransfer('Sure <transfer>NC | wants RA </transfer>'), { visible: 'Sure', transfer: { target: 'nc', reason: 'wants RA' } });
  assert.deepEqual(extractTransfer('plain'), { visible: 'plain', transfer: null });
});

test('the routing block lists only the allowed targets and tells a new assistant not to re-ask', () => {
  const text = routingBlock({ targets: [{ id: 'nc', label: 'NC LLC' }], arrivedFrom: { reason: 'wants RA' } });
  assert.match(text, /- nc: NC LLC/);
  assert.match(text, /do not ask again/i);
  assert.equal(routingBlock(null), '');
});

test('unclear first message: the front desk answers, nobody else, no transfer', async () => {
  const { ask, seen } = setup(script);
  const out = await ask('hi');
  assert.equal(out.assistant, 'front');
  assert.equal(out.routed, undefined);
  assert.equal(out.text, 'What do you need help with?');
  assert.deepEqual(seen.map((s) => s.who), ['front']);
});

test('clear first message routes straight to the right assistant and only the new one replies', async () => {
  const { ask, seen } = setup(script);
  const out = await ask('I need a registered agent');
  assert.equal(out.assistant, 'nc');
  assert.deepEqual(out.routed, { from: 'front', to: 'nc', reason: 'wants registered agent' });
  assert.equal(out.text, 'NC LLC Agents here: registered agent is $98/year.');
  assert.deepEqual(seen.map((s) => s.who), ['front', 'nc']);
  assert.match(seen[1].instructions, /NC LLC AGENTS/);
  assert.doesNotMatch(seen[1].instructions, /FRONT DESK/, 'no prompt mixing');
  assert.match(seen[1].instructions, /TRANSFERRED CUSTOMER/);
});

test('later messages stay with the active assistant; topic change moves them; menu goes back', async () => {
  const { ask, seen, convs } = setup(script);
  await ask('I need a registered agent');
  seen.length = 0;
  assert.equal((await ask('how much?')).assistant, 'nc');
  assert.deepEqual(seen.map((s) => s.who), ['nc']);
  const moved = await ask('actually I need an office');
  assert.equal(moved.assistant, 'office');
  assert.equal(moved.routed.from, 'nc');
  const back = await ask('menu');
  assert.equal(back.assistant, 'front');
  assert.equal(convs.get('front', '704|705').hops, 0);
});

test('conversations are separate per key', async () => {
  const { ask } = setup(script);
  await ask('I need a registered agent', 'a|1');
  assert.equal((await ask('hi', 'b|2')).assistant, 'front');
  assert.equal((await ask('hello', 'a|1')).assistant, 'nc');
});

test('a transfer to an assistant that is not allowed, missing or disabled is refused safely', async () => {
  const notAllowed = setup(script, { front: { transferTargets: ['nc'] } });
  const out = await notAllowed.ask('I need an office');
  assert.equal(out.assistant, 'front');
  assert.equal(out.routed, undefined);
  assert.doesNotMatch(out.text, /transfer/);
  const disabled = setup(script);
  disabled.config.sites = disabled.config.sites.map((x) => (x.id === 'nc' ? { ...x, disabled: true } : x));   // as saved by the admin UI
  assert.equal((await disabled.ask('I need a registered agent')).assistant, 'front');
});

test('ping-pong is stopped after the hop limit', async () => {
  const pingpong = (who) => (who === 'nc' ? 'x <transfer>office|swap</transfer>' : who === 'office' ? 'x <transfer>nc|swap</transfer>' : 'x <transfer>nc|go</transfer>');
  const { ask, convs } = setup(pingpong, { nc: { transferTargets: ['office'] }, office: { transferTargets: ['nc'] } });
  let last;
  for (let i = 0; i < 8; i += 1) last = await ask(`msg ${i}`);
  assert.ok(convs.get('front', '704|705').hops <= MAX_HOPS);
  assert.ok(['nc', 'office'].includes(last.assistant));
});

test('an assistant removed later resets the conversation to the front desk', async () => {
  const { ask, config } = setup(script);
  await ask('I need a registered agent');
  config.sites = config.sites.filter((s) => s.id !== 'nc');
  assert.equal((await ask('hello')).assistant, 'front');
});

test('a conversation idle for over 24 hours starts again at the front desk', async () => {
  const { ask, convs } = setup(script);
  let now = Date.now();
  convs.now = () => now;
  await ask('I need a registered agent');
  now += 25 * 3600_000;
  assert.equal((await ask('hello')).assistant, 'front');
});

test('a failure on the new assistant leaves the customer on the one that asked', async () => {
  const { config, convs } = setup(script);
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (/NC LLC AGENTS/.test(body.instructions)) throw new Error('boom');
    return { ok: true, json: async () => ({ output_text: 'Sure <transfer>nc|ra</transfer>' }) };
  };
  await assert.rejects(routeChat({ entry: config.sites[0], convs, key: 'k|1', messages: [{ role: 'user', content: 'registered agent' }], context: { channel: 'sms' }, config, fetchFn }));
  assert.equal(convs.get('front', 'k|1').active, 'front');
});
