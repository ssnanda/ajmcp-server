import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, DEFAULT_FALLBACK, LIMITS } from '../src/knowledge.js';

const ask = (content) => [{ role: 'user', content }];

test('no knowledge leaves the system prompt untouched', () => {
  assert.deepEqual(buildSystemPrompt({ systemPrompt: 'Be nice.' }, ask('hi')), { system: 'Be nice.' });
});

test('small knowledge is sent whole with strict rules and the fallback', () => {
  const site = { systemPrompt: 'Be nice.', fallback: 'Call us.', knowledge: [{ title: 'Hours', text: 'Open 9 to 5.' }] };
  const { system } = buildSystemPrompt(site, ask('when are you open?'));
  assert.match(system, /Be nice\./);
  assert.match(system, /ONLY the reference material/);
  assert.match(system, /exactly: "Call us\."/);
  assert.match(system, /<reference_material>[\s\S]*Open 9 to 5\.[\s\S]*<\/reference_material>/);
});

test('strict mode off uses the softer rule', () => {
  const { system } = buildSystemPrompt({ strict: false, knowledge: [{ title: 'A', text: 'x' }] }, ask('hello'));
  assert.match(system, /Prefer the reference material/);
});

test('large knowledge is searched: only matching passages go to the model', () => {
  const filler = 'lorem ipsum dolor sit amet. '.repeat(40);
  const docs = [];
  for (let i = 0; i < 80; i++) docs.push({ title: `Filler ${i}`, text: `${filler}\n\nSection ${i} general text.` });
  docs.push({ title: 'Registered agent fees', text: 'The registered agent annual fee is $149 per year.' });
  const site = { knowledge: docs };
  assert.ok(docs.reduce((n, d) => n + d.text.length, 0) > LIMITS.inline);
  const { system } = buildSystemPrompt(site, ask('What is the annual fee for the registered agent?'));
  assert.match(system, /\$149 per year/);
  assert.ok(system.length < LIMITS.budget + 5000);
});

test('strict + nothing relevant in a large set: fixed fallback, no model call', () => {
  const docs = [];
  for (let i = 0; i < 80; i++) docs.push({ title: `Doc ${i}`, text: 'lorem ipsum dolor sit amet. '.repeat(40) });
  assert.deepEqual(buildSystemPrompt({ knowledge: docs }, ask('Tell me about quantum zebras')), { direct: DEFAULT_FALLBACK });
});
