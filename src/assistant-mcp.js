// Assistant-management MCP (Streamable HTTP, stateless): lets an AI client (Claude Code, ChatGPT connectors)
// read and edit assistants. Auth is a short-lived connection token created in the admin (Connections):
//   Authorization: Bearer ajmcp_…         (Claude Code and other clients that send headers)
//   https://<host>/assistants/mcp/<token>  (clients that cannot send headers, e.g. ChatGPT "no auth" connectors)
// Tokens expire after 15 or 30 minutes. Scope "read" can only look and run tests; "write" can also change assistants.
// Never exposes provider keys, CLI logins, site tokens or the admin password; packages never set provider/model.
import { createHash, timingSafeEqual } from 'node:crypto';
import { generateReply } from './provider.js';
import { siteToPackage, parsePackage } from './package.js';
import { StoreError } from './store.js';

const sha = (value) => createHash('sha256').update(String(value)).digest();

/** The unexpired connection matching a token (every token is compared, so timing reveals nothing). */
export function connectionForToken(token, store) {
  const candidate = String(token || '');
  if (!/^ajmcp_[0-9a-f]{64}$/.test(candidate)) return null;
  const hash = sha(candidate);
  let match = null;
  for (const c of store.connections()) {
    const expected = Buffer.from(c.tokenHash, 'hex');
    if (expected.length === hash.length && timingSafeEqual(hash, expected)) match = c;
  }
  return match;
}

/** Token from the Authorization header or from /assistants/mcp/<token>. */
export function connectionTokenFrom(req, path) {
  const header = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (header) return header[1];
  const segment = path.slice('/assistants/mcp/'.length);
  return path.startsWith('/assistants/mcp/') && !segment.includes('/') ? segment : '';
}

