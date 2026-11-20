import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { identityForBearer, authorizeSite } from './auth.js';
import { Limiter } from './limits.js';
import { InputError } from './provider.js';
import { applyMaster, describeModel } from './master.js';
import { runChat } from './chat.js';
import { routeChat, ConversationStore, KEY_RE } from './routing.js';
import { LeadLimiter } from './leads.js';
import { runAgent, installedToolVersions } from './agents.js';
import { handleMcp } from './mcp.js';
import { handleAssistantMcp, connectionForToken, connectionTokenFrom } from './assistant-mcp.js';
import { GitHubSync } from './github-sync.js';
import { APP_VERSION } from './version.js';
import { createAdmin, Stats } from './admin.js';
import { handleSiteApi } from './siteapi.js';
import { runAssistantTurn } from './assistant.js';
import { SettingsStore } from './store.js';
import { ActivityLog } from './activity.js';

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

function validateHostHeader(req, config) {
  if (config.allowedHosts.size) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!config.allowedHosts.has(host)) return false;
  }
  return true;
}

function validateHost(req, config) {
  if (!validateHostHeader(req, config)) return false;
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

/** What a request is for (Activity label/filter). Clients send `purpose` in the body or an X-AJMCP-Purpose header,
 *  e.g. "email-triage". Until a client does, a prompt with an <<<EMAIL block is recognised as email triage. */
const PURPOSE_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;
function requestPurpose(req, body) {
  const given = String((body && body.purpose) || req.headers['x-ajmcp-purpose'] || '').trim();
  if (PURPOSE_RE.test(given)) return given.toLowerCase();
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  const text = typeof (body && body.message) === 'string' ? body.message : (msgs.find((m) => m && m.role === 'user') || {}).content;
  return typeof text === 'string' && text.includes('<<<EMAIL') ? 'email-triage' : undefined;
}

/** Short stable id for one chat, used only to group Activity rows. Never contains message text. */
function conversationTag(conversationId, messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m && m.role === 'user' && typeof m.content === 'string') : null;
  const seed = conversationId || (first ? first.content : '');
  return seed ? createHash('sha256').update(String(seed)).digest('hex').slice(0, 8) : undefined;
}

/** Facts the plugin passes along with a chat message; all optional, all length-limited. */
const channelIsSms = (body) => body.channel === 'sms';

function chatContext(body, sessionId) {
  const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');
  const page = text(body.page, 300);
  const visitor = body.visitor && typeof body.visitor === 'object' ? body.visitor : {};
  const siteUuid = text(body.siteUuid, 100);
  return {
    conversationId: sessionId ? String(sessionId) : text(body.conversationId, 64),
    siteUuid: /^[A-Za-z0-9-]{8,100}$/.test(siteUuid) ? siteUuid : '',
    page: /^https?:\/\//.test(page) ? page : '',
    visitor: { name: text(visitor.name, 120), email: text(visitor.email, 254), phone: text(visitor.phone, 30) },
    // The website's plugin saves leads in AJCore; it says so with leadTool: true.
    leadTool: body.leadTool === true,
    // Which channel the visitor is on (text messages get short plain replies) and whether the caller can act on a human handoff.
    channel: body.channel === 'sms' ? 'sms' : 'chat',
    handoff: body.handoff === true,
    // Text-message conversations: a stable id (line + customer) so the server can remember which assistant is active.
    conversationKey: channelIsSms(body) && KEY_RE.test(String(body.conversationKey || '')) ? String(body.conversationKey) : ''
  };
}

