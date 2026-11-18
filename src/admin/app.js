'use strict';
const app = document.getElementById('app');
let state = null;
let cli = null;             // installed CLI versions + login state
let freebuff = null;        // interactive-only CLI status
let toolVersions = null;    // pinned / installed / npm latest
const PROVIDERS = [['anthropic', 'Anthropic API'], ['openai', 'OpenAI API'], ['ollama', 'Remote Ollama'], ['claude-cli', 'Claude subscription (CLI)'], ['codex-cli', 'ChatGPT subscription (Codex CLI)'], ['antigravity-cli', 'Google Antigravity (CLI)'], ['copilot-cli', 'GitHub Copilot (CLI)']];
const MASTER_CHOICES = [['', 'Per assistant'], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity'], ['copilot', 'Copilot'], ['ollama', 'Ollama']];
const MASTER_PROVIDER = { claude: 'claude-cli', codex: 'codex-cli', antigravity: 'antigravity-cli', copilot: 'copilot-cli', ollama: 'ollama' };
const isCli = (p) => p.endsWith('-cli');
// Views: the dashboard plus focused Settings pages.
const VIEWS = ['dashboard', 'providers', 'account'];
const fromHash = () => { const k = location.hash.slice(1); return k === 'logins' ? 'providers' : VIEWS.includes(k) ? k : 'dashboard'; };
let view = fromHash();
function go(v) {
  view = v; history.replaceState(null, '', v === 'dashboard' ? location.pathname + location.search : '#' + v); render();
  if (v !== 'dashboard') { const p = document.querySelector('.split .panel'); if (p) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
let notice = null;           // { kind: 'err'|'ok', text, secret? }
const models = {};           // provider -> [ids]
const open = new Set();      // expanded site ids

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const words = (code) => String(code || 'error').replace(/_/g, ' ');

async function api(path, method = 'GET', body) {
  const init = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
  const res = await fetch('/admin/api' + path, init);
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/login') { state = null; renderLogin(); throw new Error('signed out'); }
  if (!res.ok) throw new Error(words(data.error || 'error ' + res.status));
  return data;
}

async function run(fn, okText) {
  try { const out = await fn(); if (okText) notice = { kind: 'ok', text: okText }; return out; }
  catch (e) { if (e.message !== 'signed out') notice = { kind: 'err', text: e.message }; }
  finally { if (state) render(); }
}

async function refresh() {
  state = await api('/state');
  try { cli = await api('/cli'); } catch { cli = null; }
  try { freebuff = await api('/freebuff'); } catch { freebuff = null; }
}

function copyButton(text, label = 'Copy') {
  const b = h('button', { type: 'button' }, label);
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; } });
  return b;
}

function field(label, control) { return h('div', null, h('label', null, label), control); }

/* ---------- login ---------- */
function renderLogin(message) {
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const remember = h('input', { type: 'checkbox', name: 'remember', checked: true });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/login', 'POST', { username: user.value, password: pass.value, remember: remember.checked }); await refresh(); notice = null; render(); }
    catch (err) { renderLogin(err.message); }
  } },
    h('h2', null, 'AJMCP Admin'),
    message ? h('div', { class: 'notice err' }, message) : null,
    h('div', { class: 'row' }, field('User', user)),
    h('div', { class: 'row' }, field('Password', pass)),
    h('label', { class: 'check' }, remember, ' Keep me signed in'),
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  app.replaceChildren(h('section', { class: 'card login' }, form));
}

/* ---------- sites ---------- */
async function loadModels(provider, datalist) {
  if (!isCli(provider) && provider !== 'ollama' && !state.keys[provider].set) { datalist.replaceChildren(); return; }
  if (!models[provider] || !models[provider].length) {
    try { models[provider] = (await api('/models?provider=' + provider)).models; } catch { models[provider] = []; }
  }
  datalist.replaceChildren(...models[provider].map((m) => h('option', { value: m })));
}

const kb = (chars) => chars >= 1000 ? Math.round(chars / 1000) + ' KB' : chars + ' chars';
const providerLabel = (p) => (PROVIDERS.find(([k]) => k === p) || [0, p])[1];
const SECTIONS = [['general', 'AI Behavior'], ['knowledge', 'Knowledge'], ['tests', 'Tests'], ['leads', 'Leads'], ['access', 'Access']];

// Tree selection: which site and which part of it is shown on the right.
let sel = { id: null, section: 'general', add: false };
const treeOpen = new Set();

function modelPicker(site) {
  const provider = h('select', null, ...PROVIDERS.map(([p, label]) => h('option', { value: p, selected: p === (site ? site.provider : 'anthropic') }, label)));
  const list = h('datalist', { id: 'models-' + (site ? site.id : 'new') });
  const model = h('input', { value: site ? site.model : '', list: list.id, placeholder: 'blank = CLI default (API: model id)' });
  const refreshList = () => loadModels(provider.value, list);
  provider.addEventListener('change', refreshList);
  model.addEventListener('focus', refreshList, { once: true });
  return { provider, model, list };
}

/* ---------- right-hand panels ---------- */
function generalPanel(site) {
  const { provider, model, list } = modelPicker(site);
  const prompt = h('textarea', { rows: 8 });
  prompt.value = site.systemPrompt;
  // Routing: what this assistant handles (shown to the assistants that can pass customers to it) and who it may pass to.
  const routeLabel = h('input', { value: site.routeLabel || '', placeholder: 'What it handles, e.g. NC LLC Agents: registered agent, LLC formation' });
  const others = state.sites.filter((s) => s.id !== site.id);
  const boxes = others.map((o) => ({ id: o.id, box: h('input', { type: 'checkbox', checked: (site.transferTargets || []).includes(o.id) || null }) }));
  return [
    h('div', { class: 'row' }, field('Provider', provider), field('Model', model), list),
    h('div', null, h('label', null, 'Instructions (system prompt)'), prompt),
    h('div', { class: 'mt' }, field('What this assistant handles', routeLabel)),
    others.length ? h('div', { class: 'mt' }, h('label', null, 'Can transfer customers to'),
      h('div', { class: 'meta' }, 'Text messages only. The AI asks the server to move a customer; the server checks this list.'),
      ...boxes.map(({ id, box }) => h('label', { class: 'check' }, box, ' ' + id))) : null,
    h('div', { class: 'actions mt' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { provider: provider.value, model: model.value, systemPrompt: prompt.value, routeLabel: routeLabel.value, transferTargets: boxes.filter((b) => b.box.checked).map((b) => b.id) }).then(refresh), 'Saved ' + site.id) }, 'Save'))
  ];
}

