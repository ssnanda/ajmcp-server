// Client for the AJCore lead API. The server logs in with a dedicated staff account (the same /ops/auth/login
// flow AJOps uses), keeps the short-lived token in memory and sends it only from here: never to a browser.
export class AjcoreError extends Error {
  constructor(code, status = 502, detail = '') { super(code); this.name = 'AjcoreError'; this.code = code; this.status = status; this.detail = detail; }
}

const LOCAL_HTTP = /^(localhost|127\.0\.0\.1|host\.docker\.internal)$|\.ddev\.site$/;

/** "https://ncllcagents.com/anything" -> "https://ncllcagents.com". Throws for anything unsafe. */
export function normalizeBase(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new AjcoreError('invalid_ajcore_url', 400); }
  const local = LOCAL_HTTP.test(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new AjcoreError('ajcore_url_must_be_https', 400);
  if (url.username || url.password) throw new AjcoreError('invalid_ajcore_url', 400);
  return `${url.protocol}//${url.host}`;
}

function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch { return 0; }
}

export class AjcoreClient {
  /** @param getConfig () => { url, username, password } */
  constructor(getConfig, fetchFn = fetch, { timeoutMs = 15000 } = {}) {
    this.getConfig = getConfig;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.token = '';
    this.expires = 0;
    this.tokenFor = '';
  }

  configured() {
    const c = this.getConfig() || {};
    return Boolean(c.url && c.username && c.password);
  }

  base() { return `${normalizeBase(this.getConfig().url)}/wp-json/ajcore/v1`; }

  async send(method, path, body, token) {
    let response;
    try {
      response = await this.fetchFn(this.base() + path, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch { throw new AjcoreError('ajcore_unreachable', 503); }
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async login() {
    if (!this.configured()) throw new AjcoreError('ajcore_not_configured', 503);
    const { username, password, url } = this.getConfig();
    const { response, data } = await this.send('POST', '/ops/auth/login', { username, password });
    if (response.status === 401 || response.status === 403) throw new AjcoreError('ajcore_auth_failed', 401);
    if (!response.ok || typeof data.token !== 'string') throw new AjcoreError(response.status >= 500 ? 'ajcore_server_error' : 'ajcore_rejected', 502);
    this.token = data.token;
    this.tokenFor = `${url}|${username}`;
    this.expires = (jwtExpiry(data.token) || Date.now() + 15 * 60_000) - 60_000;
    return data.user || {};
  }

  /** Authenticated call; one fresh login and retry when the token was rejected. */
  async request(method, path, body, retry = true) {
    if (!this.configured()) throw new AjcoreError('ajcore_not_configured', 503);
    const { url, username } = this.getConfig();
    if (!this.token || Date.now() >= this.expires || this.tokenFor !== `${url}|${username}`) await this.login();
    const { response, data } = await this.send(method, path, body, this.token);
    if (response.status === 401 && retry) { this.token = ''; return this.request(method, path, body, false); }
    if (response.status === 401 || response.status === 403) {
      if (data && typeof data.code === 'string' && /forbidden|section/.test(data.code)) throw new AjcoreError('ajcore_permission_denied', 403, data.code);
      throw new AjcoreError('ajcore_auth_failed', 401);
    }
    if (!response.ok) {
      // AJCore's own error codes (consent_required, contact_required, ...) are safe to surface; bodies are not.
      throw new AjcoreError(typeof data.code === 'string' ? data.code : (response.status >= 500 ? 'ajcore_server_error' : 'ajcore_rejected'), response.status);
    }
    return data;
  }

  /** Create the lead, or update the matching one. Returns { operation, lead_id, matched_by, lead }. */
  async upsertLead(payload) {
    const data = await this.request('POST', '/ops/leads/upsert', payload);
    if (!data || data.success !== true || !Number.isInteger(data.lead_id)) throw new AjcoreError('ajcore_bad_response', 502);
    return data;
  }

  async getLead(id) {
    const data = await this.request('GET', `/ops/leads/${Number(id)}`);
    return data && data.lead ? data : null;
  }

  /** For the admin "Test" button: log in fresh and report who we are. */
  async test() {
    this.token = '';
    const user = await this.login();
    return { ok: true, user: user.user_login || user.username || '', roles: user.roles || [] };
  }
}
