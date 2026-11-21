# AJMCP roadmap

The admin UI has a persistent **Settings → Roadmap** checklist. Checked state and new items are stored in `DATA_DIR/settings.json`.

## FCC subscription OAuth review

- [ ] Obtain written OpenAI and Anthropic approval before using consumer subscription OAuth as an AJMCP server-side provider.
- [ ] Design encrypted OAuth token storage, refresh-token rotation, revocation, audit logging, and explicit per-admin consent.
- [ ] Implement OAuth provider adapters only after vendor approval and a security review.

FCC is MIT-licensed, but that license covers FCC's code—not access rights to OpenAI or Anthropic subscription services. AJMCP should continue using official API keys or official vendor CLI tools until the vendors explicitly authorize a third-party server gateway use case.
