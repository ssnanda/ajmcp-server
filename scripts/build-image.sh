#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENGINE="${CONTAINER_ENGINE:-podman}"
TAG="${1:-ajmcp-server:0.1.0}"
CODEX_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).codex")"
CLAUDE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).claude")"
COPILOT_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).copilot")"
FREEBUFF_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).freebuff")"
"$ENGINE" build -f Containerfile -t "$TAG" \
  --build-arg "CODEX_VERSION=$CODEX_VERSION" \
  --build-arg "CLAUDE_VERSION=$CLAUDE_VERSION" \
  --build-arg "COPILOT_VERSION=$COPILOT_VERSION" \
  --build-arg "FREEBUFF_VERSION=$FREEBUFF_VERSION" .
echo "Built $TAG with Codex $CODEX_VERSION, Claude $CLAUDE_VERSION, Copilot $COPILOT_VERSION, and Freebuff $FREEBUFF_VERSION"
