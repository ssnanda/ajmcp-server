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

## Assistant-management MCP (connection token)

`POST|GET|DELETE /assistants/mcp`: MCP Streamable HTTP, stateless. It lets an AI client read and
edit assistants.

**Authentication.** Use a connection token created in the admin under **Settings › Connections**:
- **Expiry:** 15 minutes by default, 30 at most.
- **Scope:** *read* or *read & write*.
- **Storage:** shown once and stored as a hash.

The token goes in one of two places:
- `Authorization: Bearer ajmcp_…`, used by Claude Code. Set it up once with:
  `claude mcp add --transport http ajmcp-assistants https://<host>/assistants/mcp --header "Authorization: Bearer <token>"`
- `https://<host>/assistants/mcp/<token>`, for clients that cannot send headers, such as a
  ChatGPT "no authentication" connector.

Only the Host is checked; server-to-server clients send no browser Origin. Logs and the Activity list
record the route as `/assistants/mcp`, never the token.

**Tools.** Write tools need a *read & write* token.

| Tool | Scope | What it does |
|---|---|---|
| `list_assistants` | read | Ids, route label, lead capture, transfer targets, knowledge size |
| `get_assistant` | read | Every editable field, the tests and all knowledge documents |
| `export_assistant` | read | Package files `{ fileName: text }`, in the same layout as the ChatGPT zip and `assistants/<id>/` |
| `import_assistant` | read (preview), write (apply) | Loads package files. Fields change only when their file is present. Knowledge files replace all manual knowledge; website-synced documents are kept. `apply: false` shows the changes and limit problems; `apply: true` saves in one write, or changes nothing if any check fails. |
| `update_assistant` | write | `systemPrompt`, `routeLabel`, `leadCapture`, `leadInstructions`, `fallback`, `strict`, `transferTargets`, `tests` |
| `add_knowledge`, `update_knowledge`, `delete_knowledge` | write | Manual documents only |
| `run_tests` | read | Asks the live AI the saved tests (10 per call, use `offset` for more) or one custom question; returns reply and expected result side by side |

**Never exposed:** provider keys, CLI logins, website tokens, the admin password. Packages never set
provider or model.

The package format is described in `src/package.js`.

## GitHub sync (assistants repo)

Set up under **Settings › GitHub sync**. It runs inside the server, using the GitHub REST API (no git
binary).

**Settings:**
- **Repository and branch,** e.g. `ssnanda/ajmcp-assistants` on `main`.
- **A fine-grained token** with *Contents: read & write* on that one repo only, stored in
  `settings.json` (mode 600).

**Layout.** One folder per assistant, `<id>/`, holding exactly the package files that
`export_assistant` returns.

**Server → GitHub.** A saved change (admin, MCP or import) is committed a few seconds later, one
commit per change, with commit messages tagged `[ajmcp-sync]`.
- Files are compared by git blob hash, so unchanged content is never committed.
- Files for removed knowledge documents are deleted from the repo.
- The first push to an empty repo creates a README.
- **Push all** commits every assistant.

**GitHub → server.** `POST /github/webhook` receives a GitHub push webhook (content type
`application/json`). The request is verified by its `X-Hub-Signature-256` HMAC; the secret is created
in the admin and shown once.
- Commits tagged `[ajmcp-sync]` are skipped.
- Changed `<id>/` folders are imported through the normal validated import. A folder is the
  complete assistant, including all manual knowledge.
- A folder that fails validation is rejected and listed, and the assistant is left as it was.
- Folders without a matching assistant are reported, never created.
- **Pull all** imports every folder that differs.

**Chat transcripts** are optional and **off** by default, because they are customer data.
- **Where:** one Markdown file per conversation at `chats/<YYYY-MM-DD>/<assistant>-<channel>-<session>.md`.
- **Content:** the customer label (name · email · phone, when the caller sent them), then the full
  transcript, rewritten each turn.
- **Commits:** batched, at most once a minute.
- **Direction:** one-way; the server never reads chats back.

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