function knowledgePanel(site) {
  const strict = h('input', { type: 'checkbox', checked: site.strict || null });
  const fallback = h('input', { value: site.fallback, placeholder: 'Reply when the answer is not in the knowledge' });
  const title = h('input', { placeholder: 'Title (e.g. Pricing, FAQ, Services)' });
  const text = h('textarea', { placeholder: 'Paste text here, or choose a .txt / .md / .csv / .json file', rows: 6 });
  const file = h('input', { type: 'file', multiple: true, accept: '.txt,.md,.markdown,.csv,.json,.html,.htm,text/*' });
  // Several files selected: each becomes its own document (title = first line if short, else file name).
  let batch = [];
  file.addEventListener('change', async () => {
    const picked = [...file.files];
    batch = [];
    if (!picked.length) return;
    if (picked.some((f) => f.size > 1_000_000)) { notice = { kind: 'err', text: 'file too large (1 MB max)' }; render(); return; }
    if (picked.length === 1) {
      text.value = await picked[0].text();
      if (!title.value) title.value = picked[0].name.replace(/\.[^.]+$/, '');
      return;
    }
    for (const f of picked) {
      const raw = (await f.text()).replace(/^\uFEFF/, '').trim();
      const nl = raw.indexOf('\n');
      const first = (nl < 0 ? raw : raw.slice(0, nl)).trim();
      const useFirst = nl > 0 && first.length > 0 && first.length <= 80;
      batch.push({ title: useFirst ? first : f.name.replace(/\.[^.]+$/, ''), text: useFirst ? raw.slice(nl + 1).trim() : raw });
    }
    title.value = '';
    text.value = `${batch.length} files ready:\n` + batch.map((d) => '• ' + d.title).join('\n') + '\n\nClick Add document to add them all.';
  });
  const question = h('input', { placeholder: 'Try a visitor question', onkeydown: (e) => { if (e.key === 'Enter') askBtn.click(); } });
  const busy = testRun && testRun.siteId === site.id && !testRun.endedAt;
  const askBtn = h('button', { type: 'button', class: 'primary', disabled: busy || null, onclick: () => askTest(site, question.value.trim()) }, busy ? 'Asking…' : 'Ask');
  const docs = site.knowledge.length
    ? site.knowledge.map((d) => h('div', { class: 'doc' },
        h('span', { class: 'grow' }, d.title), h('span', { class: 'meta' }, kb(d.chars)),
        h('button', { class: 'danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove "${d.title}"?`)) return;
          await run(() => api('/sites/' + site.id + '/knowledge/' + d.id, 'DELETE').then(refresh), 'Removed ' + d.title);
        } }, 'Remove')))
    : [h('div', { class: 'empty' }, 'No documents yet.')];
  const testBox = h('div', { id: 'test-box' });
  paintTest(testBox, site.id);
  const left = h('div', { class: 'kn-docs' },
    h('h3', null, 'Documents ', h('span', { class: 'pill' }, `${site.knowledge.length} docs · ${kb(site.knowledgeChars)}`)),
    ...docs);
  const right = h('div', { class: 'kn-side' },
    h('h3', null, 'Add documents'),
    h('div', { class: 'row' }, field('Files (select several)', file), field('Title (single file or pasted text)', title)),
    text,
    h('div', { class: 'actions mt' },
      h('button', { type: 'button', onclick: () => {
        if (batch.length) {
          const docsToAdd = batch;
          run(async () => { for (const d of docsToAdd) await api('/sites/' + site.id + '/knowledge', 'POST', d); await refresh(); }, `Added ${docsToAdd.length} documents`);
          return;
        }
        if (!title.value.trim() || !text.value.trim()) { notice = { kind: 'err', text: 'title and text are required' }; render(); return; }
        run(() => api('/sites/' + site.id + '/knowledge', 'POST', { title: title.value, text: text.value }).then(refresh), 'Added ' + title.value.trim());
      } }, 'Add')),
    h('h3', { class: 'mt' }, 'Behavior'),
    h('label', { class: 'check' }, strict, ' Answer only from this knowledge'),
    h('div', { class: 'actions mt' },
      h('div', { class: 'grow' }, fallback),
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { strict: strict.checked, fallback: fallback.value }).then(refresh), 'Saved ' + site.id) }, 'Save')),
    h('h3', { class: 'mt' }, 'Try it'),
    h('div', { class: 'actions' }, h('div', { class: 'grow' }, question), askBtn),
    testBox);
  return [h('div', { class: 'kn' }, left, right)];
}

/* ---------- "Try it" with a live timer; the answer shows right under the button ---------- */
let testRun = null;   // { siteId, question, startedAt, endedAt?, ok?, reply?, error? }
let testTimer = null;
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';

function paintTest(box, siteId) {
  box.replaceChildren();
  if (!testRun || testRun.siteId !== siteId) return;
  const done = !!testRun.endedAt;
  if (!done) {
    box.append(h('div', { class: 'testbox run' }, h('span', { class: 'spin' }), ` Thinking… ${secs(Date.now() - testRun.startedAt)}`, h('div', { class: 'meta' }, 'Q: ' + testRun.question)));
    return;
  }
  const took = secs(testRun.endedAt - testRun.startedAt);
  box.append(h('div', { class: 'testbox ' + (testRun.ok ? 'ok' : 'err') },
    h('div', { class: 'meta' }, `Q: ${testRun.question} · ${testRun.ok ? 'answered' : 'failed'} in ${took}`),
    h('div', { class: 'reply' }, testRun.ok ? testRun.reply : words(testRun.error))));
}

async function askTest(site, q) {
  if (!q) return;
  clearInterval(testTimer);
  testRun = { siteId: site.id, question: q, startedAt: Date.now() };
  const tick = () => { const b = document.getElementById('test-box'); if (b) paintTest(b, site.id); };
  render();
  testTimer = setInterval(tick, 200);
  try {
    const r = await api('/sites/' + site.id + '/test', 'POST', { question: q });
    testRun = { ...testRun, endedAt: Date.now(), ok: !!r.ok, reply: r.reply, error: r.error };
  } catch (e) {
    testRun = { ...testRun, endedAt: Date.now(), ok: false, error: e.message };
  } finally {
    clearInterval(testTimer); testTimer = null;
  }
  try { await refresh(); } catch { /* signed out */ }
  if (state) render();
}

/* ---------- Tests: upload a test-texts file; Expected is filled in, Actual waits for Ask ---------- */
// Accepts the ChatGPT format:  1. Customer: "text"  /  Expected: what should happen.  (also "Q:" and unnumbered blocks)
function parseTests(raw) {
  const text = String(raw).replace(/\r\n/g, '\n').replace(/^﻿/, '');
  let blocks = text.split(/\n(?=\s*\d+[.)]\s)/).map((b) => (/^\s*\d+[.)]\s*([\s\S]*)$/.exec(b.trim()) || [])[1]).filter(Boolean);
  if (!blocks.length) blocks = text.split(/\n\s*\n/).filter((b) => /expected\s*:/i.test(b));
  const out = [];
  for (const body of blocks) {
    const m = /(^|\n)\s*Expected\s*:\s*/i.exec(body);
    const q = (m ? body.slice(0, m.index) : body).replace(/^\s*(Customer|Q|Question|Text)\s*:\s*/i, '').trim().replace(/^["“”']+|["“”']+$/g, '').trim();
    const expected = m ? body.slice(m.index + m[0].length).replace(/\s+/g, ' ').trim() : '';
    if (q) out.push({ question: q, expected });
  }
  return out;
}

const testResults = {};   // 'site:testId' -> { sid, tid, startedAt, endedAt?, ok?, reply?, error? }
let testsTicker = null;
const actId = (sid, tid) => `act-${sid}-${tid}`;

function fillActual(el, r) {
  el.replaceChildren();
  el.className = 'tt-actual ' + (!r ? 'idle' : !r.endedAt ? 'run' : r.ok ? 'ok' : 'err');
  if (!r) { el.append('Waiting — click Ask'); return; }
  if (!r.endedAt) { el.append(h('span', { class: 'spin' }), ` Thinking… ${secs(Date.now() - r.startedAt)}`); return; }
  el.append(h('div', { class: 'meta' }, `${r.ok ? 'Answered' : 'Failed'} in ${secs(r.endedAt - r.startedAt)}`), h('div', { class: 'reply' }, r.ok ? r.reply : words(r.error)));
}
function repaintActual(r) { const el = document.getElementById(actId(r.sid, r.tid)); if (el) fillActual(el, r); }
function ensureTicker() {
  if (testsTicker) return;
  testsTicker = setInterval(() => {
    const running = Object.values(testResults).filter((r) => !r.endedAt);
    running.forEach(repaintActual);
    if (!running.length) { clearInterval(testsTicker); testsTicker = null; }
  }, 200);
}
async function askTestRow(site, t) {
  const key = `${site.id}:${t.id}`;
  if (testResults[key] && !testResults[key].endedAt) return;
  const r = (testResults[key] = { sid: site.id, tid: t.id, startedAt: Date.now() });
  repaintActual(r); ensureTicker();
  try {
    const out = await api('/sites/' + site.id + '/test', 'POST', { question: t.question });
    Object.assign(r, { endedAt: Date.now(), ok: !!out.ok, reply: out.reply, error: out.error });
  } catch (e) { Object.assign(r, { endedAt: Date.now(), ok: false, error: e.message }); }
  repaintActual(r);
}

function testsPanel(site) {
  const tests = site.tests || [];
  const file = h('input', { type: 'file', accept: '.txt,.md,text/*' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 200_000) { notice = { kind: 'err', text: 'file too large (200 KB max)' }; render(); return; }
    const parsed = parseTests(await f.text());
    if (!parsed.length) { notice = { kind: 'err', text: 'no tests found: use "1. Customer: … / Expected: …"' }; render(); return; }
    if (parsed.length > 30) { notice = { kind: 'err', text: `${parsed.length} tests found, 30 max` }; render(); return; }
    Object.keys(testResults).filter((k) => k.startsWith(site.id + ':')).forEach((k) => delete testResults[k]);
    run(() => api('/sites/' + site.id, 'PUT', { tests: parsed }).then(refresh), `Loaded ${parsed.length} tests`);
  });
  const rows = tests.length ? tests.map((t) => {
    const actual = h('div', { id: actId(site.id, t.id) });
    fillActual(actual, testResults[`${site.id}:${t.id}`]);
    return h('div', { class: 'tt-row' },
      h('div', { class: 'tt-q' }, h('span', { class: 'tt-n' }, t.id), h('span', { class: 'grow' }, t.question),
        h('button', { type: 'button', class: 'primary', onclick: () => askTestRow(site, t) }, 'Ask')),
      h('div', { class: 'tt-cols' },
        h('div', null, h('div', { class: 'meta' }, 'Expected'), h('div', { class: 'tt-expected' }, t.expected || '—')),
        h('div', null, h('div', { class: 'meta' }, 'Actual'), actual)));
  }) : [h('div', { class: 'empty' }, 'No tests yet. Upload a test-texts file.')];
  return [
    h('h3', null, 'Test texts ', h('span', { class: 'pill' }, `${tests.length} tests`)),
    h('div', { class: 'actions' }, h('div', { class: 'grow' }, file),
      h('button', { type: 'button', disabled: tests.length ? null : true, onclick: async () => { for (const t of tests) await askTestRow(site, t); } }, 'Ask all'),
      h('button', { class: 'danger', type: 'button', disabled: tests.length ? null : true, onclick: async () => {
        if (!confirm('Remove all tests for ' + site.id + '?')) return;
        Object.keys(testResults).filter((k) => k.startsWith(site.id + ':')).forEach((k) => delete testResults[k]);
        await run(() => api('/sites/' + site.id, 'PUT', { tests: [] }).then(refresh), 'Tests removed');
      } }, 'Remove all')),
    ...rows
  ];
}

