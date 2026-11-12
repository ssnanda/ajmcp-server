import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tokenHash } from './auth.js';
import { LIMITS } from './knowledge.js';

export class StoreError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'StoreError'; this.code = code; this.status = status; }
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const KEY_PROVIDERS = ['openai', 'anthropic'];
export const PROVIDERS = [...KEY_PROVIDERS, 'claude-cli', 'codex-cli'];

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
    this.env = { openai: config.openaiApiKey, anthropic: config.anthropicApiKey, claude: config.claudeOauthToken, passwordHash: config.adminPasswordHash };
    this.state = { sites: undefined, keys: {}, passwordHash: '', passwordBase: '' };
  }

  get enabled() { return Boolean(this.file); }

  load() {
    if (!this.file) return;
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const data = JSON.parse(raw);
    this.state = {
      sites: Array.isArray(data.sites) ? data.sites.map(toStored) : undefined,
      keys: { openai: String(data.keys?.openai || ''), anthropic: String(data.keys?.anthropic || ''), claude: String(data.keys?.claude || '') },
      passwordHash: String(data.passwordHash || ''),
      passwordBase: String(data.passwordBase || '')
    };
    this.apply();
  }

  apply() {
    const { config, state, env } = this;
    if (state.sites) config.sites = state.sites;
    config.openaiApiKey = state.keys.openai || env.openai;
    config.anthropicApiKey = state.keys.anthropic || env.anthropic;
    config.claudeOauthToken = state.keys.claude || env.claude;
    // A password changed in the UI wins, unless the deploy script later issued a new one (--reset-admin).
    config.adminPasswordHash = state.passwordHash && state.passwordBase === env.passwordHash ? state.passwordHash : env.passwordHash;
  }

  write(next) {
    if (!this.file) throw new StoreError('storage_unavailable', 503);
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sites: next.sites, keys: next.keys, passwordHash: next.passwordHash, passwordBase: next.passwordBase }, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError('storage_unavailable', 503);
    }
    this.state = next;
    this.apply();
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
    if (![...KEY_PROVIDERS, 'claude'].includes(provider)) throw new StoreError('invalid_provider');
    const key = value === null ? '' : String(value).trim();
    if (key && (key.length < 20 || key.length > 2000 || /\s/.test(key))) throw new StoreError('invalid_api_key');
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), keys: { ...this.state.keys, [provider]: key } });
  }

  setPasswordHash(hash) {
    this.write({ ...this.state, sites: this.state.sites ?? this.sites(), passwordHash: hash, passwordBase: this.env.passwordHash });
  }
}
