import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const tool = args[args.indexOf('--tool') + 1];
let version = args.includes('--version') ? args[args.indexOf('--version') + 1] : '';
const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
if (!packages[tool]) throw new Error('Usage: npm run tools:update -- --tool codex|claude [--version x.y.z]');
if (!version) version = execFileSync('npm', ['view', packages[tool], 'version'], { encoding: 'utf8', timeout: 30000 }).trim();
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid version');
const path = new URL('../tool-versions.json', import.meta.url);
const versions = JSON.parse(readFileSync(path, 'utf8'));
if (versions[tool] === version) {
  console.log(`${tool} already pinned at ${version}`);
} else {
  versions[tool] = version;
  writeFileSync(path, `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`Pinned ${tool} to ${version} (other tools unchanged)`);
}
