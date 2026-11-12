import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword, verifyPassword } from './password.js';
import { StoreError, KEY_PROVIDERS } from './store.js';
import { CliError, cliStatus, cliModels, isCliProvider, runCli, saveCodexAuth } from './cli.js';
import { generateReply, ProviderError, InputError } from './provider.js';
import { APP_VERSION } from './version.js';
import { knowledgeChars } from './knowledge.js';

const asset = (name) => readFileSync(new URL(`./admin/${name}`, import.meta.url));
const ASSETS = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8']
};
const assetCache = new Map();

const SESSION_COOKIE = 'ajmcp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;          // not remembered: until the browser closes, 12h at most
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // remembered: 30 days, renewed while you keep using it
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};

class AdminError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

/** Per-site request counters, kept in memory (reset on restart). No message text is ever stored. */
export class Stats {
  constructor() { this.sites = new Map(); }
  entry(id) {
    if (!this.sites.has(id)) this.sites.set(id, { requests: 0, errors: 0, lastUsed: null, lastError: null });
    return this.sites.get(id);
  }
  ok(id) { const e = this.entry(id); e.requests += 1; e.lastUsed = new Date().toISOString(); }
  fail(id, code) {
    const e = this.entry(id);
    e.requests += 1; e.errors += 1; e.lastUsed = e.lastError = new Date().toISOString();
    e.lastErrorCode = String(code || 'error').slice(0, 64);
  }
  get(id) { return { ...this.entry(id) }; }
}

function send(res, status, data, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(data));
}

