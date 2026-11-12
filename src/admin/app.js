'use strict';
const app = document.getElementById('app');
let state = null;
let cli = null;             // installed CLI versions + login state
const PROVIDERS = [['anthropic', 'Anthropic API'], ['openai', 'OpenAI API'], ['claude-cli', 'Claude subscription (CLI)'], ['codex-cli', 'ChatGPT subscription (Codex CLI)']];
const isCli = (p) => p.endsWith('-cli');
const TABS = [['sites', 'Sites'], ['logins', 'Logins & keys'], ['account', 'Account']];
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
const SECTIONS = [['general', 'AI Behavior'], ['knowledge', 'Knowledge'], ['leads', 'Leads'], ['access', 'Access']];
const leadData = {};   // site id -> last loaded lead list (kept while switching sections)
const CATEGORY = { cost_conscious: 'Cost-conscious', white_glove: 'White-glove' };
const human = (v) => String(v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };

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
  return [
    h('div', { class: 'row' }, field('Provider', provider), field('Model', model), list),
    h('div', null, h('label', null, 'Instructions (system prompt)'), prompt),
    h('div', { class: 'actions mt' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { provider: provider.value, model: model.value, systemPrompt: prompt.value }).then(refresh), 'Saved ' + site.id) }, 'Save'))
  ];
}

function knowledgePanel(site) {
  const strict = h('input', { type: 'checkbox', checked: site.strict || null });
  const fallback = h('input', { value: site.fallback, placeholder: 'Reply when the answer is not in the knowledge' });
  const title = h('input', { placeholder: 'Title (e.g. Pricing, FAQ, Services)' });
  const text = h('textarea', { placeholder: 'Paste text here, or choose a .txt / .md / .csv / .json file', rows: 6 });
  const file = h('input', { type: 'file', accept: '.txt,.md,.markdown,.csv,.json,.html,.htm,text/*' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 1_000_000) { notice = { kind: 'err', text: 'file too large (1 MB max)' }; render(); return; }
    text.value = await f.text();
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, '');
  });
  const question = h('input', { placeholder: 'Try a visitor question' });
  const docs = site.knowledge.length
    ? site.knowledge.map((d) => h('div', { class: 'doc' },
        h('span', { class: 'grow' }, d.title), h('span', { class: 'meta' }, kb(d.chars)),
        h('button', { class: 'danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove "${d.title}"?`)) return;
          await run(() => api('/sites/' + site.id + '/knowledge/' + d.id, 'DELETE').then(refresh), 'Removed ' + d.title);
        } }, 'Remove')))
    : [h('div', { class: 'empty' }, 'No documents yet.')];
  return [
    h('h3', null, 'Documents ', h('span', { class: 'pill' }, `${site.knowledge.length} docs · ${kb(site.knowledgeChars)}`)),
    ...docs,
    h('div', { class: 'row mt' }, field('Title', title), field('File', file)),
    h('div', null, text),
    h('div', { class: 'actions mt' },
      h('button', { type: 'button', onclick: () => {
        if (!title.value.trim() || !text.value.trim()) { notice = { kind: 'err', text: 'title and text are required' }; render(); return; }
        run(() => api('/sites/' + site.id + '/knowledge', 'POST', { title: title.value, text: text.value }).then(refresh), 'Added ' + title.value.trim());
      } }, 'Add document')),
    h('h3', { class: 'mt' }, 'Behavior'),
    h('label', { class: 'check' }, strict, ' Answer only from this knowledge'),
    h('div', { class: 'row' }, field('Fallback reply', fallback)),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { strict: strict.checked, fallback: fallback.value }).then(refresh), 'Saved ' + site.id) }, 'Save')),
    h('h3', { class: 'mt' }, 'Try it'),
    h('div', { class: 'actions' }, question,
      h('button', { type: 'button', onclick: () => run(async () => {
        if (!question.value.trim()) return;
        const r = await api('/sites/' + site.id + '/test', 'POST', { question: question.value });
        notice = r.ok ? { kind: 'ok', text: `${site.id} answered: ${r.reply}` } : { kind: 'err', text: `${site.id}: ${words(r.error)}` };
        await refresh();
      }) }, 'Ask'))
  ];
}

const loadingLeads = new Set();
async function loadLeads(site) {
  if (loadingLeads.has(site.id)) return;
  loadingLeads.add(site.id);
  try { leadData[site.id] = await api('/sites/' + site.id + '/leads'); }
  catch (e) { if (e.message !== 'signed out') leadData[site.id] = { error: e.message }; }
  finally { loadingLeads.delete(site.id); }
  if (state && !sel.add && sel.id === site.id && sel.section === 'leads') render();
}