function leadsPanel(site) {
  const capture = h('input', { type: 'checkbox', checked: site.leadCapture || null });
  const instructions = h('textarea', { rows: 6, placeholder: 'How to qualify visitors for this website (who to ask what, which services, when to offer a follow-up)…' });
  instructions.value = site.leadInstructions;
  return [
    h('div', { class: 'meta' }, 'The AI asks permission, then hands the lead to the website\'s AJMCP plugin, which saves it in AJCore. Leads are listed in WordPress under AJMCP → Leads.'),
    h('label', { class: 'check mt' }, capture, ' Capture leads from this chat'),
    h('div', { class: 'mt' }, h('label', null, 'Qualification instructions'), instructions),
    h('div', { class: 'actions mt' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { leadCapture: capture.checked, leadInstructions: instructions.value }).then(refresh), 'Saved ' + site.id) }, 'Save'))
  ];
}

function accessPanel(site) {
  const s = site.stats;
  return [
    h('div', { class: 'facts' },
      h('div', null, h('label', null, 'Server URL'), h('code', null, location.origin)),
      h('div', null, h('label', null, 'Assistant id'), h('code', null, site.id)),
      h('div', null, h('label', null, 'Token'), h('code', null, '…' + (site.tokenHint || '????'))),
      h('div', null, h('label', null, 'Since last restart'), h('span', null, s.requests ? `${s.requests} requests · ${s.errors} errors` + (s.lastErrorCode ? ` · last: ${s.lastErrorCode}` : '') : 'no requests yet'))),
    h('h3', { class: 'mt' }, 'Access tokens'),
    h('div', { class: 'meta' }, 'Each system that talks to this assistant (AJOps, a website) can have its own token, so one can be revoked without touching the others.'),
    h('div', { class: 'doc' }, h('span', { class: 'grow' }, 'Primary token'), h('span', { class: 'meta' }, '…' + (site.tokenHint || '????'))),
    ...(site.tokens || []).map((t) => h('div', { class: 'doc' },
      h('span', { class: 'grow' }, t.label), h('span', { class: 'meta' }, '…' + (t.hint || '????')),
      h('button', { class: 'danger', type: 'button', onclick: async () => {
        if (!confirm(`Revoke the "${t.label}" token? Whatever uses it stops working immediately.`)) return;
        await run(() => api('/sites/' + site.id + '/tokens/' + t.id, 'DELETE').then(refresh), 'Revoked ' + t.label);
      } }, 'Revoke'))),
    (() => {
      const label = h('input', { placeholder: 'Name (e.g. AJOps)' });
      return h('div', { class: 'actions mt' }, label, h('button', { type: 'button', onclick: () => {
        if (!label.value.trim()) { notice = { kind: 'err', text: 'give the token a name' }; render(); return; }
        run(async () => { const r = await api('/sites/' + site.id + '/tokens', 'POST', { label: label.value.trim() }); notice = { kind: 'ok', text: `Token "${r.label}" for ${site.id} (shown once):`, secret: r.token }; await refresh(); });
      } }, 'Add token'));
    })(),
    h('div', { class: 'actions mt' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(async () => {
        const r = await api('/sites/' + site.id + '/test', 'POST');
        notice = r.ok ? { kind: 'ok', text: `${site.id}: model replied “${r.reply}” (${r.model})` } : { kind: 'err', text: `${site.id}: test failed — ${words(r.error)}${r.detail ? ' — ' + r.detail : ''}` };
        await refresh();
      }) }, 'Test'),
      h('button', { type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { disabled: !site.disabled }).then(refresh), (site.disabled ? 'Enabled ' : 'Disabled ') + site.id) }, site.disabled ? 'Enable' : 'Disable'),
      h('button', { type: 'button', onclick: async () => {
        if (!confirm(`Rotate token for ${site.id}? The current token stops working.`)) return;
        await run(async () => { const r = await api('/sites/' + site.id + '/rotate', 'POST'); notice = { kind: 'ok', text: `New token for ${site.id} (shown once):`, secret: r.token }; await refresh(); });
      } }, 'Rotate token'),
      h('button', { class: 'danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete assistant ${site.id}? Its token stops working immediately.`)) return;
        sel = { id: null, section: 'general', add: false };
        await run(() => api('/sites/' + site.id, 'DELETE').then(refresh), 'Deleted ' + site.id);
      } }, 'Delete'))
  ];
}

function addPanel() {
  const id = h('input', { placeholder: 'assistant-id', pattern: '[a-z0-9][a-z0-9_\\-]{1,63}', required: true });
  const { provider, model, list } = modelPicker(null);
  const prompt = h('textarea', { placeholder: 'Instructions (optional, can be added later)', rows: 5 });
  return [h('form', { onsubmit: (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/sites', 'POST', { id: id.value.trim(), provider: provider.value, model: model.value.trim(), systemPrompt: prompt.value });
      sel = { id: r.site.id, section: 'access', add: false };
      treeOpen.add(r.site.id);
      notice = { kind: 'ok', text: `Assistant ${r.site.id} created. Token (shown once):`, secret: r.token };
      await refresh();
    });
  } },
    h('div', { class: 'row' }, field('Assistant id', id), field('Provider', provider), field('Model', model), list),
    h('div', null, prompt),
    h('div', { class: 'actions mt' }, h('button', { class: 'primary', type: 'submit', disabled: !state.storage || null }, 'Create assistant')))];
}

