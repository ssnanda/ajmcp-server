import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const boundedInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
};

function parseSites(raw, allowEmpty = false) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('Invalid JSON in site configuration'); }
  if (!config || !Array.isArray(config.sites) || (!config.sites.length && !allowEmpty)) {
    throw new Error('Site configuration must contain a non-empty sites array');
  }
  const ids = new Set();
  const tokens = new Set();
  return config.sites.map((site) => {
    const id = String(site.id || '');
    const token = String(site.token || '');
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(id)) throw new Error('Invalid site id');
    if (token.length < 32 || /REPLACE_WITH|EXAMPLE|SAMPLE/i.test(token)) {
      throw new Error(`Site ${id} needs a unique random secret (32+ characters)`);
    }
    if (ids.has(id) || tokens.has(token)) throw new Error('Duplicate site id or token');
    if (site.provider && !['openai', 'anthropic'].includes(site.provider)) throw new Error('Unknown site provider');
    ids.add(id); tokens.add(token);
    return Object.freeze({
      id, token, provider: site.provider || 'openai',
      model: String(site.model || ''),
      systemPrompt: String(site.systemPrompt || '').slice(0, 12000)
    });
  });
}

export function loadConfig(env = process.env, read = readFileSync) {
  const path = env.SITES_CONFIG_FILE ? resolve(env.SITES_CONFIG_FILE) : '';
  const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : '';
  // With a data directory the admin UI owns the site list, so the seed file may be empty or absent.
  if (!path && !env.SITES_JSON && !dataDir) throw new Error('Configure SITES_CONFIG_FILE or SITES_JSON before starting');
  const sites = path || env.SITES_JSON ? parseSites(path ? read(path, 'utf8') : env.SITES_JSON, Boolean(dataDir)) : [];
  const adminUser = String(env.ADMIN_USER || '');
  const adminPasswordHash = String(env.ADMIN_PASSWORD_HASH || '');
  if (Boolean(adminUser) !== Boolean(adminPasswordHash)) throw new Error('ADMIN_USER and ADMIN_PASSWORD_HASH must be set together');
  if (adminUser && !dataDir) throw new Error('The admin UI needs DATA_DIR');
  const adminToken = String(env.ADMIN_TOKEN || '');
  if (adminToken && adminToken.length < 32) throw new Error('ADMIN_TOKEN must be at least 32 characters');
  if (adminToken && sites.some((site) => site.token === adminToken)) throw new Error('Admin token must differ from site tokens');
  return {
    host: env.HOST || '0.0.0.0',
    port: boundedInt(env.PORT, 3000, 1, 65535),
    sites,
    adminToken,
    dataDir, adminUser, adminPasswordHash,
    openaiApiKey: env.OPENAI_API_KEY || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || '',
    anthropicModel: env.ANTHROPIC_MODEL || '',
    allowedHosts: new Set((env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)),
    allowedOrigins: new Set((env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)),
    maxRequestBytes: boundedInt(env.MAX_REQUEST_BYTES, 32768, 1024, 1_048_576),
    maxMessages: boundedInt(env.MAX_MESSAGES, 20, 1, 100),
    maxMessageChars: boundedInt(env.MAX_MESSAGE_CHARS, 6000, 50, 50000),
    maxConcurrent: boundedInt(env.MAX_CONCURRENT, 6, 1, 100),
    rateLimitPerMinute: boundedInt(env.RATE_LIMIT_PER_MINUTE, 30, 1, 10000),
    providerTimeoutMs: boundedInt(env.PROVIDER_TIMEOUT_MS, 45000, 1000, 180000),
    agentTimeoutMs: boundedInt(env.AGENT_TIMEOUT_MS, 90000, 1000, 300000),
    enableAgentJobs: env.ENABLE_AGENT_JOBS === 'true',
    agentWorkspace: env.AGENT_WORKSPACE || '/workspace'
  };
}
