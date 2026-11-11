import { readFileSync } from 'node:fs';

// One source of truth: match the package.json version used by bin/2-bump-version.sh.
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