const EDITABLE = ['name', 'systemPrompt', 'routeLabel', 'leadCapture', 'leadInstructions', 'fallback', 'strict', 'transferTargets', 'tests'];
const pick = (input) => Object.fromEntries(EDITABLE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (code) => ({ isError: true, content: [{ type: 'text', text: String(code) }] });

function summary(site) {
  const manual = site.knowledge.filter((d) => d.source !== 'website');
  return {
    id: site.id, disabled: site.disabled, provider: site.provider, model: site.model || '',
    routeLabel: site.routeLabel, leadCapture: site.leadCapture, transferTargets: site.transferTargets,
    tests: site.tests.length, manualDocs: manual.length, websiteDocs: site.knowledge.length - manual.length,
    knowledgeChars: site.knowledge.reduce((n, d) => n + d.text.length, 0)
  };
}

function detail(site) {
  return {
    ...summary(site),
    systemPrompt: site.systemPrompt, leadInstructions: site.leadInstructions, fallback: site.fallback, strict: site.strict,
    tests: site.tests.map(({ question, expected }) => ({ question, expected })),
    knowledge: site.knowledge.map((d) => ({ id: d.id, title: d.title, text: d.text, source: d.source, updatedAt: d.updatedAt }))
  };
}

function diff(before, after) {
  const fields = {};
  for (const k of EDITABLE) {
    const a = JSON.stringify(before[k] ?? null);
    const b = JSON.stringify(after[k] ?? null);
    if (a !== b) fields[k] = typeof after[k] === 'string' ? { fromChars: String(before[k] || '').length, toChars: after[k].length } : { from: before[k], to: after[k] };
  }
  const oldManual = new Map(before.knowledge.filter((d) => d.source !== 'website').map((d) => [d.title.toLowerCase(), d]));
  const newManual = new Map(after.knowledge.filter((d) => d.source !== 'website').map((d) => [d.title.toLowerCase(), d]));
  const knowledge = { added: [], changed: [], removed: [], unchanged: 0 };
  for (const [key, d] of newManual) {
    const old = oldManual.get(key);
    if (!old) knowledge.added.push(d.title);
    else if (old.text !== d.text || old.title !== d.title) knowledge.changed.push(d.title);
    else knowledge.unchanged += 1;
  }
  for (const [key, d] of oldManual) if (!newManual.has(key)) knowledge.removed.push(d.title);
  return { fields, knowledge };
}

export async function handleAssistantMcp(req, res, { store, config, limiter, connection, fetchFn = fetch, github = null }) {
  const [{ McpServer }, { NodeStreamableHTTPServerTransport }, z] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node/streamableHttp'),
    import('zod/v4')
  ]);
  const canWrite = connection.scope === 'write';
  const find = (id) => {
    const site = store.sites().find((s) => s.id === id);
    if (!site) throw new StoreError('assistant_not_found', 404);
    return site;
  };
  const guard = (fn) => async (args) => {
    try { return await fn(args); } catch (error) { return fail(error.code || error.message || 'failed'); }
  };
  const writeOnly = (fn) => guard(async (args) => (canWrite ? fn(args) : fail('read_only_token: create a write token in AJMCP admin › Connections')));
  const id = z.string().regex(/^[a-z0-9][a-z0-9-_]{1,63}$/).describe('Assistant id, e.g. ncllcagents');

  const mcp = new McpServer({ name: 'ajmcp-assistants', version: '1.0.0' });

  mcp.registerTool('list_assistants', {
    description: 'List all AJMCP assistants with their route label, lead capture, transfer targets and knowledge size.',
    inputSchema: z.object({})
  }, guard(async () => text(store.sites().map(summary))));

  mcp.registerTool('get_assistant', {
    description: 'Everything editable for one assistant: instructions (systemPrompt), route label, lead settings, fallback, transfer targets, tests and all knowledge documents (manual and website-synced).',
    inputSchema: z.object({ id })
  }, guard(async ({ id: siteId }) => text(detail(find(siteId)))));

  mcp.registerTool('export_assistant', {
    description: 'The assistant as package files { fileName: text } (same layout as the local assistants/<id>/ folder and the ChatGPT zip). Manual knowledge only.',
    inputSchema: z.object({ id })
  }, guard(async ({ id: siteId }) => text(siteToPackage(find(siteId)))));

  mcp.registerTool('import_assistant', {
    description: 'Load package files into an assistant. Fields are only changed when their file is present; knowledge files REPLACE all manual knowledge (website-synced documents are kept). apply=false (default) only previews the changes and validates limits; apply=true saves in one step and changes nothing if any check fails.',
    inputSchema: z.object({ id, files: z.record(z.string(), z.string()).describe('{ "ncllcagents-01-ai-behavior-instructions.txt": "...", ... }'), apply: z.boolean().optional() })
  }, guard(async ({ id: siteId, files, apply }) => {
    const before = find(siteId);
    const parsed = parsePackage(files);
    const hasKnowledge = Object.keys(files).some((n) => /knowledge-\d+-/i.test(n));
    const payload = { fields: pick(parsed.fields), knowledge: hasKnowledge ? parsed.knowledge : undefined };
    if (parsed.meta && parsed.meta.id && parsed.meta.id !== siteId) parsed.warnings.push(`package is for "${parsed.meta.id}", importing into "${siteId}"`);
    if (apply && !canWrite) return fail('read_only_token: preview only');
    const after = store.importPackage(siteId, payload, { dryRun: !apply });
    return text({ applied: Boolean(apply), changes: diff(before, after), warnings: parsed.warnings, ignoredFiles: parsed.ignored });
  }));

  mcp.registerTool('update_assistant', {
    description: 'Change one or more fields of an assistant. Limits: systemPrompt 12,000 chars, routeLabel 200, leadInstructions 4,000, fallback 500, tests 30 (question 300, expected 500), transferTargets 10 assistant ids.',
    inputSchema: z.object({
      id,
      name: z.string().max(80).optional(), systemPrompt: z.string().optional(), routeLabel: z.string().optional(), leadCapture: z.boolean().optional(),
      leadInstructions: z.string().optional(), fallback: z.string().optional(), strict: z.boolean().optional(),
      transferTargets: z.array(z.string()).optional(),
      tests: z.array(z.object({ question: z.string(), expected: z.string().optional() })).optional()
    })
  }, writeOnly(async (args) => {
    const before = find(args.id);
    const after = store.updateSite(args.id, pick(args));
    return text({ saved: true, changes: diff(before, after).fields });
  }));

  mcp.registerTool('add_knowledge', {
    description: 'Add a manual knowledge document (one topic, plain text).',
    inputSchema: z.object({ id, title: z.string().min(1).max(120), text: z.string().min(1) })
  }, writeOnly(async ({ id: siteId, title, text: body }) => {
    const doc = store.addDoc(siteId, { title, text: body });
    return text({ saved: true, docId: doc.id, title: doc.title, chars: doc.text.length });
  }));

  mcp.registerTool('update_knowledge', {
    description: 'Edit a manual knowledge document in place (title and/or text). Website-synced documents cannot be edited here.',
    inputSchema: z.object({ id, docId: z.string(), title: z.string().max(120).optional(), text: z.string().optional() })
  }, writeOnly(async ({ id: siteId, docId, title, text: body }) => {
    if (store.getDoc(siteId, docId).source === 'website') return fail('website_document_is_synced');
    const doc = store.updateDoc(siteId, docId, { title, text: body });
    return text({ saved: true, docId: doc.id, title: doc.title, chars: doc.text.length });
  }));

  mcp.registerTool('delete_knowledge', {
    description: 'Delete a manual knowledge document. Website-synced documents cannot be deleted here.',
    inputSchema: z.object({ id, docId: z.string() })
  }, writeOnly(async ({ id: siteId, docId }) => {
    if (store.getDoc(siteId, docId).source === 'website') return fail('website_document_is_synced');
    store.removeDoc(siteId, docId);
    return text({ deleted: true, docId });
  }));

  mcp.registerTool('run_tests', {
    description: 'Ask the assistant its saved test texts (or one custom question) and return each reply next to the expected result, so you can judge them. Uses the live AI, so keep runs small: at most 10 tests per call (use offset for more).',
    inputSchema: z.object({ id, question: z.string().max(500).optional(), offset: z.number().int().min(0).optional() })
  }, guard(async ({ id: siteId, question, offset = 0 }) => {
    const site = find(siteId);
    const cases = question ? [{ question, expected: '' }] : site.tests.slice(offset, offset + 10);
    if (!cases.length) return fail('no_tests');
    const results = [];
    for (const t of cases) {
      const slot = limiter.acquire({ id: site.id });
      if (!slot.ok) { results.push({ question: t.question, expected: t.expected, error: slot.code }); continue; }
      try {
        const reply = await generateReply(site, [{ role: 'user', content: t.question }], config, fetchFn);
        results.push({ question: t.question, expected: t.expected, reply: reply.text.slice(0, 2000), model: reply.model });
      } catch (error) {
        results.push({ question: t.question, expected: t.expected, error: error.code || 'ai_request_failed' });
      } finally { slot.release(); }
    }
    return text({ total: site.tests.length, offset, results });
  }));

  mcp.registerTool('list_versions', {
    description: 'Version tags of the GitHub assistants repo (ssnanda/ajmcp-assistants), newest first, with their commit and link.',
    inputSchema: z.object({})
  }, guard(async () => {
    if (!github || !github.configured) return fail('github_not_configured');
    return text(await github.listTags());
  }));

  mcp.registerTool('tag_version', {
    description: 'Tag the current state of the GitHub assistants repo (every assistant) as a version, e.g. after finishing a set of edits. Pending changes are committed first. Name: letters, numbers, dots, dashes, slashes (e.g. v2026-11-20 or ncllcagents-v3); note: what changed.',
    inputSchema: z.object({ name: z.string().min(1).max(100), note: z.string().max(2000).optional() })
  }, writeOnly(async ({ name, note }) => {
    if (!github || !github.configured) return fail('github_not_configured');
    return text(await github.createTag(name, note));
  }));

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
}
