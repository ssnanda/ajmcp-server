#!/usr/bin/env bash
# Synchronize local main with GitHub (for changes made directly on GitHub, e.g. by ChatGPT).
# Usage: ./bin/1-pull-latest.sh [-f|--force] [--dry-run] [--help]
#   -f, --force    Discard local tracked edits/commits and untracked files (ignored files kept).
#   --dry-run      Fetch and report an available update without applying it.
#   -h, --help     Show this help.
# Never pushes, builds or deploys; pulling does not start any GitHub workflow.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
FORCE=0
usage() {
  cat <<'HELP'
Usage: ./bin/1-pull-latest.sh [-f|--force] [--dry-run] [--help]
Fetch source from ssnanda/ajmcp-server and rebase onto origin/main.
Normal updates preserve local commits and edits.
-f / --force resets to GitHub main, deleting local commits and untracked files.
Ignored folders and local configuration (.env.local, sites.json) are preserved. Never pushes or deploys.
HELP
}
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    -f|--force) FORCE=1 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$ROOT"
command -v git >/dev/null || { echo 'Git is required.' >&2; exit 1; }
[[ "$(git rev-parse --show-toplevel 2>/dev/null)" == "$ROOT" ]] || { echo 'Not the AJMCP checkout.' >&2; exit 1; }
origin="$(git remote get-url origin)"
case "$origin" in
  https://github.com/ssnanda/ajmcp-server|https://github.com/ssnanda/ajmcp-server.git|git@github.com:ssnanda/ajmcp-server.git|ssh://git@github.com/ssnanda/ajmcp-server.git) ;;
  *) echo "Unexpected origin: $origin" >&2; exit 1 ;;
esac
[[ "$(git branch --show-current)" == main ]] || { echo 'Switch to main first.' >&2; exit 1; }
[[ -z "$(git ls-files -u)" ]] || { echo 'Resolve merge conflicts first.' >&2; exit 1; }
[[ ! -d "$(git rev-parse --git-path rebase-merge)" && ! -d "$(git rev-parse --git-path rebase-apply)" && ! -f "$(git rev-parse --git-path MERGE_HEAD)" ]] || { echo 'Finish pending rebase/merge first.' >&2; exit 1; }
version() { git show "$1:package.json" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version" 2>/dev/null || echo unknown; }
local_version() { node -p "require('./package.json').version" 2>/dev/null || echo unknown; }
echo '===== CHECKING GITHUB ====='
printf 'Local:  %s (%s)\n' "$(local_version)" "$(git rev-parse --short HEAD)"
git fetch --no-tags origin main
printf 'GitHub: %s (%s)\n' "$(version FETCH_HEAD)" "$(git rev-parse --short FETCH_HEAD)"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse FETCH_HEAD)"
if (( FORCE && ! DRY_RUN )); then
  echo '===== FORCE RESET TO GITHUB MAIN ====='
  git reset --hard "$remote_sha"
  git clean -fd
  printf '===== LOCAL SOURCE MATCHES GITHUB: %s =====\n' "$(local_version)"
  exit 0
fi
if [[ "$local_sha" == "$remote_sha" ]]; then
  echo '===== ALREADY LATEST ====='
  git status --short
  exit 0
fi
if git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
  echo '===== GITHUB ALREADY INCLUDED; LOCAL COMMITS RETAINED ====='
  exit 0
fi
if (( DRY_RUN )); then
  echo '===== UPDATE AVAILABLE (DRY RUN: NO FILES CHANGED) ====='
  git log --oneline HEAD..FETCH_HEAD
  git diff --stat HEAD...FETCH_HEAD
  exit 0
fi
stash_ref=''
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  before="$(git rev-parse -q --verify refs/stash 2>/dev/null || true)"
  git stash push --include-untracked -m "ajmcp-pull-$(date +%Y%m%d%H%M%S)" >/dev/null
  stash_ref="$(git rev-parse -q --verify refs/stash 2>/dev/null || true)"
  [[ -n "$stash_ref" && "$stash_ref" != "$before" ]] || { echo 'Could not verify saved local edits; stop.' >&2; exit 1; }
fi
echo '===== UPDATING SOURCE ====='
if ! git -c rebase.autoStash=false rebase "$remote_sha"; then
  git rebase --abort >/dev/null 2>&1 || true
  if [[ -n "$stash_ref" ]]; then
    git stash apply --index "$stash_ref" || echo "Local edits remain in stash $stash_ref" >&2
  fi
  echo 'Update conflicted; rebase aborted. Resolve locally before retrying.' >&2
  exit 1
fi
if [[ -n "$stash_ref" ]]; then
  if ! git stash apply --index "$stash_ref"; then
    echo "Restoring local edits conflicted. Original stash preserved: $stash_ref" >&2
    exit 1
  fi
  stash_label="$(git stash list --format='%gd %H' | awk -v sha="$stash_ref" '$2==sha {print $1; exit}')"
  [[ -z "$stash_label" ]] || git stash drop "$stash_label" >/dev/null
fi
printf '===== UPDATE COMPLETE: %s =====\n' "$(local_version)"
git status --short
echo 'Nothing was built or deployed.'