/* ---------- left-hand tree ---------- */
function treeNode(site) {
  const here = view === 'dashboard' && !sel.add && sel.id === site.id;
  const opened = treeOpen.has(site.id);
  return h('div', { class: 'tnode' },
    h('button', { type: 'button', class: 'tparent' + (here ? ' on' : ''), onclick: () => {
      if (here && opened) treeOpen.delete(site.id); else treeOpen.add(site.id);
      sel = { id: site.id, section: here ? sel.section : 'general', add: false };
      go('dashboard');
    } },
      h('span', { class: 'caret' }, opened ? '▾' : '▸'),
      h('span', { class: 'dot tone-' + site.provider + (site.disabled ? ' off' : '') }),
      h('span', { class: 'tname' }, site.id),
      site.disabled ? h('span', { class: 'pill off' }, 'off') : null),
    opened ? h('div', { class: 'tkids' }, SECTIONS.map(([key, label]) => h('button', { type: 'button', class: 'tchild' + (here && sel.section === key ? ' on' : ''), onclick: () => { sel = { id: site.id, section: key, add: false }; go('dashboard'); } },
      label, key === 'knowledge' && site.knowledge.length ? h('span', { class: 'count' }, site.knowledge.length) : key === 'tests' && (site.tests || []).length ? h('span', { class: 'count' }, site.tests.length) : null))) : null);
}

// how: a hint string, or steps [[text, command?], …]; each command gets a Copy button.
function howView(how) {
  if (!Array.isArray(how)) return h('div', { class: 'meta' }, how);
  return h('ol', { class: 'steps' }, how.map(([text, cmd]) => h('li', null, text,
    cmd ? h('div', { class: 'cmdrow' }, h('code', { class: 'command' }, cmd), copyButton(cmd)) : null)));
}

// pasteAlt: put the paste box behind a collapsed fallback (logins that are best done inside the pod).
function cliRow(name, label, how, field, pasteAlt) {
  const info = cli && cli[name];
  const isToken = field === 'claudeToken' || field === 'copilotToken';
  const input = h(isToken ? 'input' : 'textarea', isToken
    ? { type: 'password', autocomplete: 'off', placeholder: 'Paste token' } : { placeholder: field === 'agyAuth' ? 'Paste oauth token file' : 'Paste auth.json' });
  const status = !info ? h('span', { class: 'pill bad' }, 'unavailable')
    : !info.version ? h('span', { class: 'pill bad' }, 'not installed')
    : h('span', { class: 'pill ' + (info.loggedIn ? 'on' : 'off') }, info.version);
  const instructions = info && info.loggedIn
    ? h('details', { class: 'inline-help' }, h('summary', null, 'Login instructions'), howView(how))
    : howView(how);
  return h('div', { class: 'sub' },
    h('h3', null, label, status),
    instructions,
    (() => {
      const save = h('button', { type: 'button', onclick: () => {
        if (!input.value.trim()) { notice = { kind: 'err', text: 'paste the login first' }; render(); return; }
        run(async () => { cli = await api('/cli', 'PUT', { [field]: input.value.trim() }); }, label + ' login saved');
      } }, 'Save login');
      return pasteAlt
        ? h('details', { class: 'inline-help mt' }, h('summary', null, pasteAlt), h('div', { class: 'row mt' }, input), save)
        : h('div', null, h('div', { class: 'row mt' }, input), save);
    })(),
    h('div', { class: 'actions mt' },
      h('button', { type: 'button', onclick: () => run(async () => {
        const r = await api('/cli/' + name + '/test', 'POST');
        notice = r.ok ? { kind: 'ok', text: `${label}: replied “${r.reply}”` } : { kind: 'err', text: `${label}: test failed — ${words(r.error)}${r.detail ? ' — ' + r.detail : ''}` };
      }) }, 'Test'),
      isToken && info && info.tokenSet ? h('button', { class: 'danger', type: 'button', onclick: () => run(async () => { cli = await api('/cli', 'PUT', { [field]: null }); }, label + ' token removed') }, 'Remove') : null));
}

/* ---------- keys / password ---------- */
function keyRow(provider, label) {
  const info = state.keys[provider];
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: info.set ? 'Replace key' : 'Paste key' });
  return h('div', { class: 'sub' },
    h('h3', null, label, h('span', { class: 'pill ' + (info.set ? 'on' : 'off') }, info.set ? `set …${info.hint} (${info.source})` : 'not set')),
    h('div', { class: 'row' }, input),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => {
        if (!input.value.trim()) { notice = { kind: 'err', text: 'enter a key first' }; render(); return; }
        run(async () => { await api('/keys', 'PUT', { [provider]: input.value.trim() }); delete models[provider]; await refresh(); }, label + ' key saved');
      } }, 'Save'),
      info.source === 'admin' ? h('button', { class: 'danger', type: 'button', onclick: () => run(async () => { await api('/keys', 'PUT', { [provider]: null }); delete models[provider]; await refresh(); }, label + ' key removed') }, 'Remove') : null));
}

function passwordForm() {
  const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12, required: true });
  return h('form', { onsubmit: (e) => {
    e.preventDefault();
    run(async () => { await api('/password', 'POST', { current: current.value, next: next.value }); }, 'Password changed');
  } },
    h('div', { class: 'row' }, field('Current password', current), field('New password (12+ chars)', next)),
    h('button', { type: 'submit' }, 'Change password'));
}

/* ---------- main ---------- */
/* ---------- master switch: every assistant, chat, SMS, lead and agent job through one tool ---------- */
function masterBar() {
  const m = state.master || { provider: '', models: {}, sites: [] };
  const saveMaster = (provider, mm, text) => run(async () => { state.master = await api('/master', 'PUT', { provider, models: mm }); await refresh(); }, text);
  const choose = (provider) => saveMaster(provider, m.models, provider ? 'All AI now runs on ' + (MASTER_CHOICES.find(([k]) => k === provider) || [0, provider])[1] : 'Each assistant uses its own provider again');
  const seg = h('div', { class: 'seg' }, MASTER_CHOICES.map(([key, label]) => h('button', { type: 'button', class: m.provider === key ? 'on' : '', onclick: () => { if (m.provider !== key) choose(key); } }, label)));
  const kids = [h('div', { class: 'mhead' }, h('strong', null, 'AI master switch'), seg)];
  if (m.provider) {
    const providerKey = MASTER_PROVIDER[m.provider];
    const ready = m.provider === 'ollama' ? state.ollama && state.ollama.tunnelConnected : cli && cli[m.provider] && cli[m.provider].loggedIn;
    const readyText = ready ? 'Ready' : (m.provider === 'ollama' ? 'Disconnected' : 'Login needed');
    const pick = h('input', { list: 'mmodels', placeholder: 'Model (blank = default)', value: m.models[m.provider] || '' });
    const list = h('datalist', { id: 'mmodels' });
    if (models[providerKey]) models[providerKey].forEach((id) => list.append(h('option', { value: id })));
    else api('/models?provider=' + providerKey).then((r) => { models[providerKey] = r.models || []; if (state) render(); }).catch(() => { models[providerKey] = []; });
    // Saves as soon as a model is picked or typed (change fires on selection and on leaving the field).
    pick.addEventListener('change', () => { if (pick.value.trim() !== (m.models[m.provider] || '')) saveMaster(m.provider, { ...m.models, [m.provider]: pick.value.trim() }, 'Master model saved'); });
    const diff = (m.sites || []).filter((s) => s.own !== s.running);
    const d = h('details', { class: 'mmore' }, h('summary', null, 'Model', h('span', { class: 'pill ' + (ready ? 'on' : 'off') }, readyText), h('span', { class: 'meta' }, m.models[m.provider] || 'default')),
      h('div', { class: 'mrow' }, pick, list), h('div', { class: 'meta' }, `${(m.sites || []).length} on ${m.label}` + (diff.length ? ` · ${diff.length} switched` : '')));
    d.open = masterOpen; d.addEventListener('toggle', () => { masterOpen = d.open; });
    kids.push(d);
  }
  return h('section', { class: 'card master' + (m.provider ? ' is-on' : '') }, ...kids);
}
let masterOpen = false;