export function createAjmcpServer(config, { fetchFn = fetch, agentRunner = runAgent, mcpHandler = handleMcp, toolVersions = installedToolVersions, store = new SettingsStore(config) } = {}) {
  const limiter = new Limiter(config);
  const stats = new Stats();
  const activity = new ActivityLog();
  const leadLimiter = new LeadLimiter();
  const convs = new ConversationStore(config.dataDir);
  convs.load();
  // The admin UI exists only when ADMIN_USER / ADMIN_PASSWORD_HASH are configured (see DATA_DIR).
  // Two-way GitHub sync of assistants: every saved change is queued for a commit (an import that came FROM
  // GitHub is skipped; it would only find identical files anyway).
  const github = new GitHubSync({ store, fetchFn, log: (code, detail) => console.warn(JSON.stringify({ t: new Date().toISOString(), event: code, detail })) });
  store.onSitesChanged = (ids, reason) => { if (reason !== 'github') github.queuePush(ids, reason); };
  github.start();   // periodic GitHub check + pull (Settings › GitHub sync › Check GitHub every)
  const admin = config.adminUser
    ? createAdmin({ config, store, stats, activity, fetchFn, readBody, github })
    : null;
  return http.createServer(async (req, res) => {
    const id = randomUUID();
    const start = Date.now();
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    // /assistants/mcp/<token> carries a token in the path: logs and the activity list only ever see the bare route.
    const isAssistantMcp = path === '/assistants/mcp' || path.startsWith('/assistants/mcp/');
    const logRoute = isAssistantMcp ? '/assistants/mcp' : path;
    let status = 500;
    const note = {};   // bounded admin audit details; never credentials or arbitrary request bodies
    const live = path.startsWith('/v1/') || path === '/mcp' || isAssistantMcp || path === '/github/webhook' ? activity.start({ t: new Date().toISOString(), requestId: id, method: req.method, route: logRoute }, note) : null;
    try {
      // Health probes reach the pod using its internal IP/Host, not the public OpenShift Route.
      // No secrets or tenant information are exposed by these probe endpoints.
      if (req.method === 'GET' && path === '/health/live') {
        status = 200; return json(res, status, { status: 'live', version: APP_VERSION }, id);
      }
      if (req.method === 'GET' && path === '/health/ready') {
        status = 200; return json(res, status, { status: 'ready' }, id);
      }
      // The admin UI is a same-origin browser app: it has its own session login and Origin check.
      if (admin && (path === '/admin' || path.startsWith('/admin/'))) {
        if (!validateHostHeader(req, config)) { status = 403; return json(res, status, { error: 'untrusted_origin_or_host' }, id); }
        await admin(req, res, path);
        status = res.statusCode; return;
      }
      // GitHub push webhook for the assistants repo: authenticated by its HMAC signature, not a bearer token.
      if (req.method === 'POST' && path === '/github/webhook') {
        if (!validateHostHeader(req, config)) { status = 403; return json(res, status, { error: 'untrusted_origin_or_host' }, id); }
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) { status = 413; return json(res, status, { error: 'request_too_large' }, id); } chunks.push(chunk); }
        const out = github.handleWebhook(req.headers, Buffer.concat(chunks));
        note.site = 'github'; if (out.body.error) note.error = out.body.error;
        status = out.status; return json(res, status, out.body, id);
      }
      // Assistant-management MCP: short-lived connection tokens from admin › Connections. Server-to-server clients
      // (Claude Code, ChatGPT connectors) send no browser Origin, so only the Host is checked here.
      if (isAssistantMcp && ['POST', 'GET', 'DELETE'].includes(req.method)) {
        if (!validateHostHeader(req, config)) { status = 403; note.error = 'untrusted_host'; return json(res, status, { error: 'untrusted_origin_or_host' }, id); }
        const connection = connectionForToken(connectionTokenFrom(req, path), store);
        if (!connection) { status = 401; note.error = 'bad_or_expired_connection_token'; return json(res, status, { error: 'unauthorized' }, id); }
        note.site = 'connection'; note.via = `${connection.label} (${connection.scope})`;
        store.touchConnection(connection.id);
        await handleAssistantMcp(req, res, { store, config, limiter, connection, fetchFn, github });
        status = res.statusCode; return;
      }
      if (!validateHost(req, config)) { status = 403; note.error = 'untrusted_origin_or_host'; note.host = String(req.headers.host || ''); return json(res, status, { error: 'untrusted_origin_or_host' }, id); }
      const identity = identityForBearer(req.headers.authorization, config);
      if (!identity) { status = 401; note.error = req.headers.authorization ? 'bad_or_disabled_token' : 'no_token'; return json(res, status, { error: 'unauthorized' }, id); }
      note.site = identity.id; note.via = identity.via;

      if (path === '/mcp' && ['POST', 'GET', 'DELETE'].includes(req.method)) {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        await mcpHandler(req, res, site, config, limiter, fetchFn);
        status = res.statusCode; return;
      }
      if (req.method === 'GET' && path === '/v1/capabilities') {
        status = 200;
        return json(res, status, {
          version: APP_VERSION, id: identity.id,
          kind: identity.kind, provider: identity.kind === 'site' ? applyMaster(identity.site, config).provider : null,
          endpoints: ['/v1/chat', '/v1/ajcore/reply', '/v1/assistant', '/mcp'],
          agentsEnabled: identity.kind === 'admin' && config.enableAgentJobs
        }, id);
      }
      if (req.method === 'GET' && path === '/v1/admin/tools') {
        if (identity.kind !== 'admin') { status = 403; return json(res, status, { error: 'admin_required' }, id); }
        status = 200; return json(res, status, { tools: await toolVersions() }, id);
      }
      // The website's plugin edits its own site's behavior and knowledge here (a site token can only reach its own site).
      if (path.startsWith('/v1/site/')) {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        const result = await handleSiteApi({ req, path, site, store, config, readBody, limiter, identity });
        if (!result) { status = 404; return json(res, status, { error: 'not_found' }, id); }
        status = result.status; return json(res, status, result.body, id);
      }
      if (req.method === 'POST' && (path === '/v1/chat' || path === '/v1/ajcore/reply')) {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        const body = await readBody(req, config.maxRequestBytes);
        Object.assign(note, describeModel(site, config)); // known up front, so a slow or failed call still shows its model
        note.channel = body && body.channel === 'sms' ? 'sms' : 'chat';
        if (body && Number.isSafeInteger(body.sessionId)) note.sessionId = body.sessionId;
        if (body && typeof body.message === 'string') note.chars = body.message.length;
        note.purpose = requestPurpose(req, body);
        const slot = limiter.acquire(identity);
        if (!slot.ok) { status = slot.status; note.error = slot.code; return json(res, status, { error: slot.code }, id); }
        try {
          const ajcore = path === '/v1/ajcore/reply' ? prepareAjcoreChat(body, config) : null;
          if (!ajcore && (!body || typeof body !== 'object' || Array.isArray(body))) throw new InputError('invalid_request');
          // Clients cannot choose provider, model, system instructions or another tenant.
          let reply;
          try {
            const context = chatContext(body, ajcore ? ajcore.sessionId : 0);
            const messages = ajcore ? ajcore.messages : body.messages;
            if (Array.isArray(messages)) note.transcript = messages.map(({ role, content }) => ({ role, content }));
            // Who the customer is, when the caller knows (chat form or SMS number): "name · email · phone". Admin-only.
            const who = context.visitor || {};
            const label = [who.name, who.email, who.phone].filter(Boolean).join(' · ');
            if (label) note.visitor = label.slice(0, 120);
            // Activity groups one chat into one row. Clients without a sessionId (e.g. aados) resend the full history each turn,
            // so their conversationId, else a hash of the first user message, stays the same for the whole chat.
            if (note.sessionId == null) note.conversation = conversationTag(context.conversationId, messages);
            reply = context.conversationKey
              ? await routeChat({ entry: site, convs, key: context.conversationKey, messages, context, config, fetchFn, limiter: leadLimiter, log: (m) => console.info(`[routing] ${site.id} ${m}`) })
              : await runChat({ site, messages, context, config, fetchFn, limiter: leadLimiter });
          }
          catch (error) { stats.fail(site.id, error.code || error.message); throw error; }
          stats.ok(site.id);
          status = 200;
          note.assistant = reply.assistant || site.id; note.routedFrom = reply.routed && reply.routed.from; note.provider = reply.provider; note.model = reply.model;
          if (Array.isArray(note.transcript)) note.transcript.push({ role: 'assistant', content: reply.text });
          return json(res, status, {
            requestId: id, site: site.id,
            ...(ajcore ? { sessionId: ajcore.sessionId, reply: reply.text, senderName: 'AJMCP AI' } : { reply: reply.text }),
            provider: reply.provider, model: reply.model, usage: reply.usage,
            ...(reply.lead ? { lead: reply.lead } : {}), ...(reply.leadError ? { leadError: reply.leadError } : {}),
            ...(reply.handoff !== undefined ? { handoff: reply.handoff } : {}),
            ...(reply.assistant ? { assistant: reply.assistant } : {}), ...(reply.routed ? { routed: reply.routed } : {})
          }, id);
        } finally { slot.release(); }
      }
      if (req.method === 'POST' && path === '/v1/assistant') {
        const site = authorizeSite(identity);
        if (!site) { status = 403; return json(res, status, { error: 'site_token_required' }, id); }
        const body = await readBody(req, config.maxAssistantChars + 40000);
        Object.assign(note, describeModel(site, config));
        const slot = limiter.acquire(identity);
        if (!slot.ok) { status = slot.status; return json(res, status, { error: slot.code }, id); }
        try {
          let turn;
          try { turn = await runAssistantTurn(site, body, config, fetchFn); }
          catch (error) { stats.fail(site.id, error.code || error.message); throw error; }
          stats.ok(site.id);
          status = 200; return json(res, status, { requestId: id, site: site.id, ...turn }, id);
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
      note.error = note.error || message;
      return json(res, status, { error: message, requestId: id }, id);
    } finally {
      if (live) activity.end(live);
      // Transcripts stay in the in-memory admin audit only; ordinary container logs contain metadata, never text or credentials.
      const entry = { t: new Date().toISOString(), requestId: id, method: req.method, route: logRoute, status: res.statusCode || status, ms: Date.now() - start, ...note };
      console.info(JSON.stringify({ t: entry.t, requestId: id, method: req.method, route: logRoute, status: entry.status, durationMs: entry.ms,
        site: note.site, channel: note.channel, sessionId: note.sessionId, provider: note.provider, model: note.model, error: note.error }));
      // Only the API routes matter here; browser page loads, favicon and probes would only add noise.
      if (path.startsWith('/v1/') || path === '/mcp' || isAssistantMcp || path === '/github/webhook') activity.add(entry);
      // Optional (GitHub sync › "Also save chat transcripts"): one file per conversation, batched commits.
      if (Array.isArray(entry.transcript) && entry.transcript.length) github.queueChat(entry);
    }
  });
}
