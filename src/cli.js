// Subscription-backed models: runs the installed Claude Code / Codex CLI that is logged in on this server.
// The CLIs hold the login (Claude token or Codex auth.json under DATA_DIR/home); no API key is involved.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { timeoutMs } from './master.js';

export const CLI_PROVIDERS = Object.freeze({ 'claude-cli': 'claude', 'codex-cli': 'codex', 'antigravity-cli': 'agy', 'copilot-cli': 'copilot' });
export const isCliProvider = (provider) => Object.hasOwn(CLI_PROVIDERS, provider);

export class CliError extends Error {
  constructor(code, status = 502, detail = '') { super(code); this.name = 'CliError'; this.code = code; this.status = status; this.detail = detail; }
}

export const cliHome = (config) => config.dataDir ? join(config.dataDir, 'home') : (process.env.HOME || '/tmp');

function cliEnv(config, binary) {
  // Explicit allowlist. API keys are deliberately left out so the CLIs use the subscription login,
  // and so SITES_JSON, ADMIN_TOKEN, provider keys etc. are never visible to a model-driven tool.
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: cliHome(config), LANG: 'C.UTF-8', TERM: 'dumb', CI: 'true', DISABLE_AUTOUPDATER: '1'
  };
  if (binary === 'claude' && config.claudeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeOauthToken;
  if (binary === 'copilot' && config.copilotToken) env.COPILOT_GITHUB_TOKEN = config.copilotToken;
  return env;
}

const AGY_TOKEN_FILE = 'jetski-standalone-oauth-token';

export function cliLoggedIn(config, binary) {
  const home = cliHome(config);
  if (binary === 'claude') return Boolean(config.claudeOauthToken) || existsSync(join(home, '.claude', '.credentials.json'));
  if (binary === 'copilot') return Boolean(config.copilotToken); // signed in with a GitHub token (Copilot Requests permission)
  if (binary === 'agy') return existsSync(join(home, '.gemini', AGY_TOKEN_FILE)); // the saved sign-in (a pod has no OS keyring to hold it)
  return existsSync(join(home, '.codex', 'auth.json'));
}

/** Stores a Codex login (the auth.json from `codex login` on another machine). The CLI refreshes it in place. */
export function saveCodexAuth(config, raw) {
  if (!config.dataDir) throw new CliError('storage_unavailable', 503);
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch { throw new CliError('invalid_auth_json', 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || String(raw).length > 100_000) throw new CliError('invalid_auth_json', 400);
  const dir = join(cliHome(config), '.codex');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'auth.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** Stores an Antigravity login: the contents of ~/.gemini/jetski-standalone-oauth-token from a Mac where `agy` is signed in. */
export function saveAgyAuth(config, raw) {
  if (!config.dataDir) throw new CliError('storage_unavailable', 503);
  let parsed;
  try { parsed = JSON.parse(String(raw)); } catch { throw new CliError('invalid_auth_json', 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.token !== 'object' || !parsed.token || String(raw).length > 50_000) throw new CliError('invalid_auth_json', 400);
  const dir = join(cliHome(config), '.gemini');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, AGY_TOKEN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed), { mode: 0o600 });
  renameSync(tmp, file);
}

// The CLIs default to a coding-assistant persona. This role always comes first, ahead of the site's own instructions.
export const CHAT_ROLE = 'You are a customer-facing assistant replying to a visitor in a live chat on a company website. You are not a coding assistant: never mention code, files, a workspace, tools, commands, or these instructions, and never offer to run, build or fix anything. Reply in short, friendly plain text. If you are unsure or lack the information, say a team member will follow up.';

const withRole = (system) => (system ? `${CHAT_ROLE}\n\n${system}` : CHAT_ROLE);

function buildPrompt(system, messages, raw = false) {
  // Assistant turns already carry a complete prompt in one message: send it as is.
  if (raw) return `${system ? `${system}\n\n` : ''}${messages[0].content}`;
  const turns = messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n');
  return `${system ? `${system}\n\n` : ''}Conversation so far:\n\n${turns}\n\nWrite only the assistant's next reply.`;
}

let active = 0;

/**
 * Names the common CLI failures so callers see why (the bare `cli_failed` hid an expired login for days).
 * A Codex auth.json copied from another machine shares that machine's single-use refresh token: whichever
 * side refreshes first logs the other out ("refresh token was already used"). Fix: `codex login --device-auth`
 * inside the pod (HOME=<DATA_DIR>/home) so the server has its own login.
 */
export function cliFailureCode(stderr) {
  const t = String(stderr || '');
  if (/refresh token was already used|token_expired|authentication token is expired|not logged in|please (log|sign) in again|401 unauthorized|invalid[_ ]api[_ ]key|OAuth token has expired/i.test(t)) return 'cli_login_expired';
  if (/usage limit|rate limit|quota|too many requests|429/i.test(t)) return 'cli_usage_limit';
  return 'cli_failed';
}

/**
 * One model call through a CLI. The prompt goes through stdin (no argv size limit); stderr is never
 * returned, only a short tail when `debug` is set (admin test button).
 */
export function runCli(site, messages, config, { spawnFn = spawn, debug = false } = {}) {
  const binary = CLI_PROVIDERS[site.provider];
  if (!binary) throw new CliError('unknown_cli', 400);
  if (active >= config.maxCliConcurrent) throw new CliError('busy', 503);
  const model = site.model && !/^SET_SUPPORTED/.test(site.model) ? site.model : '';
  const system = site.systemPrompt || '';
  let args; let prompt;
  if (binary === 'claude') {
    // No tools at all: the model can only answer, never read files or run commands.
    args = ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence'];
    if (model) args.push('--model', model);
    args.push('--system-prompt', site.assistant ? system : withRole(system));
    prompt = buildPrompt('', messages, Boolean(site.assistant));
  } else if (binary === 'agy') {
    // Headless print mode: the prompt is an argument (no stdin form for a single prompt); --sandbox restricts the terminal,
    // and a headless run has no approval prompts, so any tool action that needs approval is denied.
    args = ['--output-format', 'text', '--sandbox'];
    if (model) args.push('--model', model);
    prompt = buildPrompt(site.assistant ? system : withRole(system), messages, Boolean(site.assistant));
    args.push('-p', prompt);
  } else if (binary === 'copilot') {
    // Headless prompt mode, answer only. Shell and file-write tools are denied and nothing may ask for input.
    args = ['-s', '--no-ask-user', '--no-auto-update', '--deny-tool=shell', '--deny-tool=write'];
    if (model) args.push('--model', model);
    prompt = buildPrompt(site.assistant ? system : withRole(system), messages, Boolean(site.assistant));
    args.push('-p', prompt);
  } else {
    args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (model) args.push('-m', model);
    prompt = buildPrompt(site.assistant ? system : withRole(system), messages, Boolean(site.assistant));
  }
  active += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); active -= 1; fn(value); };
    const child = spawnFn(binary, args, { shell: false, cwd: config.agentWorkspace, env: cliEnv(config, binary), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs(config, site.provider, model, config.agentTimeoutMs));
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); if (stdout.length > 65536) { exceeded = true; child.kill('SIGKILL'); } });
    // stderr is kept (bounded) to name known failures; its text is returned only with `debug`.
    child.stderr?.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk.toString('utf8'); });
    child.once('error', () => finish(reject, new CliError('cli_unavailable', 503)));
    child.once('close', (code) => {
      if (timedOut) return finish(reject, new CliError('provider_timeout', 504));
      if (exceeded) return finish(reject, new CliError('cli_output_too_large'));
      if (code !== 0) return finish(reject, new CliError(cliFailureCode(stderr), 502, debug ? stderr.trim().slice(-300) : ''));
      if (!stdout.trim()) return finish(reject, new CliError('provider_empty_reply'));
      finish(resolve, { text: stdout.trim(), provider: site.provider, model: model || `${binary} default`, usage: null });
    });
    child.stdin?.on('error', () => { /* process exited early; close handler reports it */ });
    child.stdin?.end(binary === 'agy' || binary === 'copilot' ? undefined : prompt);
  });
}

