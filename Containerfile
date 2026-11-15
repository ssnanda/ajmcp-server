# Version each CLI independently via build arguments. Both are installed in ONE runtime image.
FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.167.1
ARG CLAUDE_VERSION=2.1.322
# Google Antigravity CLI (agy). Opt in with --build-arg INSTALL_ANTIGRAVITY=true. Google ships it only through an installer script that
# self-updates, so unlike Codex and Claude it cannot be pinned to a version here.
ARG INSTALL_ANTIGRAVITY=false
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
      curl -fsSL https://antigravity.google/cli/install.sh | bash \
      && install -m 0755 "$HOME/.local/bin/agy" /usr/local/bin/agy ; \
    fi

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm install --global --no-audit --no-fund \
      "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force

COPY src/ ./src/
RUN mkdir -p /workspace \
    && chgrp -R 0 /app /workspace \
    && chmod -R g=u /app /workspace

USER 10001
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node src/index.js"]
