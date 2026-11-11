# Security model

AJMCP v0.1.0 is a private, authenticated **server-side** AI integration. Do not expose site tokens or provider keys in browser JavaScript, frontend page source, or WordPress REST endpoints accessible to visitors.

- Per-site independent random tokens; tenant identity inferred exclusively from token.
- Distinct admin token; admin-only CLI operations disabled by default.
- OpenShift Secrets for site credentials/provider keys; mounted secret for sites.json.
- External TLS required; `ALLOWED_HOSTS` and optional browser Origin allowlist.
- Rate limiting, concurrency limits, bounded request/output size, timeouts.
- No arbitrary shell, command paths, URLs or model selection exposed over API.
- Codex agent runs in read-only sandbox; Claude runs with no tools; admin requests only.
- No credentials or conversation text in ordinary access logs.
- Stateless MCP HTTP. OAuth not implemented; not yet suitable for clients that insist on OAuth.

Important limits: rate limits are per-pod; provider API usage is billable; the container still contains both agent tools, so restrict admin API access at the network/ingress level as well as by token. Treat AI results as untrusted. Run a security review and infrastructure smoke tests before routing production customer data.
