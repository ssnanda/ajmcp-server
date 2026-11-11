import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tokenHash } from './auth.js';

export class StoreError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'StoreError'; this.code = code; this.status = status; }
}

const ID_RE = /^[a-z0-9][a-z0-9-_]{1,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const KEY_PROVIDERS = ['openai', 'anthropic'];
export const PROVIDERS = [...KEY_PROVIDERS, 'claude-cli', 'codex-cli'];

function cleanSite(input, existing = {}) {
  const provider = input.provider ?? existing.provider ?? 'openai';
  const model = String(input.model ?? existing.model ?? '').trim();
  const systemPrompt = String(input.systemPrompt ?? existing.systemPrompt ?? '');
  if (!PROVIDERS.includes(provider)) throw new StoreError('invalid_provider');
  if (model && !MODEL_RE.test(model)) throw new StoreError('invalid_model');
  if (systemPrompt.length > 12000) throw new StoreError('system_prompt_too_long');
  return { provider, model, systemPrompt, disabled: Boolean(input.disabled ?? existing.disabled) };
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
    const site = toStored({ id, token, ...cleanSite(input) });
    this.write({ ...this.state, sites: [...sites, site] });
    return { site, token };
  }

  updateSite(id, input) {
    const sites = this.sites();
    const index = sites.findIndex((s) => s.id === id);
    if (index < 0) throw new StoreError('site_not_found', 404);
    sites[index] = { ...sites[index], ...cleanSite(input, sites[index]) };
    this.write({ ...this.state, sites });
    return sites[index];
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

  removeSite(id) {
    const sites = this.sites();
    if (!sites.some((s) => s.id === id)) throw new StoreError('site_not_found', 404);
    this.write({ ...this.state, sites: sites.filter((s) => s.id !== id) });
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
