import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { identityForBearer, authorizeSite } from './auth.js';
import { Limiter } from './limits.js';
import { generateReply, InputError } from './provider.js';
import { runAgent, installedToolVersions } from './agents.js';
import { handleMcp } from './mcp.js';

function json(res, status, data, requestId) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-ID': requestId
  });
  res.end(JSON.stringify(data));
}

async function readBody(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new InputError('request_too_large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('invalid_json'); }
}

function validateHost(req, config) {
  if (config.allowedHosts.size) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!config.allowedHosts.has(host)) return false;
  }
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) return false;
  return true;
}

function prepareAjcoreChat(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('invalid_request');
  if (!(Number.isSafeInteger(body.sessionId) && body.sessionId > 0)) throw new InputError('invalid_session_id');
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > config.maxMessageChars) {
    throw new InputError('invalid_message');
  }
  const history = body.history === undefined ? [] : body.history;
  if (!Array.isArray(history) || history.length > config.maxMessages - 1) throw new InputError('invalid_history');
  const messages = [...history, { role: 'user', content: body.message }];
  return { sessionId: body.sessionId, messages };
}

export function createAjmcpServer(config, { fetchFn = fetch, agentRunner = runAgent, mcpHandler = handleMcp, toolVersions = installedToolVersions } = {}) {
  const limiter = new Limiter(config);
  return http.createServer(async (req, res) => {
    const id = randomUUID();
    const start = Date.now();
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    let status = 500;
    try {
      // Health probes reach the pod using its internal IP/Host, not the public OpenShift Route.
      // No secrets or tenant information are exposed by these probe endpoints.
      if (req.method === 'GET' && path === '/health/live') {
        status = 200; return json(res, status, { status: 'live', version: '0.1.0' }, id);
      }
      if (req.method === 'GET' && path === '/health/ready') {
        status = 200; return json(res, status, { status: 'ready' }, id);
      }
      if (!validateHost(req, config)) { status = 403; return json(res, status, { error: 'untrusted_origin_or_host' }, id); }
      const identity = identityForBearer(req.headers.authorization, config);
      if (!identity) { status = 401; return json(res, status, { error: 'unauthorized' }, id); }

      if (path === '/mcp' && ['POST', 'GET', 'DELETE'].includes(req.method)) {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        await mcpHandler(req, res, site, config, limiter, fetchFn);
        status = res.statusCode; return;
      }
      if (req.method === 'GET' && path === '/v1/capabilities') {
        status = 200;
        return json(res, status, {
          version: '0.1.0', id: identity.id,
          kind: identity.kind, provider: identity.kind === 'site' ? identity.site.provider : null,
          endpoints: ['/v1/chat', '/v1/ajcore/reply', '/mcp'],
          agentsEnabled: identity.kind === 'admin' && config.enableAgentJobs
        }, id);
      }
      if (req.method === 'GET' && path === '/v1/admin/tools') {
        if (identity.kind !== 'admin') { status = 403; return json(res, status, { error: 'admin_required' }, id); }
        status = 200; return json(res, status, { tools: await toolVersions() }, id);
      }
      if (req.method === 'POST' && (path === '/v1/chat' || path === '/v1/ajcore/reply')) {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        const body = await readBody(req, config.maxRequestBytes);
        const slot = limiter.acquire(identity);
        if (!slot.ok) { status = slot.status; return json(res, status, { error: slot.code }, id); }
        try {
          const ajcore = path === '/v1/ajcore/reply' ? prepareAjcoreChat(body, config) : null;
          if (!ajcore && (!body || typeof body !== 'object' || Array.isArray(body))) throw new InputError('invalid_request');
          // Clients cannot choose provider, model, system instructions or another tenant.
          const reply = await generateReply(site, ajcore ? ajcore.messages : body.messages, config, fetchFn);
          status = 200;
          return json(res, status, {
            requestId: id, site: site.id,
            ...(ajcore ? { sessionId: ajcore.sessionId, reply: reply.text, senderName: 'AJMCP AI' } : { reply: reply.text }),
            provider: reply.provider, model: reply.model, usage: reply.usage
          }, id);
        } finally { slot.release(); }
      }
      if (req.method === 'POST' && path === '/v1/agents/run') {
        if (identity.kind !== 'admin') { status = 403; return json(res, status, { error: 'admin_required' }, id); }
        const body = await readBody(req, config.maxRequestBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('invalid_request');
        const slot = limiter.acquire(identity);
        if (!slot.ok) { status = slot.status; return json(res, status, { error: slot.code }, id); }
        try {
          const result = await agentRunner(body.provider, body.prompt, config);
          status = 200; return json(res, status, { requestId: id, ...result }, id);
        } finally { slot.release(); }
      }
      status = 404; return json(res, status, { error: 'not_found' }, id);
    } catch (error) {
      status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      const message = error instanceof InputError ? error.message
        : error.code && typeof error.code === 'string' ? error.code
        : ['agent_jobs_disabled', 'unknown_agent', 'invalid_prompt', 'agent_provider_not_configured',
          'agent_workspace_unavailable', 'agent_timeout', 'agent_unavailable', 'agent_failed',
          'agent_output_too_large', 'agent_empty_output'].includes(error.message) ? error.message
        : 'internal_error';
      return json(res, status, { error: message, requestId: id }, id);
    } finally {
      // No message text or credentials in logs.
      console.info(JSON.stringify({ t: new Date().toISOString(), requestId: id, method: req.method,
        route: path, status: res.statusCode || status, durationMs: Date.now() - start }));
    }
  });
}
