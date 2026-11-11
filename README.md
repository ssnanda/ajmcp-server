# AJMCP Server · v0.1.1

A single-container, OpenShift-ready, multi-tenant AI gateway and standards-based **Model Context Protocol** server for AJ WordPress sites. Includes separately versioned **OpenAI Codex CLI** and **Claude Code CLI**.

## Implemented

- `POST /v1/chat`: server-to-server AI answer through OpenAI Responses API or Anthropic Messages API.
- `POST /v1/ajcore/reply`: bridge response formatted for AJCore's chat automation; the WordPress connector must still post the reply to AJCore.
- `POST /mcp`: genuine stateless MCP Streamable HTTP, with site-scoped `site_info` and `ask_site_ai` tools.
- Per-website authentication, private site-specific provider/model/system instructions, separate admin token.
- Admin-only CLI operation (`/v1/agents/run`, opt-in) and installed CLI version inspection.
- Health endpoints, guardrails, tests, container definition, OpenShift Deployment/Service/Route.
- CLI versions pinned separately in `tool-versions.json` and a workflow to propose one-tool updates.

## Local quick start (Node 22+)

1. `npm install`.
2. Generate two separate random tokens (admin and site), and edit a private copy of `examples/sites.example.json` with real tokens and a model ID your provider account supports.
3. Set `SITES_CONFIG_FILE=/absolute/path/sites.json`, `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`, `ALLOWED_HOSTS=localhost,127.0.0.1` and `HOST=127.0.0.1`.
4. `npm start`.
5. Call `/health/ready`; invoke `/v1/chat` using `Authorization: Bearer SITE_TOKEN` from a backend, never browser JavaScript.
6. Run `npm test` and `npm run check`.

The `examples/sites.example.json` deliberately contains nonfunctional placeholder tokens/models. The server refuses to start with placeholder credentials.

## Build one image with independently pinned CLIs

Run `CONTAINER_ENGINE=podman ./scripts/build-image.sh your-registry/ajmcp-server:0.1.0`. Docker works too with `CONTAINER_ENGINE=docker`.

This installs `@openai/codex` and `@anthropic-ai/claude-code` globally at the **exact independent versions** in `tool-versions.json`. CLI installation from npm is supported but Anthropic now recommends the native installer for local environments; versioned npm packages are used here to make reproducible container builds possible. Before production, confirm provider CLI distribution policies and your API-account entitlements.

To update **only Claude**: use the GitHub Actions “Update one bundled AI CLI” workflow with `tool=claude`, or run `npm run tools:update -- --tool claude`. This changes only `tool-versions.json`; rebuild/redeploy to activate. Updates are *not* run inside a live container.

## OpenShift

See [deploy/README.md](deploy/README.md), [deploy/openshift.yaml](deploy/openshift.yaml), and [deploy/secret.example.yaml](deploy/secret.example.yaml). The example runs one replica, TLS edge route, non-root image, read-only filesystem, and separate Secrets. Single-node OpenShift is appropriate for an initial deployment but not HA.

## API reference, integration status and security

- [HTTP and MCP endpoints](docs/API.md)
- [Security boundaries](SECURITY.md)
- [OpenShift deployment guide](deploy/README.md)

**AJCore integration is not yet end-to-end.** AJCore currently stores/serves chats through its own API and AJOps WebSocket service. The next phase is a WordPress-side AJMCP connector that forwards new visitor messages to `/v1/ajcore/reply`, sends responses to AJCore's existing `/ops/chat/sessions/{id}/auto-reply` endpoint, and respects human takeover/automation mute flags, deduplication and site identity. Neither AJCore nor AJOps has been modified by this server repository.

**Production recommendation:** use provider API keys for customer-facing chat. CLI jobs are opt-in and administrative only; this project does not circumvent subscription terms or share personal ChatGPT/Claude sessions with website visitors.
## Clone and deploy on OpenShift (AJ Ops-style)

Run `cp deploy/oc-deploy.env.example .env.local`, create a private `sites.json` from `examples/sites.example.json`, set the provider credentials and project, `oc login`, then `./bin/oc-deploy.sh`. The new script builds in OpenShift and deploys `https://ajmcp.ncllcagents.com` via cert-manager's existing `letsencrypt-ncllc` ClusterIssuer. See [deploy/README.md](deploy/README.md) for DNS, TLS, versioning and secret setup.
