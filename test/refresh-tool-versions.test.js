import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, refreshToolVersions } from '../scripts/refresh-tool-versions.mjs';

test('numeric version comparison does not use lexicographic ordering', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('2.1.3', '2.1.3'), 0);
});

test('refresh updates only newer versions and writes once all lookups succeed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajmcp-versions-'));
  const file = join(dir, 'tool-versions.json');
  writeFileSync(file, JSON.stringify({ codex: '1.0.0', claude: '2.0.0', copilot: '3.0.0', freebuff: '4.0.0' }));
  const found = { codex: '1.1.0', claude: '1.9.0', copilot: '3.0.0', freebuff: '4.0.1' };
  const fetchFn = async (url) => ({ ok: true, json: async () => ({ version: found[url.includes('codex') ? 'codex' : url.includes('claude') ? 'claude' : url.includes('copilot') ? 'copilot' : 'freebuff'] }) });
  const result = await refreshToolVersions({ path: pathToFileURL(file), fetchFn });
  assert.deepEqual(result.updates, [{ tool: 'codex', from: '1.0.0', to: '1.1.0' }, { tool: 'freebuff', from: '4.0.0', to: '4.0.1' }]);
  assert.deepEqual(JSON.parse(readFileSync(file)), { codex: '1.1.0', claude: '2.0.0', copilot: '3.0.0', freebuff: '4.0.1' });
});

test('failed lookup leaves every pin unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajmcp-versions-'));
  const file = join(dir, 'tool-versions.json');
  const original = JSON.stringify({ codex: '1.0.0', claude: '2.0.0', copilot: '3.0.0', freebuff: '4.0.0' });
  writeFileSync(file, original);
  await assert.rejects(refreshToolVersions({ path: pathToFileURL(file), fetchFn: async () => { throw new Error('offline'); } }), /Cannot check/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('dry run reports updates without writing them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ajmcp-versions-'));
  const file = join(dir, 'tool-versions.json');
  const original = JSON.stringify({ codex: '1.0.0', claude: '2.0.0', copilot: '3.0.0', freebuff: '4.0.0' });
  writeFileSync(file, original);
  const fetchFn = async () => ({ ok: true, json: async () => ({ version: '9.0.0' }) });
  const result = await refreshToolVersions({ path: pathToFileURL(file), fetchFn, write: false });
  assert.equal(result.updates.length, 4);
  assert.equal(readFileSync(file, 'utf8'), original);
});
