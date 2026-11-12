'use strict';
const app = document.getElementById('app');
let state = null;
let cli = null;             // installed CLI versions + login state
const PROVIDERS = [['anthropic', 'Anthropic API'], ['openai', 'OpenAI API'], ['claude-cli', 'Claude subscription (CLI)'], ['codex-cli', 'ChatGPT subscription (Codex CLI)']];
const isCli = (p) => p.endsWith('-cli');
const TABS = [['sites', 'Assistants'], ['logins', 'Logins & keys'], ['account', 'Account']];
let tab = TABS.some(([k]) => '#' + k === location.hash) ? location.hash.slice(1) : 'sites';
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
}

function copyButton(text) {
  const b = h('button', { type: 'button' }, 'Copy');
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
  if (!isCli(provider) && !state.keys[provider].set) { datalist.replaceChildren(); return; }
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
        notice = r.ok ? { kind: 'ok', text: `${site.id}: model replied “${r.reply}” (${r.model})` } : { kind: 'err', text: `${site.id}: test failed — ${words(r.error)}` };
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
  const here = !sel.add && sel.id === site.id;
  const opened = treeOpen.has(site.id);
  return h('div', { class: 'tnode' },
    h('button', { type: 'button', class: 'tparent' + (here ? ' on' : ''), onclick: () => {
      if (here && opened) treeOpen.delete(site.id); else treeOpen.add(site.id);
      sel = { id: site.id, section: here ? sel.section : 'general', add: false };
      render();
    } },
      h('span', { class: 'caret' }, opened ? '▾' : '▸'),
      h('span', { class: 'dot tone-' + site.provider + (site.disabled ? ' off' : '') }),
      h('span', { class: 'tname' }, site.id),
      site.disabled ? h('span', { class: 'pill off' }, 'off') : null),
    opened ? h('div', { class: 'tkids' }, SECTIONS.map(([key, label]) => h('button', { type: 'button', class: 'tchild' + (here && sel.section === key ? ' on' : ''), onclick: () => { sel = { id: site.id, section: key, add: false }; render(); } },
      label, key === 'knowledge' && site.knowledge.length ? h('span', { class: 'count' }, site.knowledge.length) : key === 'tests' && (site.tests || []).length ? h('span', { class: 'count' }, site.tests.length) : null))) : null);
}

function cliRow(name, label, how, field, build) {
  const info = cli && cli[name];
  const input = h(field === 'claudeToken' ? 'input' : 'textarea', field === 'claudeToken'
    ? { type: 'password', autocomplete: 'off', placeholder: 'Paste token' } : { placeholder: 'Paste auth.json' });
  const status = !info ? h('span', { class: 'pill bad' }, 'unavailable')
    : !info.version ? h('span', { class: 'pill bad' }, 'not installed')
    : h('span', { class: 'pill ' + (info.loggedIn ? 'on' : 'off') }, `${info.version} · ${info.loggedIn ? 'logged in' : 'not logged in'}`);
  return h('div', { class: 'sub' },
    h('h3', null, label, status),
    h('div', { class: 'meta' }, how),
    h('div', { class: 'row' }, input),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => {
        if (!input.value.trim()) { notice = { kind: 'err', text: 'paste the login first' }; render(); return; }
        run(async () => { cli = await api('/cli', 'PUT', { [field]: input.value.trim() }); }, label + ' login saved');
      } }, 'Save login'),
      h('button', { type: 'button', onclick: () => run(async () => {
        const r = await api('/cli/' + name + '/test', 'POST');
        notice = r.ok ? { kind: 'ok', text: `${label}: replied “${r.reply}”` } : { kind: 'err', text: `${label}: test failed — ${words(r.error)}${r.detail ? ' — ' + r.detail : ''}` };
      }) }, 'Test'),
      field === 'claudeToken' && info && info.tokenSet ? h('button', { class: 'danger', type: 'button', onclick: () => run(async () => { cli = await api('/cli', 'PUT', { claudeToken: null }); }, 'Claude token removed') }, 'Remove') : null));
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
function tile(tone, n, label) { return h('div', { class: 'tile ' + tone }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label)); }

function tiles() {
  const total = state.sites.reduce((n, x) => n + x.stats.requests, 0);
  const errors = state.sites.reduce((n, x) => n + x.stats.errors, 0);
  const active = state.sites.filter((x) => !x.disabled).length;
  const keys = ['anthropic', 'openai'].filter((p) => state.keys[p].set).length;
  const login = (i) => !i || !i.version ? 'n/a' : i.loggedIn ? 'Logged in' : 'Not logged in';
  return h('div', { class: 'tiles' },
    tile('blue', `${active}/${state.sites.length}`, 'Assistants active'),
    tile('violet', total, 'Requests since start'),
    tile(errors ? 'red' : 'green', errors, 'Errors'),
    tile(cli && cli.claude.loggedIn ? 'green' : 'orange', login(cli && cli.claude), 'Claude CLI'),
    tile(cli && cli.codex.loggedIn ? 'green' : 'orange', login(cli && cli.codex), 'Codex CLI'),
    tile(keys ? 'teal' : 'orange', `${keys}/2`, 'API keys set'));
}