function sameSecret(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAdmin({ config, store, stats, fetchFn = fetch, readBody }) {
  // Sessions survive restarts and deploys: they are kept (hashed) in DATA_DIR/sessions.json. Each one is
  // tied to the current admin password, so a password change or --reset-admin signs everything out.
  const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
  const pwTag = () => sha(config.adminPasswordHash).slice(0, 16);
  const sessionFile = config.dataDir ? join(config.dataDir, 'sessions.json') : '';
  const sessions = new Map();
  if (sessionFile) {
    try {
      for (const [key, value] of Object.entries(JSON.parse(readFileSync(sessionFile, 'utf8')))) {
        if (value && value.expires > Date.now()) sessions.set(key, value);
      }
    } catch { /* no saved sessions yet */ }
  }
  const persist = () => {
    if (!sessionFile) return;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      const tmp = `${sessionFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      renameSync(tmp, sessionFile);
    } catch { /* sessions then last until the next restart; not fatal */ }
  };
  let failures = [];

  const sessionFor = (req) => {
    const raw = readCookie(req, SESSION_COOKIE);
    const key = raw && sha(raw);
    const session = key && sessions.get(key);
    if (!session) return null;
    if (session.expires < Date.now() || session.tag !== pwTag()) { sessions.delete(key); persist(); return null; }
    // Sliding expiry for remembered sessions, saved at most about once an hour.
    if (session.remember && session.expires - Date.now() < REMEMBER_TTL_MS - 3600_000) {
      session.expires = Date.now() + REMEMBER_TTL_MS;
      persist();
    }
    return { id: key, ...session };
  };

  const cookie = (req, value, maxAge) => {
    const host = String(req.headers.host || '');
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    const secure = req.headers['x-forwarded-proto'] === 'https' || !local;
    return `${SESSION_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict${maxAge === null ? '' : `; Max-Age=${maxAge}`}${secure ? '; Secure' : ''}`;
  };

  // Browser calls must be same-origin JSON: custom content type forces a preflight, Origin must match Host.
  const checkWrite = (req) => {
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* handled below */ }
      if (host !== String(req.headers.host || '')) throw new AdminError('bad_origin', 403);
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new AdminError('json_required', 415);
  };

  const siteView = (site) => ({
    id: site.id, provider: site.provider, model: site.model, systemPrompt: site.systemPrompt,
    disabled: Boolean(site.disabled), strict: site.strict !== false, fallback: site.fallback || '',
    leadCapture: Boolean(site.leadCapture), leadInstructions: site.leadInstructions || '',
    routeLabel: site.routeLabel || '', transferTargets: site.transferTargets || [], tests: site.tests || [],
    knowledge: (site.knowledge || []).map((d) => ({ id: d.id, title: d.title, chars: d.text.length })), knowledgeChars: knowledgeChars(site.knowledge || []),
    tokenHint: site.tokenHint || '', createdAt: site.createdAt || null,
    tokens: (site.tokens || []).map((t) => ({ id: t.id, label: t.label, hint: t.tokenHint, createdAt: t.createdAt })),
    stats: stats.get(site.id)
  });

  const stateView = () => ({
    version: APP_VERSION,
    user: config.adminUser,
    storage: store.enabled,
    sites: store.sites().map(siteView),
    keys: { openai: store.keyInfo('openai'), anthropic: store.keyInfo('anthropic') }
  });

  const findSite = (id) => {
    const site = store.sites().find((s) => s.id === id);
    if (!site) throw new AdminError('site_not_found', 404);
    return site;
  };

  async function listModels(provider) {
    if (isCliProvider(provider)) return cliModels(config, provider);
    if (!KEY_PROVIDERS.includes(provider)) throw new AdminError('invalid_provider');
    const key = provider === 'openai' ? config.openaiApiKey : config.anthropicApiKey;
    if (!key) throw new AdminError('provider_not_configured', 409);
    const request = provider === 'openai'
      ? ['https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }]
      : ['https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }];
    let response;
    try { response = await fetchFn(request[0], { ...request[1], signal: AbortSignal.timeout(15000) }); }
    catch { throw new AdminError('provider_unreachable', 502); }
    if (!response.ok) throw new AdminError(response.status === 401 || response.status === 403 ? 'provider_auth_failed' : 'provider_request_failed', 502);
    const data = await response.json().catch(() => ({}));
    const ids = (data.data || []).map((m) => String(m.id || '')).filter(Boolean).sort();
    return ids;
  }

  async function login(req, res) {
    const now = Date.now();
    failures = failures.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (failures.length >= LOGIN_MAX_FAILURES) throw new AdminError('too_many_attempts', 429);
    const body = await readBody(req, 4096);
    const userOk = sameSecret(body?.username ?? '', config.adminUser);
    const passOk = await verifyPassword(body?.password ?? '', config.adminPasswordHash);
    if (!(userOk && passOk)) {
      failures.push(Date.now());
      await wait(500);
      throw new AdminError('invalid_credentials', 401);
    }
    const id = randomBytes(32).toString('base64url');
    const remember = body?.remember !== false;
    sessions.set(sha(id), { expires: Date.now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS), remember, tag: pwTag() });
    for (const [key, s] of sessions) if (s.expires < Date.now()) sessions.delete(key);
    persist();
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, id, remember ? REMEMBER_TTL_MS / 1000 : null) });
  }

  async function api(req, res, path) {
    const method = req.method;
    if (method !== 'GET') checkWrite(req);
    if (method === 'POST' && path === '/admin/api/login') return login(req, res);

    const session = sessionFor(req);
    if (!session) throw new AdminError('unauthorized', 401);

    if (method === 'POST' && path === '/admin/api/logout') {
      sessions.delete(session.id);
      persist();
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (method === 'GET' && path === '/admin/api/state') return send(res, 200, stateView());
    if (method === 'GET' && path === '/admin/api/cli') return send(res, 200, await cliStatus(config));
    if (method === 'GET' && path === '/admin/api/models') {
      const provider = new URL(req.url, 'http://localhost').searchParams.get('provider') || '';
      return send(res, 200, { models: await listModels(provider) });
    }

    // Knowledge documents can be large; everything else stays within the normal request limit.
    const bodyLimit = /\/knowledge$/.test(path) ? 1_048_576 : config.maxRequestBytes;
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req, bodyLimit);
    const isObject = body && typeof body === 'object' && !Array.isArray(body);
    if (!isObject) throw new AdminError('invalid_request');

    if (method === 'POST' && path === '/admin/api/sites') {
      const { site, token } = store.addSite(body);
      return send(res, 201, { site: siteView(site), token });
    }
    const siteMatch = /^\/admin\/api\/sites\/([a-z0-9][a-z0-9-_]{1,63})(\/rotate|\/test|\/tokens(?:\/[a-f0-9]{12})?|\/knowledge(?:\/[a-f0-9]{12})?)?$/.exec(path);
    if (siteMatch) {
      const [, id, action] = siteMatch;
      if (method === 'PUT' && !action) return send(res, 200, { site: siteView(store.updateSite(id, body)) });
      if (method === 'DELETE' && !action) { store.removeSite(id); return send(res, 200, { ok: true }); }
      if (method === 'POST' && action === '/tokens') {
        const { token, entry } = store.addToken(id, body.label, { replace: body.replace === true });
        return send(res, 201, { token, id: entry.id, label: entry.label, hint: entry.tokenHint });
      }
      if (method === 'DELETE' && action && action.startsWith('/tokens/')) { store.removeToken(id, action.slice('/tokens/'.length)); return send(res, 200, { ok: true }); }
      if (method === 'POST' && action === '/knowledge') { const doc = store.addDoc(id, body); return send(res, 201, { id: doc.id, title: doc.title, chars: doc.text.length }); }
      if (method === 'DELETE' && action && action.startsWith('/knowledge/')) { store.removeDoc(id, action.slice('/knowledge/'.length)); return send(res, 200, { ok: true }); }
      if (method === 'POST' && action === '/rotate') {
        const { site, token } = store.rotateToken(id);
        return send(res, 200, { site: siteView(site), token });
      }
      if (method === 'POST' && action === '/test') {
        const site = findSite(id);
        try {
          const custom = typeof body.question === 'string' && body.question.trim() ? body.question.trim().slice(0, 500) : '';
          const reply = await generateReply(site, [{ role: 'user', content: custom || 'Reply with the single word OK.' }], config, fetchFn);
          return send(res, 200, { ok: true, model: reply.model, reply: reply.text.slice(0, custom ? 2000 : 80) });
        } catch (error) {
          if (error instanceof ProviderError || error instanceof InputError) return send(res, 200, { ok: false, error: error.code || error.message });
          throw error;
        }
      }
    }
    if (method === 'PUT' && path === '/admin/api/keys') {
      for (const provider of KEY_PROVIDERS) {
        if (!(provider in body)) continue;
        const value = body[provider];
        if (value !== null && typeof value !== 'string') throw new AdminError('invalid_api_key');
        store.setKey(provider, value);
      }
      return send(res, 200, stateView().keys);
    }
    if (method === 'PUT' && path === '/admin/api/cli') {
      if ('claudeToken' in body) {
        if (body.claudeToken !== null && typeof body.claudeToken !== 'string') throw new AdminError('invalid_api_key');
        store.setKey('claude', body.claudeToken);
      }
      if ('codexAuth' in body) saveCodexAuth(config, body.codexAuth);
      return send(res, 200, await cliStatus(config));
    }
    const cliTest = /^\/admin\/api\/cli\/(claude|codex)\/test$/.exec(path);
    if (method === 'POST' && cliTest) {
      const provider = `${cliTest[1]}-cli`;
      try {
        const reply = await runCli({ provider, model: '', systemPrompt: '' }, [{ role: 'user', content: 'Reply with the single word OK.' }], config, { debug: true });
        return send(res, 200, { ok: true, reply: reply.text.slice(0, 80) });
      } catch (error) {
        if (error instanceof CliError) return send(res, 200, { ok: false, error: error.code, detail: error.detail });
        throw error;
      }
    }
    if (method === 'POST' && path === '/admin/api/password') {
      const { current, next } = body;
      if (typeof next !== 'string' || next.length < 12 || next.length > 200) throw new AdminError('password_too_short');
      if (!(await verifyPassword(String(current ?? ''), config.adminPasswordHash))) throw new AdminError('invalid_credentials', 403);
      store.setPasswordHash(await hashPassword(next));
      // The password changed: sign out every other session and re-tag this one.
      for (const key of [...sessions.keys()]) if (key !== session.id) sessions.delete(key);
      const mine = sessions.get(session.id);
      if (mine) mine.tag = pwTag();
      persist();
      return send(res, 200, { ok: true });
    }
    throw new AdminError('not_found', 404);
  }

  /** Returns true when the request belonged to the admin UI (and has been answered). */
  return async function handleAdmin(req, res, path) {
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    const normalized = path === '/admin/' ? '/admin' : path;
    try {
      if (req.method === 'GET' && ASSETS[normalized]) {
        const [file, type] = ASSETS[normalized];
        if (!assetCache.has(file)) assetCache.set(file, asset(file));
        res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS });
        res.end(assetCache.get(file));
        return true;
      }
      if (normalized.startsWith('/admin/api/')) { await api(req, res, normalized); return true; }
      throw new AdminError('not_found', 404);
    } catch (error) {
      if (error instanceof AdminError || error instanceof StoreError || error instanceof InputError) {
        send(res, error.status || 400, { error: error.code || error.message });
      } else if (error instanceof CliError) {
        send(res, error.status || 502, { error: error.code });
      } else if (error instanceof ProviderError) {
        send(res, error.status || 502, { error: error.code });
      } else {
        send(res, 500, { error: 'internal_error' });
      }
      return true;
    }
  };
}