function quickStatus() {
  const total = state.sites.reduce((n, x) => n + x.stats.requests, 0);
  const errors = state.sites.reduce((n, x) => n + x.stats.errors, 0);
  const active = state.sites.filter((x) => !x.disabled).length;
  const keys = ['anthropic', 'openai'].filter((p) => state.keys[p].set).length;
  const button = (label, value, ready, action, title) => h('button', { type: 'button', class: 'quick' + (ready === false ? ' warn' : ''), onclick: action, title },
    ready == null ? null : h('span', { class: 'qdot ' + (ready ? 'ok' : 'no') }),
    h('span', { class: 'qlabel' }, label), value == null ? null : h('strong', null, value));
  const provider = (label, key, info) => button(label, null, Boolean(info && info.loggedIn), () => { vendor = key; go('providers'); }, info && info.loggedIn ? `${label} ready` : `${label} login needed`);
  return h('nav', { class: 'quickbar', 'aria-label': 'System status' },
    button('Assistants', `${active}/${state.sites.length}`, null, () => { sel.add = false; go('dashboard'); }),
    button('Requests', total, null, () => { activity.pinned = true; activity.problems = false; railEl?.classList.add('pinned'); loadActivity(); }),
    button('Errors', errors, errors === 0, () => { activity.pinned = true; activity.problems = true; railEl?.classList.add('pinned'); loadActivity(); }),
    provider('Claude', 'anthropic', cli && cli.claude),
    provider('Codex', 'openai', cli && cli.codex),
    provider('Google', 'google', cli && cli.antigravity),
    provider('Copilot', 'copilot', cli && cli.copilot),
    provider('Freebuff', 'freebuff', freebuff && { loggedIn: freebuff.loggedIn }),
    button('API keys', `${keys}/2`, keys === 2, () => { vendor = 'openai'; go('providers'); }));
}

function sitesTab() {
  if (!sel.add && !state.sites.some((x) => x.id === sel.id)) {
    if (state.sites.length) { sel = { id: state.sites[0].id, section: 'general', add: false }; treeOpen.add(sel.id); }
    else sel = { id: null, section: 'general', add: true };
  }
  const site = state.sites.find((x) => x.id === sel.id);
  const tree = h('nav', { class: 'tree' },
    h('button', { type: 'button', class: 'tadd' + (view === 'dashboard' && sel.add ? ' on' : ''), onclick: () => { sel = { id: sel.id, section: sel.section, add: true }; go('dashboard'); } }, '+ Add assistant'),
    ...state.sites.map(treeNode),
    state.sites.length ? null : h('div', { class: 'empty' }, 'No assistants yet.'));
  const panel = view === 'providers' ? providersView() : view === 'account' ? accountView() : sel.add ? [h('h2', null, 'Add assistant'), ...addPanel()]
    : [h('h2', null, h('span', { class: 'grow' }, `${site.id} · ${(SECTIONS.find(([k]) => k === sel.section) || [0, ''])[1]}`),
        h('span', { class: 'pill ' + (site.disabled ? 'off' : 'on') }, site.disabled ? 'disabled' : 'active'),
        h('span', { class: 'pill tone-' + site.provider }, providerLabel(site.provider))),
      ...(sel.section === 'knowledge' ? knowledgePanel(site) : sel.section === 'tests' ? testsPanel(site) : sel.section === 'leads' ? leadsPanel(site) : sel.section === 'access' ? accessPanel(site) : generalPanel(site))];
  return [h('div', { class: 'split' }, tree, h('section', { class: 'card panel' }, ...panel))];
}

const openSections = new Set();   // collapsible cards the user has expanded (collapsed by default)

function collapsible(id, title, summary, ...children) {
  const d = h('details', { class: 'card fold', open: openSections.has(id) || null },
    h('summary', null, h('span', { class: 'grow' }, title), summary), ...children);
  d.addEventListener('toggle', () => { d.open ? openSections.add(id) : openSections.delete(id); });
  return d;
}

/* ---------- timeouts: per model (or per provider), blank = default ---------- */
let tdraft = null;
function timeoutsPanel() {
  const rows = tdraft || Object.entries(state.timeouts || {}).map(([k, v]) => [k, String(v)]);
  const list = h('datalist', { id: 'tkeys' }, [...PROVIDERS.map(([k]) => k), ...Object.values(models).flat()].map((k) => h('option', { value: k })));
  const inputs = rows.map(([k, v]) => [h('input', { list: 'tkeys', placeholder: 'Model or provider (e.g. ollama)', value: k }), h('input', { type: 'number', min: 5, max: 600, placeholder: 'sec', value: v, style: 'width:90px' })]);
  const collect = () => inputs.map(([a, b]) => [a.value.trim(), b.value.trim()]);
  const set = Object.entries(state.timeouts || {});
  return collapsible('timeouts', 'Timeouts',
    h('span', { class: 'sum' }, set.length ? set.map(([k, v]) => h('span', { class: 'pill on' }, `${k} ${v}s`)) : h('span', { class: 'meta' }, 'defaults')),
    h('div', { class: 'sub' }, list,
      ...inputs.map(([a, b], i) => h('div', { class: 'mrow' }, a, b, h('button', { type: 'button', class: 'danger', onclick: () => { const c = collect(); c.splice(i, 1); tdraft = c; render(); } }, 'Remove'))),
      h('div', { class: 'actions mt' },
        h('button', { type: 'button', onclick: () => { tdraft = [...collect(), ['', '']]; render(); } }, 'Add'),
        h('button', { type: 'button', onclick: () => run(async () => {
          const out = {};
          for (const [k, v] of collect()) if (k) out[k] = Number(v);
          await api('/timeouts', 'PUT', { timeouts: out }); tdraft = null; await refresh();
        }, 'Timeouts saved') }, 'Save'))));
}

/* ---------- AI Providers: one entry per vendor; its subscription login, API key or connection on the right ---------- */
const VENDORS = [['openai', 'ChatGPT', 'OpenAI'], ['anthropic', 'Claude', 'Anthropic'], ['google', 'Google', 'Antigravity'], ['freebuff', 'Freebuff', 'Interactive CLI'], ['ollama', 'Ollama', 'Self-hosted'], ['copilot', 'GitHub Copilot', 'GitHub']];
let vendor = 'openai';
const cliTone = (i) => !i || !i.version ? 'bad' : i.loggedIn ? 'on' : 'off';

function vendorPills(key) {
  const sub = (name, label) => { const i = cli && cli[name]; return h('span', { class: 'pill ' + cliTone(i) }, label + (i && i.loggedIn ? ' ✓' : ' –')); };
  const apiKey = (p) => h('span', { class: 'pill ' + (state.keys[p].set ? 'on' : 'off') }, 'API key' + (state.keys[p].set ? ' ✓' : ' –'));
  if (key === 'openai') return [sub('codex', 'Subscription'), apiKey('openai')];
  if (key === 'anthropic') return [sub('claude', 'Subscription'), apiKey('anthropic')];
  if (key === 'google') return [sub('antigravity', 'Subscription')];
  if (key === 'freebuff') return [h('span', { class: 'pill ' + (freebuff && freebuff.loggedIn ? 'on' : 'off') }, freebuff && freebuff.loggedIn ? 'Ready' : 'Login needed')];
  if (key === 'copilot') return [sub('copilot', 'Token')];
  const o = state.ollama || {};
  return [h('span', { class: 'pill ' + (o.tunnelConnected ? 'on' : 'off') }, o.tunnelConnected ? 'Connected' : 'Disconnected')];
}
const vendorReady = (key) => vendorPills(key).some((p) => p.classList.contains('on'));

// Runs a command in the AJMCP pod with the persistent home, so logins survive restarts.
const POD = 'oc exec -it -n ajmcp deploy/ajmcp-server -c ajmcp -- env HOME=/data/home ';

