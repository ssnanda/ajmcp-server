# node-pty is native; compile it in a disposable stage so build tools do not remain in production.
FROM node:22-bookworm-slim AS app-deps
WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Version each CLI independently via build arguments. All are installed in one runtime image.
FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.167.1
ARG CLAUDE_VERSION=2.1.322
ARG COPILOT_VERSION=1.0.112
ARG FREEBUFF_VERSION=0.2.36
# Google Antigravity CLI (agy). Installed by default; opt out with --build-arg INSTALL_ANTIGRAVITY=false. Google ships it only through an installer script that
# self-updates, so unlike Codex and Claude it cannot be pinned to a version here.
ARG INSTALL_ANTIGRAVITY=true
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp/ajmcp \
    AGENT_WORKSPACE=/workspace \
    DISABLE_AUTOUPDATER=1

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git curl openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_ANTIGRAVITY" = "true" ]; then \
      curl --fail --silent --show-error --location \
        --retry 4 --retry-delay 3 --retry-all-errors \
        --connect-timeout 20 --max-time 180 \
        --output /tmp/install-antigravity.sh https://antigravity.google/cli/install.sh \
      && bash /tmp/install-antigravity.sh \
      && test -x "$HOME/.local/bin/agy" \
      && install -m 0755 "$HOME/.local/bin/agy" /usr/local/bin/agy ; \
    fi

WORKDIR /app
COPY package.json ./
COPY tool-versions.json ./
COPY --from=app-deps /app/node_modules ./node_modules
RUN npm install --global --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@github/copilot@${COPILOT_VERSION}" \
      "freebuff@${FREEBUFF_VERSION}" \
    && npm cache clean --force
# Plain `freebuff` (e.g. in `oc exec … bash`) uses the persistent login in /data/home; the default HOME (/tmp/ajmcp) is
# wiped on every restart. An explicit HOME (the admin terminal passes /data/home) is left alone.
RUN real="$(readlink -f /usr/local/bin/freebuff)" \
    && test -x "$real" \
    && rm /usr/local/bin/freebuff \
    && printf '#!/bin/sh\nif [ "$HOME" = /tmp/ajmcp ] && [ -d /data ]; then HOME=/data/home; export HOME; mkdir -p "$HOME"; fi\nexec "%s" "$@"\n' "$real" > /usr/local/bin/freebuff \
    && chmod 0755 /usr/local/bin/freebuff

COPY src/ ./src/
RUN mkdir -p /workspace \
    && chgrp -R 0 /app /workspace \
    && chmod -R g=u /app /workspace

USER 10001
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node src/index.js"]
