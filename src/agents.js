import { spawn, execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

function toolEnv(config, provider) {
  // Explicit allowlist: never pass SITES_JSON, ADMIN_TOKEN, or other application secrets.
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/data/home',
    LANG: 'C.UTF-8', TERM: 'dumb', CI: 'true',
    DISABLE_AUTOUPDATER: '1'
  };
  if (provider === 'codex' && config.openaiApiKey) env.OPENAI_API_KEY = config.openaiApiKey;
  if (provider === 'claude' && config.anthropicApiKey) env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  return env;
}

export function runAgent(provider, prompt, config, spawnFn = spawn) {
  if (!config.enableAgentJobs) throw Object.assign(new Error('agent_jobs_disabled'), { status: 403 });
  if (!['codex', 'claude'].includes(provider)) throw Object.assign(new Error('unknown_agent'), { status: 400 });
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 4000) {
    throw Object.assign(new Error('invalid_prompt'), { status: 400 });
  }
  if (provider === 'codex' && !config.openaiApiKey || provider === 'claude' && !config.anthropicApiKey) {
    throw Object.assign(new Error('agent_provider_not_configured'), { status: 503 });
  }
  try { accessSync(config.agentWorkspace, constants.R_OK); }
  catch { throw Object.assign(new Error('agent_workspace_unavailable'), { status: 503 }); }
  const file = provider === 'codex' ? 'codex' : 'claude';
  const args = provider === 'codex'
    ? ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]
    : ['-p', prompt, '--output-format', 'text', '--tools', '', '--no-session-persistence'];

  return new Promise((resolve, reject) => {
    const child = spawnFn(file, args, {
      shell: false, cwd: config.agentWorkspace,
      env: toolEnv(config, provider), stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, config.agentTimeoutMs);
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 65536) { exceeded = true; child.kill('SIGKILL'); }
    });
    // Do not log or return stderr; agent tools can put private content there.
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('agent_unavailable'), { status: 503 })); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('agent_timeout'), { status: 504 }));
      if (exceeded) return reject(Object.assign(new Error('agent_output_too_large'), { status: 502 }));
      if (code !== 0) return reject(Object.assign(new Error('agent_failed'), { status: 502 }));
      if (!stdout.trim()) return reject(Object.assign(new Error('agent_empty_output'), { status: 502 }));
      resolve({ provider, text: stdout.trim() });
    });
  });
}

function fixedVersion(binary) {
  return new Promise(resolve => {
    execFile(binary, ['--version'], { timeout: 5000, maxBuffer: 4096, shell: false }, (err, stdout) => {
      resolve(err ? 'unavailable' : String(stdout).trim().slice(0, 120));
    });
  });
}

export async function installedToolVersions() {
  const [codex, claude] = await Promise.all([fixedVersion('codex'), fixedVersion('claude')]);
  return { codex, claude };
}