function vendorBody(key) {
  if (key === 'openai') return [h('div', { class: 'grid2' },
    cliRow('codex', 'ChatGPT subscription (Codex CLI)', [
      ['In Terminal on your Mac, log in to OpenShift:', 'oc login'],
      ['Start the login inside the AJMCP pod:', POD + 'codex login --device-auth'],
      ['Open the URL it prints, sign in to ChatGPT and enter the code. (If device-code login is disabled, enable it in ChatGPT → Settings → Security.)'],
      ['Click Test below.']], 'codexAuth', 'Paste ~/.codex/auth.json instead (stops working when your Mac refreshes it)'),
    keyRow('openai', 'OpenAI API'))];
  if (key === 'anthropic') return [h('div', { class: 'grid2' },
    cliRow('claude', 'Claude subscription (CLI)', [
      ['In Terminal on your Mac, run and sign in:', 'claude setup-token'],
      ['Paste the token it prints below, click Save login, then Test.']], 'claudeToken'),
    keyRow('anthropic', 'Anthropic API'))];
  if (key === 'google') return [h('div', { class: 'grid2' },
    cliRow('antigravity', 'Google Antigravity (agy)', [
      ['In Terminal on your Mac, log in to OpenShift:', 'oc login'],
      ['Start the login inside the AJMCP pod:', POD + 'agy'],
      ['Complete the Google sign-in in the browser and paste the code back into Terminal.'],
      ['Click Test below.']], 'agyAuth', 'Paste the oauth token file instead (a Mac copy is usually stale)'))];
  if (key === 'copilot') return [h('div', { class: 'grid2' },
    cliRow('copilot', 'GitHub Copilot', [
      ['On GitHub: Settings → Developer settings → Personal access tokens → Fine-grained tokens → create one with the Copilot Requests permission.'],
      ['Paste it below, click Save login, then Test.']], 'copilotToken'))];
  if (key === 'freebuff') return [freebuffPanel()];
  return ollamaPanel();
}

let fbTerm = null;
let fbEvents = null;
let fbInput = '';
let fbInputTimer = null;

function sendFreebuffInput(data) {
  fbInput += data;
  if (fbInputTimer) return;
  fbInputTimer = setTimeout(async () => {
    const pending = fbInput.slice(0, 8192); fbInput = fbInput.slice(pending.length); fbInputTimer = null;
    try { await api('/freebuff/input', 'POST', { data: pending }); }
    catch (error) { notice = { kind: 'err', text: error.message }; render(); }
    if (fbInput) sendFreebuffInput('');
  }, 20);
}

