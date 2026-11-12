import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { runCli, saveCodexAuth, cliLoggedIn, CliError } from '../src/cli.js';

const dir = mkdtempSync(join(tmpdir(), 'ajmcp-cli-'));
const config = loadConfig({ DATA_DIR: dir, OPENAI_API_KEY: 'sk-secret-openai-key-123456', ANTHROPIC_API_KEY: 'sk-ant-secret-key-1234567', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-abcdefghijklmnopqrstuvwxyz', ADMIN_TOKEN: 'z'.repeat(40) });

function fakeSpawn({ out = 'Hello there', code = 0 } = {}) {
  const calls = [];
  const fn = (file, args, options) => {
    const child = new EventEmitter();
    let written = '';
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: (text) => { written = text; setImmediate(() => { child.stdout.emit('data', Buffer.from(out)); child.emit('close', code); }); }, on() {} };
    child.kill = () => {};
    calls.push({ file, args, options, get stdin() { return written; } });
    return child;
  };
  return { fn, calls };
}

test('claude CLI: tool-less, subscription token only, prompt via stdin', async () => {
  const { fn, calls } = fakeSpawn();
  const site = { provider: 'claude-cli', model: '', systemPrompt: 'Be brief.' };
  const reply = await runCli(site, [{ role: 'user', content: 'Hi' }], config, { spawnFn: fn });
  assert.equal(reply.text, 'Hello there');
  const [call] = calls;
  assert.equal(call.file, 'claude');
  assert.ok(call.args.includes('--tools') && call.args[call.args.indexOf('--tools') + 1] === '');
  assert.ok(call.args.includes('--system-prompt'));
  assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /not a coding assistant[\s\S]*Be brief\./);
  assert.equal(call.args.some((a) => a.includes('Hi')), false, 'conversation must not be in argv');
  assert.match(call.stdin, /User: Hi/);
  assert.equal(call.options.env.CLAUDE_CODE_OAUTH_TOKEN, config.claudeOauthToken);
  const envText = JSON.stringify(call.options.env);
  assert.equal(/sk-secret-openai|sk-ant-secret|z{40}/.test(envText), false, 'no API keys or admin token in CLI env');
  assert.equal(call.options.env.HOME, join(dir, 'home'));
});

test('codex CLI: read-only ephemeral exec, system prompt folded into stdin', async () => {
  const { fn, calls } = fakeSpawn();
  await runCli({ provider: 'codex-cli', model: 'some-model', systemPrompt: 'Be brief.' }, [{ role: 'user', content: 'Hi' }], config, { spawnFn: fn });
  const [call] = calls;
  assert.equal(call.file, 'codex');
  assert.deepEqual(call.args.slice(0, 3), ['exec', '--ephemeral', '--sandbox']);
  assert.ok(call.args.includes('read-only') && call.args.includes('-m'));
  assert.match(call.stdin, /not a coding assistant[\s\S]*Be brief\.[\s\S]*User: Hi/);
  assert.equal(call.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('CLI failures become safe error codes', async () => {
  const { fn } = fakeSpawn({ code: 1 });
  await assert.rejects(runCli({ provider: 'codex-cli' }, [{ role: 'user', content: 'x' }], config, { spawnFn: fn }), (e) => e instanceof CliError && e.code === 'cli_failed' && e.detail === '');
  const empty = fakeSpawn({ out: '  ' });
  await assert.rejects(runCli({ provider: 'claude-cli' }, [{ role: 'user', content: 'x' }], config, { spawnFn: empty.fn }), (e) => e.code === 'provider_empty_reply');
});

test('codex auth.json is validated and stored privately', () => {
  assert.equal(cliLoggedIn(config, 'codex'), false);
  assert.throws(() => saveCodexAuth(config, 'not json'), (e) => e.code === 'invalid_auth_json');
  saveCodexAuth(config, JSON.stringify({ tokens: { access_token: 'a' } }));
  const file = join(dir, 'home', '.codex', 'auth.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).tokens.access_token, 'a');
  assert.equal(cliLoggedIn(config, 'codex'), true);
});
