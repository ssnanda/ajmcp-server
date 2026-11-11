# Build and verification notes — 2026-11-11

- 11 automated Node.js tests passed (`npm test`). Covers tenant/auth isolation, requests, provider payload routing, input guards, JSON validation, admin separation, and MCP-route auth gate.
- All application JavaScript files passed `node --check`.
- OpenShift Kubernetes/Route and workflow YAML files parsed successfully.
- The MCP SDK was implemented against current v2 docs; its real transport handshake was **not** executable in this build environment because npm registry network access was unavailable.
- The combined Codex/Claude container image was **not** built in this environment because Docker/Podman and public npm registry access were unavailable.
- Provider requests were tested using mock responses, not real billable OpenAI/Anthropic calls.
- No tokens, real API keys, or production credentials are included.
- This archive contains the AJMCP **server only**. The AJMCP WordPress connector, actual AJCore automated reply delivery, AI-human takeover synchronization, and chat message deduplication are next-phase work.
- Before production, supply secret credentials, supported model IDs, run `npm install` / `npm test`, build/push image, confirm `/mcp` handshake with a current MCP client, and run staging end-to-end AJCore tests.