function mountFreebuffTerminal(host) {
  if (!window.Terminal) { host.textContent = 'Terminal component unavailable.'; return; }
  if (!fbTerm) {
    fbTerm = new window.Terminal({ cols: 120, rows: 36, cursorBlink: true, convertEol: false, scrollback: 5000,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 13,
      theme: { background: '#111418', foreground: '#e8edf2', cursor: '#65d46e', selectionBackground: '#32526b' } });
    fbTerm.onData(sendFreebuffInput);
    // Freebuff asks the terminal for its colours (OSC 10 = text, OSC 11 = background) to pick a light or dark palette.
    // xterm.js does not answer these, so Freebuff assumed a light background and drew dark text. Reply with our theme.
    const oscColor = (hex) => 'rgb:' + [1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join('/');
    const answer = (code, hex) => fbTerm.parser.registerOscHandler(code, (data) => {
      if (data !== '?') return false;
      sendFreebuffInput(`\x1b]${code};${oscColor(hex)}\x1b\\`);
      return true;
    });
    answer(10, '#e8edf2');
    answer(11, '#111418');
  }
  if (!fbTerm.element) fbTerm.open(host);
  else host.append(fbTerm.element);
  if (!fbEvents) {
    fbEvents = new EventSource('/admin/api/freebuff/events');
    fbEvents.addEventListener('output', (event) => { try { fbTerm.write(JSON.parse(event.data)); } catch { /* malformed event */ } });
    fbEvents.addEventListener('exit', (event) => {
      try { const info = JSON.parse(event.data); fbTerm.writeln(`\r\n[Freebuff ${words(info.reason)}]`); } catch { /* malformed event */ }
      freebuff = { ...(freebuff || {}), running: false };
    });
  }
  fbTerm.focus();
}

function freebuffPanel() {
  const installed = freebuff && freebuff.installed;
  const running = freebuff && freebuff.running;
  const host = h('div', { class: 'fbterm', role: 'application', 'aria-label': 'Freebuff terminal' });
  queueMicrotask(() => mountFreebuffTerminal(host));
  const start = h('button', { class: 'primary', type: 'button', disabled: !installed || running || null, onclick: async () => {
    try {
      freebuff = await api('/freebuff/start', 'POST', { cols: 120, rows: 36 });
      if (fbTerm) { fbTerm.reset(); fbTerm.focus(); }
      notice = { kind: 'ok', text: 'Freebuff terminal started' }; render();
    } catch (error) { notice = { kind: 'err', text: error.message }; render(); }
  } }, running ? 'Running' : 'Start Freebuff');
  const stop = h('button', { class: 'danger', type: 'button', disabled: !running || null, onclick: async () => {
    try { await api('/freebuff/stop', 'POST'); freebuff = await api('/freebuff'); render(); }
    catch (error) { notice = { kind: 'err', text: error.message }; render(); }
  } }, 'Stop');
  return h('div', { class: 'stack' },
    h('div', { class: 'sub' },
      h('h3', null, 'Freebuff CLI',
        h('span', { class: 'pill ' + (installed ? 'on' : 'bad') }, installed ? 'installed' : 'not installed'),
        h('span', { class: 'pill ' + (freebuff && freebuff.loggedIn ? 'on' : 'off') }, freebuff && freebuff.loggedIn ? 'logged in' : 'login required')),
      h('div', { class: 'actions' }, start, stop),
      h('div', { class: 'meta mt' }, 'Admin only. Freebuff can run commands and access container files. Sessions stop after 30 idle minutes or four hours total.'),
      host));
}

function providersView() {
  if (!VENDORS.some(([k]) => k === vendor)) vendor = 'openai';
  if (!toolVersions) {
    toolVersions = { loading: true, tools: {} };
    api('/tool-versions').then((data) => { toolVersions = data; if (view === 'providers') render(); }).catch(() => { toolVersions = { error: true, tools: {} }; if (view === 'providers') render(); });
  }
  const [, name, by] = VENDORS.find(([k]) => k === vendor);
  const list = h('nav', { class: 'tree vlist' }, VENDORS.map(([key, label, sub]) =>
    h('button', { type: 'button', class: 'tparent' + (key === vendor ? ' on' : ''), onclick: () => { vendor = key; render(); } },
      h('span', { class: 'dot ' + (vendorReady(key) ? 'ok' : 'no') }),
      h('span', { class: 'tname' }, label, h('span', { class: 'meta vsub' }, sub)))));
  return [h('h2', null, h('span', { class: 'grow' }, `AI Providers · ${name} (${by})`), ...vendorPills(vendor)),
    toolVersionsPanel(),
    h('div', { class: 'vsplit' }, list, h('div', { class: 'vbody' }, ...vendorBody(vendor)))];
}

function toolVersionsPanel() {
  const labels = { codex: 'Codex', claude: 'Claude', copilot: 'Copilot', freebuff: 'Freebuff' };
  const tools = toolVersions && toolVersions.tools || {};
  const rows = Object.keys(labels).map((key) => {
    const info = tools[key] || {};
    const update = `npm run tools:update -- --tool ${key}`;
    return h('tr', null,
      h('td', null, labels[key]),
      h('td', null, h('code', null, info.pinned || '—')),
      h('td', null, h('code', null, info.installed || '—')),
      h('td', null, h('code', null, info.latest || (toolVersions && !toolVersions.loading ? 'unavailable' : 'checking…'))),
      h('td', null, h('span', { class: 'pill ' + (info.updateAvailable ? 'off' : info.latest ? 'on' : '') }, info.updateAvailable ? 'update available' : info.latest ? 'current' : 'unknown')),
      h('td', null, info.updateAvailable ? copyButton(update, 'Copy update') : null));
  });
  const all = 'npm run tools:update -- --tool codex\nnpm run tools:update -- --tool claude\nnpm run tools:update -- --tool copilot\nnpm run tools:update -- --tool freebuff';
  return h('details', { class: 'card fold versions' },
    h('summary', null, 'CLI versions', h('span', { class: 'sum' }, Object.values(tools).filter((x) => x.updateAvailable).length ? h('span', { class: 'pill off' }, 'updates available') : h('span', { class: 'pill on' }, toolVersions && !toolVersions.loading ? 'checked' : 'checking…'))),
    h('div', { class: 'tblwrap mt' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Provider', 'Pinned', 'Installed', 'npm latest', 'Status', 'Command'].map((x) => h('th', null, x)))), h('tbody', null, ...rows))),
    h('div', { class: 'actions mt' },
      h('button', { type: 'button', onclick: async () => {
        try { toolVersions = await api('/tool-versions?refresh=1'); render(); }
        catch (error) { notice = { kind: 'err', text: error.message }; render(); }
      } }, 'Check now'),
      copyButton(all, 'Copy all update commands')),
    h('div', { class: 'meta mt' }, 'Run update commands in the repository, review tool-versions.json, then rebuild and deploy. Live pods are never modified in place.'));
}

function ollamaPanel() {
  const o = state.ollama || {};
  const configured = o.sshHost && o.sshUser && o.keyConfigured && o.knownHostsConfigured;
  const status = (ok, yes, no) => h('span', { class: 'pill ' + (ok ? 'on' : 'off') }, ok ? yes : no);
  const host = h('input', { value: o.sshHost || '', placeholder: 'Ubuntu hostname or IP' });
  const user = h('input', { value: o.sshUser || '', placeholder: 'SSH username' });
  const port = h('input', { value: o.sshPort || 22, type: 'number', min: 1, max: 65535 });
  const keyFile = h('input', { type: 'file', accept: '.pem,.key,text/plain' });
  const hostsFile = h('input', { type: 'file', accept: 'text/plain' });
  const keyText = h('textarea', { rows: 5, placeholder: 'Or paste the complete private key, including BEGIN/END lines' });
  const hostsText = h('textarea', { rows: 4, placeholder: 'Or paste a known_hosts entry' });
  const fingerprint = h('input', { placeholder: 'Or paste SHA256:… to create known_hosts automatically' });
  const connection = h('div', { class: 'sub' },
    h('h3', null, 'SSH tunnel', status(o.tunnelConnected, 'SSH connected', 'SSH disconnected')),
    h('div', { class: 'row' }, field('Host / IP', host), field('User', user), field('Port', port)),
    h('div', { class: 'row' }, field('Upload private key', keyFile), field('Upload known_hosts', hostsFile)),
    h('div', { class: 'row' }, field('Paste private key', keyText), field('Paste known_hosts', hostsText)),
    field('Verified ED25519 fingerprint (automatic known_hosts)', fingerprint),
    h('details', { class: 'inline-help mt' },
      h('summary', null, 'How to get the fingerprint'),
      h('div', { class: 'meta mt' }, 'Run this on the Ubuntu server where Ollama is installed:'),
      h('code', { class: 'command' }, 'sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'),
      h('div', { class: 'meta mt' }, 'Copy only the value beginning with SHA256: and paste it above. AJMCP fetches the public host key and accepts it only if the fingerprints match.')),
    h('div', { class: 'facts mt' },
      field('Private key Secret', status(o.keyConfigured, 'mounted', 'missing')),
      field('known_hosts Secret', status(o.knownHostsConfigured, 'mounted', 'missing'))),
    h('div', { class: 'actions mt' }, h('button', { class: 'primary', type: 'button', onclick: () => run(async () => {
      const privateKey = keyFile.files[0] ? await keyFile.files[0].text() : keyText.value.trim();
      const knownHosts = hostsFile.files[0] ? await hostsFile.files[0].text() : hostsText.value.trim();
      if (!host.value.trim() || !user.value.trim() || !privateKey) throw new Error('host, user, and private key are required');
      if (!knownHosts && !fingerprint.value.trim()) throw new Error('upload/paste known_hosts or enter the verified fingerprint');
      const result = await api('/ollama', 'PUT', {
        host: host.value.trim(), user: user.value.trim(), port: Number(port.value),
        privateKey, knownHosts, fingerprint: fingerprint.value.trim()
      });
      notice = { kind: 'ok', text: result.restarting ? 'SSH Secret saved. AJMCP is restarting; refresh in about 30 seconds.' : 'SSH Secret saved.' };
    }) }, 'Save configuration'),
    h('button', { type: 'button', disabled: !configured || null, onclick: () => run(async () => {
      const r = await api('/ollama/test', 'POST');
      models.ollama = r.models || [];
      notice = r.ok ? { kind: 'ok', text: `Connected to Ollama · ${models.ollama.length} model(s)` } : { kind: 'err', text: `Connection failed — ${words(r.error)}` };
      await refresh();
    }) }, 'Connect')),
    h('div', { class: 'meta mt' }, 'Stored in OpenShift Secrets; saving triggers a rollout.'));
  const available = models.ollama || [];
  const modelPanel = h('div', { class: 'sub' },
    h('h3', null, 'Models', status(available.length, available.length + ' available', 'not loaded')),
    available.length ? h('div', { class: 'model-list' }, available.map((id) => h('code', { class: 'model-chip' }, id))) : h('div', { class: 'empty' }, 'Connect to discover models.'),
    h('div', { class: 'actions mt' }, h('button', { type: 'button', onclick: () => go('dashboard') }, 'Choose per assistant')));
  return [h('div', { class: 'stack' }, connection, modelPanel)];
}

/* ---------- Activity rail: did the request reach the server, and what happened ----------
   Lives on the right of the dashboard. Compact (time / assistant / status / took) until hovered or pinned,
   then it widens over the page and shows every column, filters and conversations. Auto-refresh repaints
   only the rail, so typing in an assistant panel is never interrupted. */
const activity = { entries: [], since: null, problems: false, auto: true, loaded: false, timer: null, error: '', pinned: false };
let railEl = null;

async function loadActivity() {
  try {
    const d = await api('/activity' + (activity.problems ? '?problems=1' : ''));
    activity.entries = d.entries || []; activity.since = d.since; activity.error = '';
  } catch (e) { if (e.message !== 'signed out') activity.error = e.message; }
  activity.loaded = true;
  if (state) paintRail();
}

function ensureActivityTimer() {
  if (activity.timer) return;
  activity.timer = setInterval(() => {
    if (!state) { clearInterval(activity.timer); activity.timer = null; return; }
    if (activity.auto) loadActivity();
  }, 5000);
}

const ROUTE_NAMES = { '/v1/ajcore/reply': 'chat / text reply', '/v1/chat': 'chat', '/v1/assistant': 'assistant', '/mcp': 'mcp', '/v1/agents/run': 'agent' };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const took = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const openActivity = new Set();
const isBad = (x) => !x.running && (x.status >= 400 || x.error);

function transcriptView(entry) {
  const messages = entry.transcript || [];
  return h('div', { class: 'audit' },
    h('div', { class: 'audit-meta' },
      h('span', null, 'Request ', h('code', null, entry.requestId || '—')),
      h('span', null, 'Provider ', h('code', null, entry.provider || '—')),
      h('span', null, 'Model ', h('code', null, entry.model || '—')),
      entry.routedFrom ? h('span', null, 'Routed from ', h('code', null, entry.routedFrom)) : null),
    messages.length ? h('div', { class: 'conversation' }, messages.map((message) =>
      h('div', { class: 'bubble ' + message.role },
        h('div', { class: 'bubble-role' }, message.role === 'user' ? 'Visitor' : message.role === 'assistant' ? 'Assistant' : `Tool${message.name ? ` · ${message.name}` : ''}`),
        h('div', { class: 'bubble-text' }, message.content))))
      : h('div', { class: 'empty' }, entry.error ? `No transcript captured · ${words(entry.error)}` : 'No transcript captured for this request.'));
}

function activityRail() {
  if (!activity.loaded) loadActivity();
  ensureActivityTimer();
  railEl = h('aside', { class: 'rail' + (activity.pinned ? ' pinned' : '') });
  paintRail();
  return h('div', { class: 'rail-slot' }, railEl);
}

function paintRail() {
  if (!railEl) return;
  const top = railEl.scrollTop;
  railEl.replaceChildren(...activityContent().filter(Boolean));
  railEl.scrollTop = top;
}

function activityContent() {
  // One row per conversation: requests of the same assistant + session are grouped (newest first), the newest one leads.
  const groups = []; const byKey = new Map();
  for (const e of activity.entries) {
    const key = e.sessionId != null ? `${e.site}|${e.assistant || ''}|${e.channel || ''}|${e.sessionId}`
      : e.conversation ? `${e.site}|${e.channel || ''}|c:${e.conversation}` : e.requestId;
    let g = byKey.get(key);
    if (!g) { g = { key, e, items: [] }; byKey.set(key, g); groups.push(g); }
    g.items.push(e);
  }
  const rows = groups.flatMap(({ key, e, items }) => {
    const bad = isBad(e);
    const failed = items.filter(isBad).length;
    const modelsUsed = [...new Set(items.map((x) => x.model).filter(Boolean))];
    let withText = items.find((x) => x.transcript);
    // If the client sends only the newest message each time, stitch the turns together oldest first.
    if (withText && items.length > 1 && withText.transcript.length <= 2) {
      const turns = items.filter((x) => x.transcript).reverse().flatMap((x) => x.transcript);
      withText = { ...withText, transcript: turns };
    }
    const who = e.assistant && e.assistant !== e.site ? `${e.site} → ${e.assistant}` : (e.site || '—');
    const expanded = openActivity.has(key);
    const row = h('tr', { class: bad ? 'bad' : '', title: e.error ? words(e.error) : null },
      h('td', null, clock(e.t)),
      h('td', null, who, e.via && e.via !== 'primary' ? h('span', { class: 'meta' }, ' · ' + e.via) : null),
      h('td', { class: 'x' }, ROUTE_NAMES[e.route] || e.route, e.channel ? h('span', { class: 'meta' }, ' · ' + e.channel) : null),
      h('td', { class: 'x' }, modelsUsed.length ? modelsUsed.map((m, k) => [k ? ', ' : '', h('code', null, m)]).flat() : '—', e.provider ? h('span', { class: 'meta' }, ' · ' + e.provider) : null),
      h('td', { class: 'x' }, e.sessionId != null ? '#' + e.sessionId : e.conversation ? h('code', { title: 'Chat id (no session sent by the client)' }, e.conversation) : '—', items.length > 1 ? h('span', { class: 'meta' }, ` · ${items.length} messages`) : (e.chars != null ? h('span', { class: 'meta' }, ` · ${e.chars} chars`) : null)),
      h('td', null, h('span', { class: 'pill ' + (e.running ? 'off' : bad ? 'bad' : 'on') }, e.running ? 'running…' : String(e.status))),
      h('td', null, took(e.ms)),
      h('td', { class: 'x' }, e.error ? words(e.error) + (e.host ? ` (${e.host})` : '') : (e.running ? '' : 'ok'), failed && !bad ? h('span', { class: 'meta' }, ` · ${failed} failed earlier`) : null,
        withText ? h('button', { type: 'button', class: 'audit-toggle', onclick: () => { expanded ? openActivity.delete(key) : openActivity.add(key); paintRail(); } }, expanded ? 'Hide' : 'View conversation') : null));
    return expanded && withText ? [row, h('tr', { class: 'audit-row x' }, h('td', { colspan: 8 }, transcriptView(withText)))] : [row];
  });
  const last = activity.entries[0];
  const problems = activity.entries.filter(isBad).length;
  const cols = [['Time'], ['Assistant'], ['Request', 1], ['Model', 1], ['Session', 1], ['Status'], ['Took'], ['Result', 1]];
  return [
    h('h2', null, h('span', { class: 'grow' }, 'Activity'),
      problems ? h('span', { class: 'pill bad' }, `${problems} failed`) : null,
      last ? h('span', { class: 'meta' }, clock(last.t)) : null,
      h('button', { type: 'button', class: 'pin', onclick: () => { activity.pinned = !activity.pinned; railEl.classList.toggle('pinned', activity.pinned); paintRail(); } }, activity.pinned ? 'Unpin' : 'Pin open')),
    h('div', { class: 'actions x' },
      h('button', { type: 'button', onclick: () => loadActivity() }, 'Refresh'),
      h('button', { type: 'button', class: 'danger', disabled: activity.entries.length ? null : true, onclick: async () => {
        try { await api('/activity', 'DELETE'); activity.entries = []; } catch (e) { if (e.message !== 'signed out') activity.error = e.message; }
        paintRail();
      } }, 'Clear'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: activity.auto || null, onchange: (e) => { activity.auto = e.target.checked; } }), ' Auto-refresh'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: activity.problems || null, onchange: (e) => { activity.problems = e.target.checked; loadActivity(); } }), ' Problems only'),
      activity.since ? h('span', { class: 'meta' }, 'since server start ' + new Date(activity.since).toLocaleString()) : null),
    activity.error ? h('div', { class: 'notice err mt' }, activity.error) : null,
    rows.length
      ? h('div', { class: 'tblwrap mt' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, cols.map(([c, x]) => h('th', { class: x ? 'x' : null }, c)))),
          h('tbody', null, rows)))
      : h('div', { class: 'empty mt' }, activity.loaded ? 'No requests yet. If a chat message or text was sent and nothing appears here, it never reached this server.' : 'Loading…')];
}

