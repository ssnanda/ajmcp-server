import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tokenHash } from './auth.js';
import { LIMITS } from './knowledge.js';
import { MASTER_PROVIDERS, emptyMaster } from './master.js';
import { siteToPackage } from './package.js';

export class StoreError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'StoreError'; this.code = code; this.status = status; }
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const KEY_PROVIDERS = ['openai', 'anthropic'];
export const PROVIDERS = [...KEY_PROVIDERS, 'ollama', 'claude-cli', 'codex-cli', 'antigravity-cli', 'copilot-cli'];

// Saved test texts (question + what we expect), used by the admin "Tests" tab. Small on purpose: admin request bodies are capped.
function cleanTests(raw) {
  if (!Array.isArray(raw)) throw new StoreError('invalid_tests');
  if (raw.length > 30) throw new StoreError('too_many_tests');
  return raw.map((t, i) => ({ id: String(i + 1), question: String(t?.question ?? '').trim().slice(0, 300), expected: String(t?.expected ?? '').trim().slice(0, 500) })).filter((t) => t.question);
}

function cleanSite(input, existing = {}) {
  const provider = input.provider ?? existing.provider ?? 'openai';
  const model = String(input.model ?? existing.model ?? '').trim();
  const systemPrompt = String(input.systemPrompt ?? existing.systemPrompt ?? '');
  if (!PROVIDERS.includes(provider)) throw new StoreError('invalid_provider');
  if (model && !MODEL_RE.test(model)) throw new StoreError('invalid_model');
  if (systemPrompt.length > 12000) throw new StoreError('system_prompt_too_long');
  const fallback = String(input.fallback ?? existing.fallback ?? '').trim();
  if (fallback.length > 500) throw new StoreError('fallback_too_long');
  const leadInstructions = String(input.leadInstructions ?? existing.leadInstructions ?? '');
  if (leadInstructions.length > 4000) throw new StoreError('lead_instructions_too_long');
  const routeLabel = String(input.routeLabel ?? existing.routeLabel ?? '').replace(/\s+/g, ' ').trim();
  if (routeLabel.length > 200) throw new StoreError('route_label_too_long');
  const rawTargets = input.transferTargets ?? existing.transferTargets ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length > 10) throw new StoreError('invalid_transfer_targets');
  const transferTargets = [...new Set(rawTargets.map((t) => String(t).trim()))];
  if (!transferTargets.every((t) => ID_RE.test(t))) throw new StoreError('invalid_transfer_targets');
  const tests = cleanTests(input.tests ?? existing.tests ?? []);
  return { provider, model, systemPrompt, tests, leadCapture: Boolean(input.leadCapture ?? existing.leadCapture), leadInstructions, disabled: Boolean(input.disabled ?? existing.disabled), strict: Boolean(input.strict ?? existing.strict ?? true), fallback, routeLabel, transferTargets };
}

// Assistant-management connection tokens (for /assistants/mcp). Short-lived on purpose: 15 minutes by default,
// 30 at most. Stored as hashes; the token is shown once. Expired tokens are dropped on the next read/write.
export const CONNECTION_SCOPES = ['read', 'write'];
export const CONNECTION_MINUTES = [15, 30];
const live = (c) => c.expiresAt && Date.parse(c.expiresAt) > Date.now();
function cleanConnections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((c) => ({
    id: String(c.id), label: String(c.label || '').slice(0, 40), scope: c.scope === 'write' ? 'write' : 'read',
    tokenHash: String(c.tokenHash || ''), tokenHint: String(c.tokenHint || ''), createdAt: c.createdAt || null,
    expiresAt: c.expiresAt || null, lastUsedAt: c.lastUsedAt || null
  })).filter((c) => c.id && /^[0-9a-f]{64}$/.test(c.tokenHash) && live(c));
}