function leadCard(l) {
  if (l.unavailable) return h('div', { class: 'lead' }, h('strong', null, 'Lead #' + l.id), h('span', { class: 'meta' }, 'could not be read from AJCore'));
  return h('div', { class: 'lead' },
    h('div', { class: 'lead-head' },
      h('strong', null, l.name || '(no name)'), l.company ? h('span', { class: 'meta' }, l.company) : null,
      h('span', { class: 'grow' }),
      h('span', { class: 'pill' }, human(l.leadStatus || 'new')),
      l.category ? h('span', { class: 'pill tone-' + (l.category === 'white_glove' ? 'claude-cli' : 'openai') }, CATEGORY[l.category] || human(l.category)) : null,
      l.customerType ? h('span', { class: 'pill' }, human(l.customerType)) : null,
      h('span', { class: 'pill ' + (l.consent ? 'on' : 'bad') }, l.consent ? 'consent' : 'no consent')),
    h('div', { class: 'lead-contact' }, [l.email, l.phone, l.contactMethod ? `prefers ${l.contactMethod}` : ''].filter(Boolean).join('  ·  ')),
    l.services.length ? h('div', { class: 'meta' }, 'Interested in: ' + l.services.map(human).join(', ') + (l.entityStatus ? ' · ' + human(l.entityStatus) : '')) : null,
    l.summary ? h('div', { class: 'lead-summary' }, l.summary) : null,
    h('div', { class: 'lead-foot' },
      h('span', { class: 'meta' }, `${when(l.createdAt)}${l.followUpAt ? ' · follow-up ' + when(l.followUpAt) : ''}${l.noteCount ? ' · ' + l.noteCount + ' notes' : ''} · lead #${l.id}`),
      l.link ? h('a', { class: 'button-link', href: l.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open in AJCore ↗') : null));
}

function leadsPanel(site) {
  const connected = state.ajcore && state.ajcore.configured;
  const capture = h('input', { type: 'checkbox', checked: site.leadCapture || null });
  const uuid = h('input', { value: site.ajcoreSiteUuid, placeholder: 'Optional: AJCore site id (blank = the one the website sends)' });
  const instructions = h('textarea', { rows: 5, placeholder: 'How to qualify visitors for this website (who to ask what, which services, when to offer a follow-up)…' });
  instructions.value = site.leadInstructions;
  const data = leadData[site.id];
  if (!data) loadLeads(site);
  const counts = data && data.counts;
  const list = !data ? [h('div', { class: 'empty' }, 'Loading…')]
    : data.error ? [h('div', { class: 'notice err' }, words(data.error))]
    : [
        data.loadError ? h('div', { class: 'notice err' }, 'AJCore could not be read: ' + words(data.loadError)) : null,
        ...(data.leads.length ? data.leads.map(leadCard) : [h('div', { class: 'empty' }, connected ? 'No leads captured yet.' : 'Connect AJCore (Logins & keys) to capture and view leads.')])
      ];
  const failures = data && data.events ? data.events.filter((e) => e.status === 'failed').slice(0, 8) : [];
  return [
    h('div', { class: 'facts' },
      h('div', null, h('label', null, 'AJCore lead integration'), h('span', { class: 'pill ' + (connected ? 'on' : 'off') }, connected ? 'Connected' : 'Needs setup')),
      h('div', null, h('label', null, 'Capture'), h('span', { class: 'pill ' + (site.leadCapture ? 'on' : 'off') }, site.leadCapture ? 'On' : 'Off'))),
    h('label', { class: 'check mt' }, capture, ' Capture leads from this chat (the AI asks permission first)'),
    h('div', { class: 'row mt' }, field('AJCore site', uuid)),
    h('div', null, h('label', null, 'Qualification instructions'), instructions),
    h('div', { class: 'actions mt' },
      h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { leadCapture: capture.checked, ajcoreSiteUuid: uuid.value, leadInstructions: instructions.value }).then(refresh), 'Saved ' + site.id) }, 'Save'),
      h('button', { type: 'button', onclick: () => { delete leadData[site.id]; render(); } }, 'Refresh')),
    counts ? h('div', { class: 'tiles mt' },
      tile('green', counts.created, `New leads (${counts.days}d)`), tile('blue', counts.updated, 'Updated'), tile(counts.failed ? 'red' : 'green', counts.failed, 'Failed saves')) : null,
    h('h3', { class: 'mt' }, 'Captured leads'),
    ...list,
    failures.length ? h('h3', { class: 'mt' }, 'Failed saves') : null,
    ...failures.map((e) => h('div', { class: 'doc' }, h('span', { class: 'grow' }, human(words(e.error))), h('span', { class: 'meta' }, `chat ${e.conversationId || '—'} · ${when(e.time)}`)))
  ];
}

function accessPanel(site) {
  const s = site.stats;
  return [
    h('div', { class: 'facts' },
      h('div', null, h('label', null, 'Server URL'), h('code', null, location.origin)),
      h('div', null, h('label', null, 'Site id'), h('code', null, site.id)),
      h('div', null, h('label', null, 'Token'), h('code', null, '…' + (site.tokenHint || '????'))),
      h('div', null, h('label', null, 'AJCore lead integration'), h('span', { class: 'pill ' + (state.ajcore && state.ajcore.configured ? 'on' : 'off') }, state.ajcore && state.ajcore.configured ? 'Connected' : 'Needs setup')),
      h('div', null, h('label', null, 'Since last restart'), h('span', null, s.requests ? `${s.requests} requests · ${s.errors} errors` + (s.lastErrorCode ? ` · last: ${s.lastErrorCode}` : '') : 'no requests yet'))),
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
        if (!confirm(`Delete site ${site.id}? Its token stops working immediately.`)) return;
        sel = { id: null, section: 'general', add: false };
        await run(() => api('/sites/' + site.id, 'DELETE').then(refresh), 'Deleted ' + site.id);
      } }, 'Delete'))
  ];
}