/* ---------- dashboard / account / top bar ---------- */
function dashboard() {
  return [h('div', { class: 'dash' },
    h('div', { class: 'dash-main' },
      h('div', { class: 'controls' }, masterBar(), timeoutsPanel()),
      quickStatus(),
      ...sitesTab()),
    activityRail())];
}

function accountView() {
  return [h('h2', null, 'Account'),
    h('div', { class: 'acct' },
      h('div', { class: 'facts' }, field('User', h('code', null, state.user)), field('Version', h('code', null, 'v' + state.version))),
      h('h3', null, 'Change password'), passwordForm())];
}

async function signOut() {
  try { await api('/logout', 'POST'); } catch { /* already out */ }
  state = null; renderLogin();
}

// Settings opens on hover (desktop) or click/tap; Account sits at the bottom.
function topbar() {
  const menu = h('div', { class: 'menu' });
  const item = (v, label) => h('button', { type: 'button', role: 'menuitem', class: view === v ? 'on' : null, onclick: () => { menu.classList.remove('open'); go(v); } }, label);
  menu.append(
    h('button', { type: 'button', 'aria-haspopup': 'menu', onclick: () => menu.classList.toggle('open') }, '⚙ Settings'),
    h('div', { class: 'drop' }, h('div', { class: 'drop-in', role: 'menu' },
      item('dashboard', 'Dashboard'), item('providers', 'AI Providers'), h('hr'), item('account', 'Account'))));
  return h('header', { class: 'topbar' },
    h('h1', null, h('a', { href: location.pathname, title: 'Dashboard', onclick: (e) => { e.preventDefault(); sel.add = false; go('dashboard'); } }, 'AJMCP Admin')),
    h('span', { class: 'who' }, `v${state.version} · ${state.user}`),
    menu,
    h('button', { type: 'button', onclick: signOut }, 'Sign out'));
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.menu.open').forEach((m) => { if (!m.contains(e.target)) m.classList.remove('open'); });
});

function render() {
  const body = dashboard();
  app.replaceChildren(...[
    topbar(),
    notice ? h('div', { class: 'notice ' + notice.kind }, notice.text, notice.secret ? h('div', { class: 'secret' }, notice.secret) : null, notice.secret ? copyButton(notice.secret) : null) : null,
    !state.storage ? h('div', { class: 'notice err' }, 'No persistent storage: changes cannot be saved.') : null,
    ...body
  ].filter(Boolean));
}

(async () => {
  try { await refresh(); render(); } catch { renderLogin(); }
})();