// GitHub sync settings (see github-sync.js). The token and webhook secret stay in settings.json (mode 600).
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
function cleanGithub(raw = {}) {
  return {
    repo: REPO_RE.test(String(raw.repo || '')) ? String(raw.repo) : '',
    branch: BRANCH_RE.test(String(raw.branch || '')) ? String(raw.branch) : 'main',
    token: String(raw.token || ''),
    webhookSecret: /^[0-9a-f]{32,128}$/.test(String(raw.webhookSecret || '')) ? String(raw.webhookSecret) : '',
    pushOnSave: raw.pushOnSave !== false,
    pullOnWebhook: raw.pullOnWebhook !== false,
    syncChats: Boolean(raw.syncChats)
  };
}

// The master switch as stored: '' (off) or one of claude | codex | antigravity, with an optional model per provider.
function cleanMaster(input) {
  const provider = String(input?.provider ?? '').trim().toLowerCase();
  if (provider && !MASTER_PROVIDERS.includes(provider)) throw new StoreError('invalid_master_provider');
  const models = emptyMaster().models;
  for (const p of MASTER_PROVIDERS) {
    const m = String(input?.models?.[p] ?? '').trim();
    if (m && !MODEL_RE.test(m)) throw new StoreError('invalid_model');
    models[p] = m;
  }
  return { provider, models };
}

// Per-model / per-provider call time limits in seconds. Key = model id (e.g. qwen3:14b) or provider (ollama, claude-cli ...).
export const TIMEOUT_MIN = 5;
export const TIMEOUT_MAX = 600;
function cleanTimeouts(raw) {
  const out = {};
  if (raw == null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 40) throw new StoreError('invalid_timeouts');
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    const sec = Number(v);
    if (!MODEL_RE.test(key) || !Number.isInteger(sec) || sec < TIMEOUT_MIN || sec > TIMEOUT_MAX) throw new StoreError('invalid_timeouts');
    out[key] = sec;
  }
  return out;
}

// Normalizes a runtime site (seed file token or stored hash) to the persisted shape. Never keeps a plain token.
function toStored(site) {
  return {
    id: site.id,
    tokenHash: site.tokenHash || tokenHash(site.token),
    tokenHint: site.tokenHint || String(site.token || '').slice(-4),
    provider: site.provider || 'openai',
    model: site.model || '',
    systemPrompt: site.systemPrompt || '',
    disabled: Boolean(site.disabled),
    strict: site.strict !== false,
    fallback: site.fallback || '',
    leadCapture: Boolean(site.leadCapture),
    // Routing: a short description other assistants see, and which assistants this one may pass a customer to.
    routeLabel: site.routeLabel || '',
    transferTargets: Array.isArray(site.transferTargets) ? site.transferTargets.map(String) : [],
    tests: Array.isArray(site.tests) ? site.tests.map((t) => ({ id: String(t.id), question: String(t.question), expected: String(t.expected || '') })) : [],
    // Extra named access tokens (for example one for AJOps), alongside the primary token above.
    tokens: Array.isArray(site.tokens) ? site.tokens.map((t) => ({ id: String(t.id), label: String(t.label), tokenHash: String(t.tokenHash), tokenHint: String(t.tokenHint || ''), createdAt: t.createdAt || null })) : [],
    leadInstructions: site.leadInstructions || '',
    knowledge: Array.isArray(site.knowledge) ? site.knowledge.map((d) => ({ id: String(d.id), title: String(d.title), text: String(d.text), source: d.source === 'website' ? 'website' : 'manual', ref: d.ref ? String(d.ref) : '', updatedAt: d.updatedAt || null })) : [],
    createdAt: site.createdAt || new Date().toISOString()
  };
}

/**
 * Settings edited in the admin UI, kept in DATA_DIR/settings.json (mode 600, atomic writes).
 * Applied onto the live config object in place, so changes take effect without a restart.
 * Until something is saved, the seed sites file and environment keys stay in force.
 */
export class SettingsStore {
  constructor(config) {
    this.config = config;
    this.file = config.dataDir ? join(config.dataDir, 'settings.json') : '';
    this.env = { openai: config.openaiApiKey, anthropic: config.anthropicApiKey, claude: config.claudeOauthToken, copilot: config.copilotToken, passwordHash: config.adminPasswordHash };
    this.envMaster = { provider: config.master ? config.master.provider : '', models: { ...emptyMaster().models, ...(config.master ? config.master.models : {}) } };
    this.state = { sites: undefined, keys: {}, passwordHash: '', passwordBase: '', master: undefined, timeouts: {}, connections: [], github: cleanGithub() };
    this.onSitesChanged = null;   // (ids, reason) => void; set by the GitHub sync
  }

