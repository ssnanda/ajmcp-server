import { readFileSync } from 'node:fs';
const x = JSON.parse(readFileSync(new URL('../tool-versions.json', import.meta.url), 'utf8'));
console.log(`Codex CLI: ${x.codex}\nClaude Code CLI: ${x.claude}`);
