// Two-way sync between AJMCP assistants and a private GitHub repo, run inside the server (GitHub REST API,
// no git binary). Layout 1:1 with the package format: one folder per assistant, `<id>/<package files>`.
//
//   Server -> GitHub: whenever an assistant's package changes, its folder is committed (debounced, one commit
//                     per change). Files are compared by git blob hash first, so unchanged content never commits.
//   GitHub -> Server: a signed push webhook (or "Pull all") imports changed folders through the normal validated
//                     import. A folder is the COMPLETE package: it replaces all manual knowledge. A package that
//                     fails validation is rejected and reported; the assistant stays as it was.
//
// Loop safety: our commits carry COMMIT_MARK and webhooks for them are skipped; content comparison stops any echo.
// Folders without a matching assistant are reported, never created (creating one issues a website token).
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { siteToPackage, parsePackage } from './package.js';

export const COMMIT_MARK = '[ajmcp-sync]';
const blobSha = (text) => {
  const body = Buffer.from(String(text), 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};
const README = `# AJMCP assistants

Synced two ways with AJMCP (ajmcp-server). One folder per assistant, named by its id; the files
are the assistant's package (see the AJMCP package format):

    <id>/<id>-assistant.json
    <id>/<id>-01-ai-behavior-instructions.txt
    <id>/<id>-02-ai-behavior-what-it-handles.txt
    <id>/<id>-03-leads-instructions.txt
    <id>/<id>-04-knowledge-fallback-reply.txt
    <id>/<id>-05-test-texts.txt
    <id>/<id>-knowledge-NN-<topic>.txt

A folder is the complete assistant: pushing a change here updates AJMCP (after validation), and
edits made in AJMCP are committed here. Never put keys, tokens, provider or model in these files.
`;

export class GitHubSync {
  constructor({ store, fetchFn = fetch, log = () => {} }) {
    this.store = store;
    this.fetchFn = fetchFn;
    this.log = log;
    this.pending = new Map();      // siteId -> reason
    this.timer = null;
    this.busy = Promise.resolve();
    this.status = { lastPush: null, lastPull: null, lastChats: null, lastError: '', unknownFolders: [], rejected: [] };
    this.chats = new Map();        // chat file path -> markdown (latest full transcript wins)
    this.chatTimer = null;
  }

  /**
   * Chat transcripts (only when "Also save chat transcripts" is on): one Markdown file per conversation under
   * chats/<YYYY-MM-DD>/<assistant>-<session>.md, rewritten with the full transcript each turn and committed in
   * batches at most once a minute. One-way: the server never reads chats back. Customer data, so off by default.
   */
  queueChat(entry) {
    if (!this.configured || !this.settings.syncChats) return;
    const day = String(entry.t || new Date().toISOString()).slice(0, 10);
    const assistant = String(entry.assistant || entry.site || 'unknown').replace(/[^a-z0-9-_]/gi, '').slice(0, 64) || 'unknown';
    const conversation = String(entry.sessionId ?? entry.conversation ?? entry.requestId).replace(/[^A-Za-z0-9-_]/g, '').slice(0, 64);
    const path = `chats/${day}/${assistant}-${entry.channel || 'chat'}-${conversation}.md`;
    const who = entry.visitor || 'Visitor';
    const lines = [
      `# ${assistant} · ${entry.channel || 'chat'} · ${entry.sessionId != null ? `session ${entry.sessionId}` : conversation}`,
      '',
      `- Customer: ${who}`,
      `- Updated: ${entry.t || new Date().toISOString()}`,
      `- Model: ${entry.model || ''}${entry.routedFrom ? ` · routed from ${entry.routedFrom}` : ''}`,
      '',
      '---',
      ''
    ];
    for (const m of entry.transcript) {
      const role = m.role === 'user' ? who : m.role === 'assistant' ? 'Assistant' : `Tool${m.name ? ` (${m.name})` : ''}`;
      lines.push(`**${role}:**`, '', String(m.content || '').trim(), '');
    }
    this.chats.set(path, lines.join('\n'));
    if (!this.chatTimer) this.chatTimer = setTimeout(() => { this.chatTimer = null; this.serial(() => this.pushChats()); }, 60_000);
  }

  async pushChats() {
    if (!this.chats.size) return;
    const batch = new Map(this.chats);
    this.chats.clear();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let snap = await this.snapshot();
      if (!snap) { await this.initialize(); snap = await this.snapshot(); }
      const changes = [...batch].filter(([path, text]) => snap.files[path] !== blobSha(text)).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }));
      if (!changes.length) return;
      const tree = await this.api('POST', '/git/trees', { base_tree: snap.treeSha, tree: changes });
      const commit = await this.api('POST', '/git/commits', { message: `Chat transcripts (${changes.length}) ${COMMIT_MARK}`, tree: tree.sha, parents: [snap.commitSha] });
      try { await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(this.settings.branch)}`, { sha: commit.sha }); }
      catch (error) { if (error.status === 422 && attempt === 0) continue; throw error; }
      this.status.lastChats = { at: new Date().toISOString(), files: changes.length, commit: commit.sha.slice(0, 7) };
      return;
    }
  }

  get settings() { return this.store.githubSettings(); }
  get configured() { const s = this.settings; return Boolean(s.repo && s.token && s.branch); }

  async api(method, path, body) {
    const { repo, token } = this.settings;
    const response = await this.fetchFn(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ajmcp-server', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`github_${response.status}: ${String(data.message || 'request failed').slice(0, 160)}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /** Head commit and full file list ({ path: blobSha }) of the branch; null when the repo is still empty. */
  async snapshot() {
    const { branch } = this.settings;
    let ref;
    try { ref = await this.api('GET', `/git/ref/heads/${encodeURIComponent(branch)}`); }
    catch (error) { if (error.status === 404 || error.status === 409) return null; throw error; }
    const commit = await this.api('GET', `/git/commits/${ref.object.sha}`);
    const tree = await this.api('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('github_tree_truncated');
    const files = {};
    for (const entry of tree.tree || []) if (entry.type === 'blob') files[entry.path] = entry.sha;
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha, files };
  }

  /** An empty repo has no branch yet; the Contents API can create the first commit (the README). */
  async initialize() {
    const { branch } = this.settings;
    await this.api('PUT', '/contents/README.md', { message: `Initialize AJMCP assistants ${COMMIT_MARK}`, content: Buffer.from(README).toString('base64'), branch });
  }

  /** Queue a push for assistants whose package changed (called by the store after every save). */
  queuePush(ids, reason = 'save') {
    if (!this.configured || !this.settings.pushOnSave) return;
    for (const id of ids) this.pending.set(id, reason);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const batch = new Map(this.pending);
      this.pending.clear();
      this.serial(() => this.push([...batch.keys()], [...new Set(batch.values())].join(', ')));
    }, 3000);
  }

  serial(task) {
    this.busy = this.busy.then(task).catch((error) => { this.status.lastError = String(error.message || error); this.log('github_sync_error', this.status.lastError); });
    return this.busy;
  }

  /** Commit the given assistants' folders (all when ids is empty). Returns { committed, files }. */
  async push(ids = [], reason = 'push') {
    if (!this.configured) throw new Error('github_not_configured');
    const sites = this.store.sites().filter((s) => !ids.length || ids.includes(s.id));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let snap = await this.snapshot();
      if (!snap) { await this.initialize(); snap = await this.snapshot(); }
      const changes = [];
      for (const site of sites) {
        const desired = {};
        for (const [name, text] of Object.entries(siteToPackage(site))) desired[`${site.id}/${name}`] = text;
        for (const [path, text] of Object.entries(desired)) {
          if (snap.files[path] !== blobSha(text)) changes.push({ path, mode: '100644', type: 'blob', content: text });
        }
        for (const path of Object.keys(snap.files)) {
          if (path.startsWith(`${site.id}/`) && !(path in desired)) changes.push({ path, mode: '100644', type: 'blob', sha: null });
        }
      }
      if (!changes.length) { this.status.lastPush = { at: new Date().toISOString(), committed: false, assistants: sites.map((s) => s.id) }; return { committed: false, files: 0 }; }
      const tree = await this.api('POST', '/git/trees', { base_tree: snap.treeSha, tree: changes });
      const names = sites.length > 3 ? `${sites.length} assistants` : sites.map((s) => s.id).join(', ');
      const commit = await this.api('POST', '/git/commits', { message: `Update ${names} (${reason}) ${COMMIT_MARK}`, tree: tree.sha, parents: [snap.commitSha] });
      try {
        await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(this.settings.branch)}`, { sha: commit.sha });
      } catch (error) {
        if (error.status === 422 && attempt === 0) continue;   // someone pushed meanwhile: rebuild on the new head once
        throw error;
      }
      this.status.lastPush = { at: new Date().toISOString(), committed: true, commit: commit.sha.slice(0, 7), files: changes.length, assistants: sites.map((s) => s.id) };
      this.status.lastError = '';
      return { committed: true, files: changes.length, commit: commit.sha };
    }
    throw new Error('github_push_conflict');
  }

  /** Recent version tags, newest first: [{ name, commit, url }]. */
  async listTags() {
    if (!this.configured) throw new Error('github_not_configured');
    const tags = await this.api('GET', '/tags?per_page=50');
    return (tags || []).map((t) => ({ name: t.name, commit: String(t.commit?.sha || '').slice(0, 7), url: `https://github.com/${this.settings.repo}/tree/${encodeURIComponent(t.name)}` }));
  }

  /**
   * Tags the current head of the branch as a version (annotated tag with a message). Any assistant changes still
   * waiting for their debounced commit are pushed first, so the tag includes them.
   */
  async createTag(name, message = '') {
    if (!this.configured) throw new Error('github_not_configured');
    const tag = String(name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(tag) || tag.includes('..') || tag.endsWith('.lock') || tag.endsWith('/')) throw new Error('invalid_tag_name');
    if (this.pending.size) {
      clearTimeout(this.timer);
      const batch = new Map(this.pending);
      this.pending.clear();
      await this.push([...batch.keys()], 'before tag');
    }
    const snap = await this.snapshot();
    if (!snap) throw new Error('github_repo_empty');
    const note = String(message || '').trim().slice(0, 2000) || `Version ${tag}`;
    const object = await this.api('POST', '/git/tags', { tag, message: note, object: snap.commitSha, type: 'commit' });
    try {
      await this.api('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha: object.sha });
    } catch (error) {
      if (error.status === 422) throw new Error('tag_exists');
      throw error;
    }
    return { name: tag, commit: snap.commitSha.slice(0, 7), url: `https://github.com/${this.settings.repo}/tree/${encodeURIComponent(tag)}` };
  }

  /** Import the given folders from GitHub (all folders when ids is empty). Only differing folders are applied. */
  async pull(ids = []) {
    if (!this.configured) throw new Error('github_not_configured');
    const snap = await this.snapshot();
    if (!snap) return { imported: [], unchanged: [], rejected: [], unknown: [] };
    const folders = {};
    for (const [path, sha] of Object.entries(snap.files)) {
      const slash = path.indexOf('/');
      if (slash < 1 || path.indexOf('/', slash + 1) !== -1) continue;   // only <id>/<file>
      const id = path.slice(0, slash);
      if (ids.length && !ids.includes(id)) continue;
      (folders[id] ||= {})[path.slice(slash + 1)] = sha;
    }
    const sites = new Map(this.store.sites().map((s) => [s.id, s]));
    const result = { imported: [], unchanged: [], rejected: [], unknown: [] };
    for (const [id, files] of Object.entries(folders)) {
      const site = sites.get(id);
      if (!site) { result.unknown.push(id); continue; }
      const current = siteToPackage(site);
      const same = Object.keys(files).length === Object.keys(current).length && Object.entries(files).every(([name, sha]) => current[name] !== undefined && blobSha(current[name]) === sha);
      if (same) { result.unchanged.push(id); continue; }
      const contents = {};
      for (const [name, sha] of Object.entries(files)) {
        const blob = await this.api('GET', `/git/blobs/${sha}`);
        contents[name] = Buffer.from(String(blob.content || ''), 'base64').toString('utf8');
      }
      const parsed = parsePackage(contents);
      try {
        // The folder is the whole assistant: knowledge is always the complete manual set (possibly empty).
        this.store.importPackage(id, { fields: pickFields(parsed.fields), knowledge: parsed.knowledge }, { source: 'github' });
        result.imported.push(id);
      } catch (error) {
        result.rejected.push({ id, error: String(error.code || error.message) });
      }
    }
    this.status.lastPull = { at: new Date().toISOString(), ...result };
    this.status.unknownFolders = result.unknown;
    this.status.rejected = result.rejected;
    if (!result.rejected.length) this.status.lastError = '';
    return result;
  }

  /** GitHub push webhook: verify the signature, skip our own commits, pull the touched folders. */
  handleWebhook(headers, raw) {
    const { webhookSecret, branch, pullOnWebhook } = this.settings;
    if (!this.configured || !webhookSecret) return { status: 404, body: { error: 'not_configured' } };
    const given = String(headers['x-hub-signature-256'] || '');
    const expected = 'sha256=' + createHmac('sha256', webhookSecret).update(raw).digest('hex');
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return { status: 401, body: { error: 'bad_signature' } };
    const event = String(headers['x-github-event'] || '');
    if (event === 'ping') return { status: 200, body: { ok: true } };
    if (event !== 'push') return { status: 202, body: { ignored: event } };
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
    if (payload.ref !== `refs/heads/${branch}`) return { status: 202, body: { ignored: 'other_branch' } };
    if (!pullOnWebhook) return { status: 202, body: { ignored: 'pull_disabled' } };
    const commits = (payload.commits || []).filter((c) => !String(c.message || '').includes(COMMIT_MARK));
    if (!commits.length) return { status: 202, body: { ignored: 'own_commit' } };
    const ids = new Set();
    for (const c of commits) for (const p of [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]) { const s = p.indexOf('/'); if (s > 0) ids.add(p.slice(0, s)); }
    if (!ids.size) return { status: 202, body: { ignored: 'no_assistant_folders' } };
    this.serial(() => this.pull([...ids]));
    return { status: 202, body: { pulling: [...ids] } };
  }
}

const EDITABLE = ['name', 'systemPrompt', 'routeLabel', 'leadCapture', 'leadInstructions', 'fallback', 'strict', 'transferTargets', 'tests'];
function pickFields(fields) { return Object.fromEntries(EDITABLE.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]])); }

export const newWebhookSecret = () => randomBytes(24).toString('hex');