  get enabled() { return Boolean(this.file); }

  load() {
    if (!this.file) return;
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const data = JSON.parse(raw);
    this.state = {
      sites: Array.isArray(data.sites) ? data.sites.map(toStored) : undefined,
      keys: { openai: String(data.keys?.openai || ''), anthropic: String(data.keys?.anthropic || ''), claude: String(data.keys?.claude || ''), copilot: String(data.keys?.copilot || '') },
      passwordHash: String(data.passwordHash || ''),
      passwordBase: String(data.passwordBase || ''),
      master: data.master && typeof data.master === 'object' ? cleanMaster(data.master) : undefined,
      timeouts: cleanTimeouts(data.timeouts),
      connections: cleanConnections(data.connections),
      github: cleanGithub(data.github)
    };
    this.apply();
  }

  apply() {
    const { config, state, env } = this;
    if (state.sites) config.sites = state.sites;
    config.openaiApiKey = state.keys.openai || env.openai;
    config.anthropicApiKey = state.keys.anthropic || env.anthropic;
    config.claudeOauthToken = state.keys.claude || env.claude;
    config.copilotToken = state.keys.copilot || env.copilot;
    config.timeouts = state.timeouts || {};
    config.master = state.master || this.envMaster; // the saved switch wins; otherwise the deploy's AI_MASTER_PROVIDER
    // A password changed in the UI wins, unless the deploy script later issued a new one (--reset-admin).
    config.adminPasswordHash = state.passwordHash && state.passwordBase === env.passwordHash ? state.passwordHash : env.passwordHash;
  }