function sitesTab() {
  if (!sel.add && !state.sites.some((x) => x.id === sel.id)) {
    if (state.sites.length) { sel = { id: state.sites[0].id, section: 'general', add: false }; treeOpen.add(sel.id); }
    else sel = { id: null, section: 'general', add: true };
  }
  const site = state.sites.find((x) => x.id === sel.id);
  const tree = h('nav', { class: 'tree' },
    h('button', { type: 'button', class: 'tadd' + (sel.add ? ' on' : ''), onclick: () => { sel = { id: sel.id, section: sel.section, add: true }; render(); } }, '+ Add assistant'),
    ...state.sites.map(treeNode),
    state.sites.length ? null : h('div', { class: 'empty' }, 'No assistants yet.'));
  const panel = sel.add ? addPanel()
    : [h('h2', null, h('span', { class: 'grow' }, `${site.id} · ${(SECTIONS.find(([k]) => k === sel.section) || [0, ''])[1]}`),
        h('span', { class: 'pill ' + (site.disabled ? 'off' : 'on') }, site.disabled ? 'disabled' : 'active'),
        h('span', { class: 'pill tone-' + site.provider }, providerLabel(site.provider))),
      ...(sel.section === 'knowledge' ? knowledgePanel(site) : sel.section === 'tests' ? testsPanel(site) : sel.section === 'leads' ? leadsPanel(site) : sel.section === 'access' ? accessPanel(site) : generalPanel(site))];
  return [h('div', { class: 'split' }, tree, h('section', { class: 'card panel' }, ...(sel.add ? [h('h2', null, 'Add assistant'), ...panel] : panel)))];
}

const openSections = new Set();   // collapsible cards the user has expanded (collapsed by default)

function collapsible(id, title, summary, ...children) {
  const d = h('details', { class: 'card fold', open: openSections.has(id) || null },
    h('summary', null, h('span', { class: 'grow' }, title), summary), ...children);
  d.addEventListener('toggle', () => { d.open ? openSections.add(id) : openSections.delete(id); });
  return d;
}

function loginsTab() {
  const state2 = (i) => !i || !i.version ? 'bad' : i.loggedIn ? 'on' : 'off';
  const keyPill = (p) => h('span', { class: 'pill ' + (state.keys[p].set ? 'on' : 'off') }, p + (state.keys[p].set ? ' ✓' : ' –'));
  return [
    collapsible('cli', 'Subscription logins (CLI)',
      h('span', { class: 'sum' }, h('span', { class: 'pill ' + state2(cli && cli.claude) }, 'Claude'), h('span', { class: 'pill ' + state2(cli && cli.codex) }, 'Codex')),
      h('div', { class: 'grid2' },
        cliRow('claude', 'Claude', 'On your Mac run: claude setup-token', 'claudeToken'),
        cliRow('codex', 'ChatGPT (Codex)', 'On your Mac run: codex login, then paste ~/.codex/auth.json', 'codexAuth'))),
    collapsible('keys', 'AI provider keys',
      h('span', { class: 'sum' }, keyPill('anthropic'), keyPill('openai')),
      h('div', { class: 'grid2' }, keyRow('anthropic', 'Anthropic'), keyRow('openai', 'OpenAI')))
  ];
}

function accountTab() {
  return [h('section', { class: 'card' }, h('h2', null, 'Admin password'), passwordForm())];
}

function render() {
  const body = { sites: sitesTab, logins: loginsTab, account: accountTab }[tab]();
  app.replaceChildren(...[
    h('header', { class: 'topbar' },
      h('h1', null, 'AJMCP Admin'), h('span', { class: 'who' }, `v${state.version} · ${state.user}`),
      h('button', { type: 'button', onclick: async () => { try { await api('/logout', 'POST'); } catch { /* already out */ } state = null; renderLogin(); } }, 'Sign out')),
    tiles(),
    notice ? h('div', { class: 'notice ' + notice.kind }, notice.text, notice.secret ? h('div', { class: 'secret' }, notice.secret) : null, notice.secret ? copyButton(notice.secret) : null) : null,
    !state.storage ? h('div', { class: 'notice err' }, 'No persistent storage: changes cannot be saved.') : null,
    h('nav', { class: 'tabs' }, TABS.map(([key, label]) => h('button', { type: 'button', class: key === tab ? 'on' : '', onclick: () => { tab = key; history.replaceState(null, '', '#' + key); render(); } }, label))),
    ...body
  ].filter(Boolean));
}

(async () => {
  try { await refresh(); render(); } catch { renderLogin(); }
})();
