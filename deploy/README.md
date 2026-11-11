# OpenShift deployment

**Prerequisites:** reachable OpenShift image registry, OpenAI/Anthropic API keys, DNS pointing to your OpenShift router, TLS configured on the Route. Review security and allowed models before production.

1. Build the image with `CONTAINER_ENGINE=podman ./scripts/build-image.sh REGISTRY/ajmcp-server:0.1.0`, then push it to a registry accessible to OpenShift.
2. Generate *different* 32+ byte random tokens for every WordPress site and admin (e.g. `openssl rand -hex 32`). Fill the sample sites JSON with approved model identifiers and business instructions.
3. Create the `ajmcp-secrets` OpenShift Secret from the provider keys, admin token and `sites.json`; do not commit real values or paste tokens into an issue. Adapt `deploy/secret.example.yaml` to your secret manager.
4. Edit the image and route host in `deploy/openshift.yaml`, and `ALLOWED_HOSTS` to match the actual external hostname.
5. Run `oc apply -f deploy/openshift.yaml`, then `oc rollout status deployment/ajmcp-server`.
6. Check `https://YOUR_HOST/health/ready` and use a server-side site token to call `/v1/capabilities` and `/v1/chat`.
7. Leave `ENABLE_AGENT_JOBS=false` until testing/admin network restrictions are in place. Never use it for raw visitor messages.

The example uses a single replica, an `emptyDir` for temporary CLI data, and a read-only workspace. No GPU is required for remote model APIs. A single-node OpenShift cluster does **not** provide node-level HA. The application is stateless; no PV is required for v0.1.0, and no chat history is stored by the gateway.

**Independent updates:** change only one key in `tool-versions.json` (or use the Actions workflow “Update one bundled AI CLI”). CI validates the change; rebuilding/redeploying the one image briefly restarts the service. The other CLI and AJMCP application versions remain pinned.
