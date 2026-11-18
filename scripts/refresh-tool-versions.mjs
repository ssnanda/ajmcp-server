import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const TOOL_PACKAGES = Object.freeze({
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  copilot: '@github/copilot',
  freebuff: 'freebuff'
});

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const parts = (version) => version.split('.').map(Number);

export function compareVersions(a, b) {
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export async function resolveLatest(fetchFn = fetch) {
  const entries = await Promise.all(Object.entries(TOOL_PACKAGES).map(async ([tool, packageName]) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    let response;
    try { response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new Error(`Cannot check ${tool}: ${error.message}`); }
    if (!response.ok) throw new Error(`Cannot check ${tool}: npm returned HTTP ${response.status}`);
    const data = await response.json().catch(() => null);
    if (!data || typeof data.version !== 'string' || !VERSION_RE.test(data.version)) throw new Error(`Cannot check ${tool}: npm returned an invalid stable version`);
    return [tool, data.version];
  }));
  return Object.fromEntries(entries);
}

export async function refreshToolVersions({ path = new URL('../tool-versions.json', import.meta.url), fetchFn = fetch, write = true } = {}) {
  const current = JSON.parse(readFileSync(path, 'utf8'));
  for (const tool of Object.keys(TOOL_PACKAGES)) {
    if (typeof current[tool] !== 'string' || !VERSION_RE.test(current[tool])) throw new Error(`Invalid pinned ${tool} version`);
  }
  const latest = await resolveLatest(fetchFn); // resolve everything before writing anything
  const next = { ...current }; const updates = [];
  for (const tool of Object.keys(TOOL_PACKAGES)) {
    if (compareVersions(latest[tool], current[tool]) > 0) {
      updates.push({ tool, from: current[tool], to: latest[tool] });
      next[tool] = latest[tool];
    }
  }
  if (write && updates.length) {
    const tmp = `${fileURLToPath(path)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, fileURLToPath(path));
  }
  return { versions: next, updates };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const result = await refreshToolVersions({ write: !dryRun });
  if (!result.updates.length) console.log('AI provider CLIs are already pinned to the latest stable npm versions.');
  for (const update of result.updates) console.log(`${dryRun ? 'Would update' : 'Updated'} ${update.tool}: ${update.from} -> ${update.to}`);
}
