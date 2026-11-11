#!/usr/bin/env bash
# AJMCP version bump, commit and optional push, matching AJ Ops' release style.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" != "" && "${1:-}" != "--if-dirty" ]]; then
  echo "Usage: ./bin/bump.sh [--if-dirty]" >&2; exit 2
fi
if [[ ! -d .git ]]; then
  if [[ "${1:-}" == "--if-dirty" ]]; then echo "No Git checkout; no bump."; exit 0; fi
  echo "ERROR: Clone with Git before using bump.sh" >&2; exit 1
fi
if [[ "${1:-}" == "--if-dirty" && -z "$(git status --porcelain)" ]]; then
  echo "Working tree clean; no bump."
  exit 0
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js required." >&2; exit 1; }
CURRENT="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
[[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "ERROR: Expected X.Y.Z version." >&2; exit 1; }
MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"
echo ""
echo "AJMCP version: $CURRENT"
echo "  1) Patch  $MAJOR.$MINOR.$((PATCH+1)) [default]"
echo "  2) Minor  $MAJOR.$((MINOR+1)).0"
echo "  3) Major  $((MAJOR+1)).0.0"
echo "  4) Custom"
echo "  5) No bump (commit only)"
read -r -p "Choose [1-5, Enter=patch]: " CHOICE
CHOICE="${CHOICE:-1}"
case "$CHOICE" in
  1) NEXT="$MAJOR.$MINOR.$((PATCH+1))" ;;
  2) NEXT="$MAJOR.$((MINOR+1)).0" ;;
  3) NEXT="$((MAJOR+1)).0.0" ;;
  4) read -r -p "New version X.Y.Z: " NEXT ;;
  5) NEXT="$CURRENT" ;;
  *) echo "ERROR: Invalid choice" >&2; exit 2 ;;
esac
[[ "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ERROR: Invalid version" >&2; exit 2; }
if [[ "$NEXT" != "$CURRENT" ]]; then
  NEXT_VERSION="$NEXT" node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = process.env.NEXT_VERSION;
fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\n');
NODE
fi
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  if [[ "$NEXT" != "$CURRENT" ]]; then
    git commit -m "chore: bump AJMCP to v$NEXT"
  else
    read -r -p "Commit message [chore: update AJMCP]: " MESSAGE
    git commit -m "${MESSAGE:-chore: update AJMCP}"
  fi
else
  echo "Nothing to commit."
fi
if git remote get-url origin >/dev/null 2>&1; then
  read -r -p "Push to GitHub? [Y/n]: " PUSH
  if [[ "${PUSH:-Y}" =~ ^([Yy]|[Yy][Ee][Ss])$ ]]; then git push -u origin HEAD; fi
fi
echo "AJMCP version: $NEXT"