function addPanel() {
  const id = h('input', { placeholder: 'site-id', pattern: '[a-z0-9][a-z0-9_\\-]{1,63}', required: true });
  const { provider, model, list } = modelPicker(null);
  const prompt = h('textarea', { placeholder: 'Instructions (optional, can be added later)', rows: 5 });
  return [h('form', { onsubmit: (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/sites', 'POST', { id: id.value.trim(), provider: provider.value, model: model.value.trim(), systemPrompt: prompt.value });
      sel = { id: r.site.id, section: 'access', add: false };
      treeOpen.add(r.site.id);
      notice = { kind: 'ok', text: `Site ${r.site.id} created. Token (shown once):`, secret: r.token };
      await refresh();
    });
  } },
    h('div', { class: 'row' }, field('Site id', id), field('Provider', provider), field('Model', model), list),
    h('div', null, prompt),
    h('div', { class: 'actions mt' }, h('button', { class: 'primary', type: 'submit', disabled: !state.storage || null }, 'Create site')))];
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
      label, key === 'knowledge' && site.knowledge.length ? h('span', { class: 'count' }, site.knowledge.length) : null))) : null);
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
    tile('blue', `${active}/${state.sites.length}`, 'Sites active'),
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
    h('button', { type: 'button', class: 'tadd' + (sel.add ? ' on' : ''), onclick: () => { sel = { id: sel.id, section: sel.section, add: true }; render(); } }, '+ Add site'),
    ...state.sites.map(treeNode),
    state.sites.length ? null : h('div', { class: 'empty' }, 'No sites yet.'));
  const panel = sel.add ? addPanel()
    : [h('h2', null, h('span', { class: 'grow' }, `${site.id} · ${(SECTIONS.find(([k]) => k === sel.section) || [0, ''])[1]}`),
        h('span', { class: 'pill ' + (site.disabled ? 'off' : 'on') }, site.disabled ? 'disabled' : 'active'),
        h('span', { class: 'pill tone-' + site.provider }, providerLabel(site.provider))),
      ...(sel.section === 'knowledge' ? knowledgePanel(site) : sel.section === 'leads' ? leadsPanel(site) : sel.section === 'access' ? accessPanel(site) : generalPanel(site))];
  return [h('div', { class: 'split' }, tree, h('section', { class: 'card panel' }, ...(sel.add ? [h('h2', null, 'Add site'), ...panel] : panel)))];
}

const openSections = new Set();   // collapsible cards the user has expanded (collapsed by default)

function collapsible(id, title, summary, ...children) {
  const d = h('details', { class: 'card fold', open: openSections.has(id) || null },
    h('summary', null, h('span', { class: 'grow' }, title), summary), ...children);
  d.addEventListener('toggle', () => { d.open ? openSections.add(id) : openSections.delete(id); });
  return d;
}

function ajcoreCard() {
  const a = state.ajcore || {};
  const url = h('input', { value: a.url, placeholder: 'https://ncllcagents.com' });
  const user = h('input', { value: a.username, placeholder: 'Service account user', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: a.passwordSet ? 'Saved (leave blank to keep)' : 'Password', autocomplete: 'new-password' });
  return collapsible('ajcore', 'AJCore (lead capture)',
    h('span', { class: 'sum' }, h('span', { class: 'pill ' + (a.configured ? 'on' : 'off') }, a.configured ? 'Connected' : 'Needs setup')),
    h('div', { class: 'sub' },
      h('div', { class: 'meta' }, 'A staff account with Leads edit access (role aj_ops_user). The password stays on this server.'),
      h('div', { class: 'row mt' }, field('AJCore site URL', url), field('Username', user), field('Password', pass)),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', type: 'button', onclick: () => run(async () => { await api('/ajcore', 'PUT', { url: url.value, username: user.value, password: pass.value }); await refresh(); }, 'AJCore saved') }, 'Save'),
        h('button', { type: 'button', onclick: () => run(async () => {
          const r = await api('/ajcore/test', 'POST');
          notice = r.ok ? { kind: 'ok', text: `AJCore: signed in as ${r.user || 'service account'}` } : { kind: 'err', text: 'AJCore: ' + words(r.error) };
        }) }, 'Test'),
        a.url ? h('button', { class: 'danger', type: 'button', onclick: async () => {
          if (!confirm('Remove the AJCore connection? Lead capture stops working until you add it again.')) return;
          await run(async () => { await api('/ajcore', 'PUT', { clear: true }); await refresh(); }, 'AJCore removed');
        } }, 'Remove') : null)));
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
    ajcoreCard(),
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