  write(next) {
    if (!this.file) throw new StoreError('storage_unavailable', 503);
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sites: next.sites, keys: next.keys, passwordHash: next.passwordHash, passwordBase: next.passwordBase, master: next.master, timeouts: next.timeouts, connections: next.connections || [], github: next.github || cleanGithub() }, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('storage_unavailable', 503);
    }
    const before = this.state.sites || this.config.sites;
    this.state = next;
    this.apply();
    this.notifySitesChanged(before, next.sites);
  }

  /** Tells the GitHub sync which assistants' package files changed (or appeared) with this write. */
  notifySitesChanged(before, after) {
    if (!this.onSitesChanged || !Array.isArray(after)) return;
    const old = new Map((before || []).map((s) => [s.id, JSON.stringify(siteToPackage(toStored(s)))]));
    const ids = after.filter((s) => old.get(s.id) !== JSON.stringify(siteToPackage(s))).map((s) => s.id);
    if (ids.length) { try { this.onSitesChanged(ids, this.writeReason || 'save'); } catch { /* sync is best effort */ } }
  }

  sites() { return (this.state.sites || this.config.sites).map(toStored); }

  keyInfo(provider) {
    const stored = this.state.keys[provider];
    const value = stored || this.env[provider] || '';
    return { set: Boolean(value), hint: value ? value.slice(-4) : '', source: stored ? 'admin' : value ? 'environment' : 'none' };
  }

  addSite(input) {
    const id = String(input.id || '').trim();
    if (!ID_RE.test(id)) throw new StoreError('invalid_site_id');
    const sites = this.sites();
    if (sites.some((s) => s.id === id)) throw new StoreError('site_exists', 409);
    const token = randomBytes(32).toString('hex');
    // Defaults for a new assistant: lead capture on, and it can transfer to every other assistant (and they to it).
    const others = sites.map((s) => s.id);
    const site = toStored({ id, token, ...cleanSite({ ...input, leadCapture: input.leadCapture ?? true, transferTargets: input.transferTargets ?? others.slice(0, 10) }) });
    const updated = sites.map((s) => (input.transferTargets === undefined && !s.transferTargets.includes(id) && s.transferTargets.length < 10 ? { ...s, transferTargets: [...s.transferTargets, id] } : s));
    this.write({ ...this.state, sites: [...updated, site] });
    return { site, token };
  }

  updateSite(id, input) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const cleaned = cleanSite(input, sites[index]);
    cleaned.transferTargets = cleaned.transferTargets.filter((t) => t !== id);   // never to itself
    sites[index] = { ...sites[index], ...cleaned };
    this.write({ ...this.state, sites });
    return sites[index];
  }

  addDoc(id, input) {
    const title = String(input.title || '').trim().slice(0, 120);
    const text = String(input.text || '').replace(/\r\n/g, '\n').trim();
    if (!title) throw new StoreError('title_required');
    if (!text) throw new StoreError('text_required');
    if (text.length > LIMITS.docChars) throw new StoreError('document_too_large', 413);
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const docs = sites[index].knowledge;
    if (docs.length >= LIMITS.docs) throw new StoreError('too_many_documents');
    if (docs.reduce((n, d) => n + d.text.length, 0) + text.length > LIMITS.totalChars) throw new StoreError('knowledge_full', 413);
    const doc = { id: randomBytes(6).toString('hex'), title, text, source: 'manual', ref: '', updatedAt: new Date().toISOString() };
    sites[index] = { ...sites[index], knowledge: [...docs, doc] };
    this.write({ ...this.state, sites });
    return doc;
  }

  getDoc(id, docId) {
    const site = this.sites().find((x) => x.id === id);
    if (!site) throw new StoreError('site_not_found', 404);
    const doc = site.knowledge.find((d) => d.id === docId);
    if (!doc) throw new StoreError('document_not_found', 404);
    return doc;
  }

  /** Edit a document's title and/or text in place. */
  updateDoc(id, docId, input) {
    const sites = this.sites();
    const index = sites.findIndex((x) => x.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const docs = sites[index].knowledge;
    const at = docs.findIndex((d) => d.id === docId);
    if (at < 0) throw new StoreError('document_not_found', 404);
    const title = String(input.title ?? docs[at].title).trim().slice(0, 120);
    const text = String(input.text ?? docs[at].text).replace(/\r\n/g, '\n').trim();
    if (!title) throw new StoreError('title_required');
    if (!text) throw new StoreError('text_required');
    if (text.length > LIMITS.docChars) throw new StoreError('document_too_large', 413);
    const others = docs.reduce((n, d, i) => n + (i === at ? 0 : d.text.length), 0);
    if (others + text.length > LIMITS.totalChars) throw new StoreError('knowledge_full', 413);
    docs[at] = { ...docs[at], title, text, updatedAt: new Date().toISOString() };
    sites[index] = { ...sites[index], knowledge: docs };
    this.write({ ...this.state, sites });
    return docs[at];
  }

  /**
   * Replace every document of one source (the website's own pages) with a fresh set, in a single write.
   * Documents are matched by ref so ids stay stable; anything not in `docs` is removed. Manual documents are untouched.
   */
  syncDocs(id, source, docs) {
    if (source !== 'website') throw new StoreError('invalid_source');
    const sites = this.sites();
    const index = sites.findIndex((x) => x.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const keep = sites[index].knowledge.filter((d) => d.source !== source);
    const previous = new Map(sites[index].knowledge.filter((d) => d.source === source).map((d) => [d.ref, d]));
    const seen = new Set();
    const next = [];
    for (const input of docs) {
      const ref = String(input.ref || '').slice(0, 80);
      const title = String(input.title || '').trim().slice(0, 120);
      const text = String(input.text || '').replace(/\r\n/g, '\n').trim().slice(0, LIMITS.siteDocChars);
      if (!ref || !title || !text || seen.has(ref)) continue;
      seen.add(ref);
      const old = previous.get(ref);
      next.push({ id: old ? old.id : randomBytes(6).toString('hex'), title, text, source, ref, updatedAt: old && old.text === text && old.title === title ? old.updatedAt : new Date().toISOString() });
    }
    if (keep.length + next.length > LIMITS.docs) throw new StoreError('too_many_documents');
    const total = [...keep, ...next].reduce((n, d) => n + d.text.length, 0);
    if (total > LIMITS.totalChars) throw new StoreError('knowledge_full', 413);
    sites[index] = { ...sites[index], knowledge: [...keep, ...next] };
    this.write({ ...this.state, sites });
    return { count: next.length, removed: [...previous.keys()].filter((r) => !seen.has(r)).length };
  }

  /**
   * Applies a parsed assistant package in ONE write: the given fields (validated exactly like the admin form)
   * and, when `knowledge` is an array, it replaces every manual document. Website-synced documents stay.
   * Throws (and changes nothing) if any limit is exceeded.
   */
  importPackage(id, { fields = {}, knowledge } = {}, { dryRun = false, source = '' } = {}) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const site = sites[index];
    const cleaned = cleanSite(fields, site);
    cleaned.transferTargets = cleaned.transferTargets.filter((t) => t !== id);
    let docs = site.knowledge;
    if (Array.isArray(knowledge)) {
      const now = new Date().toISOString();
      const previous = new Map(site.knowledge.filter((d) => d.source !== 'website').map((d) => [d.title.toLowerCase(), d]));
      const manual = knowledge.map((input) => {
        const title = String(input.title || '').trim().slice(0, 120);
        const text = String(input.text || '').replace(/\r\n/g, '\n').trim();
        if (!title) throw new StoreError('title_required');
        if (!text) throw new StoreError('text_required');
        if (text.length > LIMITS.docChars) throw new StoreError('document_too_large', 413);
        const old = previous.get(title.toLowerCase());   // same title keeps its id (and date, if unchanged)
        return { id: old ? old.id : randomBytes(6).toString('hex'), title, text, source: 'manual', ref: '', updatedAt: old && old.text === text ? old.updatedAt : now };
      });
      docs = [...site.knowledge.filter((d) => d.source === 'website'), ...manual];
      if (docs.length > LIMITS.docs) throw new StoreError('too_many_documents');
      if (docs.reduce((n, d) => n + d.text.length, 0) > LIMITS.totalChars) throw new StoreError('knowledge_full', 413);
    }
    const next = { ...site, ...cleaned, knowledge: docs };
    if (dryRun) return next;   // fully validated, nothing written
    sites[index] = next;
    this.writeReason = source || 'import';
    try { this.write({ ...this.state, sites }); } finally { this.writeReason = ''; }
    return next;
  }

  githubSettings() { return { ...(this.state.github || cleanGithub()) }; }

  /** Saves GitHub sync settings. token: undefined keeps it, null/'' clears it. */
  setGithub(input) {
    const current = this.githubSettings();
    const token = input.token === undefined ? current.token : String(input.token || '').trim();
    if (token && (token.length < 20 || token.length > 300 || /\s/.test(token))) throw new StoreError('invalid_github_token');
    const repo = input.repo === undefined ? current.repo : String(input.repo || '').trim();
    if (repo && !REPO_RE.test(repo)) throw new StoreError('invalid_github_repo');
    const branch = input.branch === undefined ? current.branch : String(input.branch || '').trim() || 'main';
    if (!BRANCH_RE.test(branch)) throw new StoreError('invalid_github_branch');
    const next = cleanGithub({ ...current, ...input, repo, branch, token, webhookSecret: input.webhookSecret ?? current.webhookSecret });
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), github: next });
    return next;
  }

  /** Unexpired connection tokens. */
  connections() { return (this.state.connections || []).filter(live).map((c) => ({ ...c })); }

  /** New assistant-management token (shown once). scope: read | write; minutes: 15 (default) or 30. */
  addConnection(label, scope, minutes = 15) {
    const name = String(label || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) throw new StoreError('invalid_token_label');
    if (!CONNECTION_SCOPES.includes(scope)) throw new StoreError('invalid_scope');
    const lifetime = Number(minutes);
    if (!CONNECTION_MINUTES.includes(lifetime)) throw new StoreError('invalid_lifetime');
    const list = this.connections();
    if (list.length >= 20) throw new StoreError('too_many_tokens');
    const token = `ajmcp_${randomBytes(32).toString('hex')}`;
    const now = Date.now();
    const entry = { id: randomBytes(6).toString('hex'), label: name, scope, tokenHash: tokenHash(token), tokenHint: token.slice(-4), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetime * 60_000).toISOString(), lastUsedAt: null };
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), connections: [...list, entry] });
    return { token, entry };
  }

  removeConnection(connectionId) {
    const list = this.connections();
    if (!list.some((c) => c.id === connectionId)) throw new StoreError('token_not_found', 404);
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), connections: list.filter((c) => c.id !== connectionId) });
  }

  /** Records when a connection token was last used (at most once a minute, to keep writes rare). */
  touchConnection(connectionId) {
    const list = this.connections();
    const at = list.findIndex((c) => c.id === connectionId);
    if (at < 0) return;
    const last = list[at].lastUsedAt ? Date.parse(list[at].lastUsedAt) : 0;
    if (Date.now() - last < 60_000) return;
    list[at] = { ...list[at], lastUsedAt: new Date().toISOString() };
    try { this.write({ ...this.state, sites: this.state.sites ?? this.sites(), connections: list }); } catch { /* best effort */ }
  }

  removeDoc(id, docId) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    if (!sites[index].knowledge.some((d) => d.id === docId)) throw new StoreError('document_not_found', 404);
    sites[index] = { ...sites[index], knowledge: sites[index].knowledge.filter((d) => d.id !== docId) };
    this.write({ ...this.state, sites });
  }

  rotateToken(id) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const token = randomBytes(32).toString('hex');
    sites[index] = { ...sites[index], tokenHash: tokenHash(token), tokenHint: token.slice(-4) };
    this.write({ ...this.state, sites });
    return { site: sites[index], token };
  }

  /** Adds a named access token (shown once). With replace, older tokens with the same label are removed first. */
  addToken(id, label, { replace = false } = {}) {
    const name = String(label || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) throw new StoreError('invalid_token_label');
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    const existing = replace ? sites[index].tokens.filter((t) => t.label !== name) : sites[index].tokens;
    if (existing.length >= 10) throw new StoreError('too_many_tokens');
    const token = randomBytes(32).toString('hex');
    const entry = { id: randomBytes(6).toString('hex'), label: name, tokenHash: tokenHash(token), tokenHint: token.slice(-4), createdAt: new Date().toISOString() };
    sites[index] = { ...sites[index], tokens: [...existing, entry] };
    this.write({ ...this.state, sites });
    return { token, entry };
  }

  removeToken(id, tokenId) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    if (!sites[index].tokens.some((t) => t.id === tokenId)) throw new StoreError('token_not_found', 404);
    sites[index] = { ...sites[index], tokens: sites[index].tokens.filter((t) => t.id !== tokenId) };
    this.write({ ...this.state, sites });
  }

  removeSite(id) {
    const sites = this.sites();
    if (!sites.some((s) => s.id === id)) throw new StoreError('site_not_found', 404);
    // A deleted assistant can no longer be a transfer target of the others.
    this.write({ ...this.state, sites: sites.filter((s) => s.id !== id).map((s) => ({ ...s, transferTargets: (s.transferTargets || []).filter((t) => t !== id) })) });
  }

  setKey(provider, value) {
    if (![...KEY_PROVIDERS, 'claude', 'copilot'].includes(provider)) throw new StoreError('invalid_provider');
    const key = value === null ? '' : String(value).trim();
    if (key && (key.length < 20 || key.length > 2000 || /\s/.test(key))) throw new StoreError('invalid_api_key');
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), keys: { ...this.state.keys, [provider]: key } });
  }

  /** The master AI switch: provider '' (off) | claude | codex | antigravity, plus an optional model for each. */
  setMaster(input) {
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), master: cleanMaster(input) });
  }

  /** Time limits in seconds, keyed by model id or provider; {} clears them all. */
  setTimeouts(input) {
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), timeouts: cleanTimeouts(input) });
  }

  setPasswordHash(hash) {
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), passwordHash: hash, passwordBase: this.env.passwordHash });
  }
}