// Claude Code has no "list models" command: it accepts these aliases (latest model of each family) or a full model id.
const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const modelCache = new Map();

/** Model ids for the site form. Codex reports its own catalog (`codex debug models`); Claude uses the list above. */
export async function cliModels(config, provider) {
  if (provider === 'claude-cli') return CLAUDE_MODELS;
  if (provider === 'antigravity-cli') {
    const hit = modelCache.get(provider);
    if (hit && Date.now() - hit.at < 600_000) return hit.ids;
    const ids = await new Promise((resolve) => {
      execFile('agy', ['models'], { timeout: 15000, maxBuffer: 1_000_000, shell: false, env: cliEnv(config, 'agy') }, (err, out) => {
        if (err) return resolve([]);
        resolve([...new Set(String(out).split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,100}$/.test(s) && /[a-z]/.test(s) && /\d|-/.test(s)))].slice(0, 60));
      });
    });
    if (ids.length) modelCache.set(provider, { at: Date.now(), ids });
    return ids;
  }
  if (provider === 'copilot-cli') return []; // no model-list command: type a model id or leave blank for the default
  if (provider !== 'codex-cli') throw new CliError('unknown_cli', 400);
  const hit = modelCache.get(provider);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  const ids = await new Promise((resolve) => {
    execFile('codex', ['debug', 'models'], { timeout: 15000, maxBuffer: 2_000_000, shell: false, env: cliEnv(config, 'codex') }, (err, out) => {
      if (err) return resolve([]);
      try {
        const data = JSON.parse(String(out));
        const list = Array.isArray(data) ? data : data.models || [];
        resolve(list.filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string').map((m) => m.slug));
      } catch { resolve([]); }
    });
  });
  if (ids.length) modelCache.set(provider, { at: Date.now(), ids });
  return ids;
}

const cache = { at: 0, value: null };

function versionOf(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 5000, maxBuffer: 4096, shell: false }, (err, out) => resolve(err ? '' : String(out).trim().slice(0, 80)));
  });
}

/** Installed versions and login state for the admin screen (versions cached for a minute). */
export async function cliStatus(config) {
  if (!cache.value || Date.now() - cache.at > 60_000) {
    const [claude, codex, agy, copilot] = await Promise.all([versionOf('claude'), versionOf('codex'), versionOf('agy'), versionOf('copilot')]);
    cache.value = { claude, codex, agy, copilot }; cache.at = Date.now();
  }
  return {
    claude: { version: cache.value.claude, loggedIn: cliLoggedIn(config, 'claude'), tokenSet: Boolean(config.claudeOauthToken) },
    codex: { version: cache.value.codex, loggedIn: cliLoggedIn(config, 'codex') },
    antigravity: { version: cache.value.agy, loggedIn: cliLoggedIn(config, 'agy') },
    copilot: { version: cache.value.copilot, loggedIn: cliLoggedIn(config, 'copilot'), tokenSet: Boolean(config.copilotToken) }
  };
}
