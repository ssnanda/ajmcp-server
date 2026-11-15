import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { applyMaster, agentProviderFor, masterOf } from '../src/master.js';
import { runAgent } from '../src/agents.js';
import { SettingsStore } from '../src/store.js';

const site = { id: 'a', provider: 'anthropic', model: 'claude-sonnet-5-5' };

test('master off leaves the site as it is', () => {
  assert.equal(applyMaster(site, {}), site);
  assert.equal(applyMaster(site, { master: { provider: '', models: {} } }), site);
});

test('master on replaces provider and model for every site', () => {
  const eff = applyMaster(site, { master: { provider: 'codex', models: { codex: 'gpt-x' } } });
  assert.equal(eff.provider, 'codex-cli');
  assert.equal(eff.model, 'gpt-x');
  assert.equal(eff.masterApplied, true);
  assert.equal(applyMaster(site, { master: { provider: 'antigravity', models: {} } }).provider, 'antigravity-cli');
  assert.equal(applyMaster(site, { master: { provider: 'antigravity', models: {} } }).model, ''); // a Claude model id never carries over
  assert.equal(site.provider, 'anthropic'); // the site itself is not changed
});

test('an unknown master provider is ignored', () => {
  assert.equal(masterOf({ master: { provider: 'nope', models: {} } }).provider, '');
});

test('agent jobs follow the master switch', () => {
  assert.equal(agentProviderFor('claude', { master: { provider: 'codex' } }), 'codex');
  assert.equal(agentProviderFor('claude', {}), 'claude');
});

test('runAgent runs Antigravity headless with the master model and no API key', async () => {
  let call;
  const spawnFn = (file, args, opts) => {
    call = { file, args, opts };
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = { resume() {} }; child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from('done')); child.emit('close', 0); });
    return child;
  };
  const config = { enableAgentJobs: true, agentWorkspace: '/tmp', agentTimeoutMs: 5000, openaiApiKey: 'k', anthropicApiKey: 'k', dataDir: '', master: { provider: 'antigravity', models: { antigravity: 'gemini-test' } } };
  const result = await runAgent('claude', 'hello', config, spawnFn);
  assert.equal(result.provider, 'antigravity');
  assert.equal(call.file, 'agy');
  assert.deepEqual(call.args, ['--output-format', 'text', '--sandbox', '--model', 'gemini-test', '-p', 'hello']);
  assert.equal(call.opts.env.OPENAI_API_KEY, undefined);
  assert.equal(call.opts.env.ANTHROPIC_API_KEY, undefined);
});

test('the master setting is validated and saved', () => {
  const config = { dataDir: '', sites: [], master: { provider: '', models: {} }, openaiApiKey: '', anthropicApiKey: '', claudeOauthToken: '', adminPasswordHash: '' };
  const store = new SettingsStore(config);
  assert.throws(() => store.setMaster({ provider: 'bing' }), /invalid_master_provider/);
});
