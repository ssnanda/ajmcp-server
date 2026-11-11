# AJMCP HTTP and MCP API (v0.1.0)

All API calls (except `/health/*`) require `Authorization: Bearer <token>`.
Tokens belong to exactly one **site** or the **admin**. WordPress must store its token server-side, never in front-end JavaScript. The service ignores caller-supplied site/provider/model overrides.

## Public probe endpoints

- `GET /health/live` — liveness
- `GET /health/ready` — readiness

## Website APIs (site token)

- `GET /v1/capabilities` — show authenticated tenant ID and provider
- `POST /v1/chat` — body `{ "messages": [{ "role":"user", "content":"What are your hours?" }] }`; response includes `{ "reply", "site", "provider", "model", "usage", "requestId" }`
- `POST /v1/ajcore/reply` — body `{ "sessionId": 123, "message":"Hello", "history":[{"role":"assistant","content":"Welcome"}] }`; response includes `{ "sessionId", "reply", "senderName":"AJMCP AI", "site" }`. **The WordPress connector must deliver the reply through AJCore's existing automated-reply endpoint; this API does not post to AJCore itself.**
- `POST /mcp` — MCP 2026 protocol Streamable HTTP (stateless). Tools: `site_info` and `ask_site_ai`. Authenticate with the same per-site bearer token. Clients requiring full OAuth discovery/authorization are not supported yet.

The API uses the provider/model/system prompt configured for that site in `sites.json`. `history` is trusted only from the authenticated WordPress server, and it is validated as text-only user/assistant turns.

## Admin-only APIs (separate admin token)

- `GET /v1/admin/tools` — installed `codex` and `claude` CLI versions
- `POST /v1/agents/run` — body `{ "provider":"codex|claude", "prompt":"..." }`. Disabled by default. Requires `ENABLE_AGENT_JOBS=true` AND admin token. Commands are fixed, no user-supplied flags, shell, command names, or filesystem paths.

Agent runs are deliberately basic one-shot tasks and **must not** be exposed to public visitors or WordPress site tokens. The CLI commands require separately valid provider API keys; personal ChatGPT/Claude subscription tokens are not used for the gateway.

## Limits and security

- Max JSON request: 32 KB by default.
- Max 20 messages, 6000 characters each by default.
- In-memory rate limit per identity and global concurrency cap; **not distributed across replicas**.
- No raw errors, prompts, API keys or messages are written to normal request logs.
- User cannot select arbitrary URLs, models or tools.
- HTTPS termination must be configured at the OpenShift Route/ingress.
- AI output is untrusted; it must never be treated as permission to execute WordPress operations.

## Intentionally not yet implemented

- AJCore WordPress connector/event hook, callback delivery, or live-chat takeover synchronization.
- OAuth for ChatGPT custom MCP clients.
- Durable chat queue, message deduplication, persistent conversation database, audit dashboard, cost accounting, per-site billing, automatic key rotation, cluster-wide rate limiting.
