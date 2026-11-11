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
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/login', 'POST', { username: user.value, password: pass.value }); await refresh(); notice = null; render(); }
    catch (err) { renderLogin(err.message); }
  } },
    h('h2', null, 'AJMCP Admin'),
    message ? h('div', { class: 'notice err' }, message) : null,
    h('div', { class: 'row' }, field('User', user)),
    h('div', { class: 'row' }, field('Password', pass)),
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  app.replaceChildren(h('section', { class: 'card login' }, form));
}

/* ---------- sites ---------- */
async function loadModels(provider, datalist) {
  if (isCli(provider) || !state.keys[provider].set) { datalist.replaceChildren(); return; }
  if (!models[provider]) {
    try { models[provider] = (await api('/models?provider=' + provider)).models; } catch { models[provider] = []; }
  }
  datalist.replaceChildren(...models[provider].map((m) => h('option', { value: m })));
}

function siteCard(site) {
  const provider = h('select', null, ...PROVIDERS.map(([p, label]) => h('option', { value: p, selected: p === site.provider }, label)));
  const list = h('datalist', { id: 'models-' + site.id });
  const model = h('input', { value: site.model, list: 'models-' + site.id, placeholder: isCli(site.provider) ? 'model id (optional)' : 'model id' });
  const prompt = h('textarea', null, site.systemPrompt);
  prompt.value = site.systemPrompt;
  const refreshList = () => loadModels(provider.value, list);
  provider.addEventListener('change', refreshList);
  model.addEventListener('focus', refreshList, { once: true });

  const s = site.stats;
  const details = h('details', { class: 'site ' + site.provider + (site.disabled ? ' off' : ''), open: open.has(site.id) || null },
    h('summary', null,
      h('span', { class: 'name' }, site.id),
      h('span', { class: 'pill ' + (site.disabled ? 'off' : 'on') }, site.disabled ? 'disabled' : 'active'),
      h('span', { class: 'pill tone-' + site.provider }, (PROVIDERS.find(([p]) => p === site.provider) || [0, site.provider])[1]),
      h('span', { class: 'meta' }, `${site.model || (isCli(site.provider) ? 'CLI default' : 'no model')} · token …${site.tokenHint || '????'}`),
      h('span', { class: 'meta' }, s.requests ? `${s.requests} req · ${s.errors} err` + (s.lastErrorCode ? ` · last: ${s.lastErrorCode}` : '') : 'no requests yet')),
    h('div', { class: 'body' },
      h('div', { class: 'row' }, field('Provider', provider), field('Model', model), list),
      h('div', null, h('label', null, 'System prompt'), prompt),
      h('div', { class: 'actions mt' },
        h('button', { class: 'primary', type: 'button', onclick: () => run(() => api('/sites/' + site.id, 'PUT', { provider: provider.value, model: model.value, systemPrompt: prompt.value }).then(refresh), 'Saved ' + site.id) }, 'Save'),
        h('button', { type: 'button', onclick: () => run(async () => {
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
          open.delete(site.id);
          await run(() => api('/sites/' + site.id, 'DELETE').then(refresh), 'Deleted ' + site.id);
        } }, 'Delete'))));
  details.addEventListener('toggle', () => { details.open ? open.add(site.id) : open.delete(site.id); });
  return details;
}

function addSiteForm() {
  const id = h('input', { placeholder: 'site-id', pattern: '[a-z0-9][a-z0-9_\\-]{1,63}', required: true });
  const provider = h('select', null, ...PROVIDERS.map(([p, label]) => h('option', { value: p }, label)));
  const list = h('datalist', { id: 'models-new' });
  const model = h('input', { placeholder: 'model id', list: 'models-new' });
  const refreshList = () => loadModels(provider.value, list);
  provider.addEventListener('change', refreshList);
  model.addEventListener('focus', refreshList);
  const prompt = h('textarea', { placeholder: 'System prompt (optional)' });
  return h('form', { onsubmit: (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/sites', 'POST', { id: id.value.trim(), provider: provider.value, model: model.value.trim(), systemPrompt: prompt.value });
      open.add(r.site.id);
      notice = { kind: 'ok', text: `Site ${r.site.id} created. Token (shown once):`, secret: r.token };
      await refresh();
    });
  } },
    h('div', { class: 'row' }, field('Site id', id), field('Provider', provider), field('Model', model), list),
    h('div', null, prompt),
    h('div', { class: 'actions mt' }, h('button', { class: 'primary', type: 'submit', disabled: !state.storage || null }, 'Add site')));
}

/* ---------- subscription CLIs ---------- */
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
  const add = h('details', { class: 'add' }, h('summary', null, '+ Add site'), h('div', null, addSiteForm()));
  return [
    h('section', { class: 'card' }, h('h2', null, h('span', { class: 'grow' }, 'Sites'), h('span', { class: 'pill' }, location.origin)),
      state.sites.length ? state.sites.map(siteCard) : h('div', { class: 'empty' }, 'No sites yet.'),
      add)
  ];
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
