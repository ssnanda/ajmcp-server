# Deploy AJMCP on OpenShift (AJ Ops-style)

This is the recommended, clone-and-run workflow. It builds the AJMCP + Codex + Claude container inside OpenShift using a binary BuildConfig and the cluster's internal ImageStream. No local Docker/Podman, external registry, or image push is required.

## First deployment

1. Clone the repository; authenticate using your normal `oc login`. Have Node.js and oc installed locally.
2. Nothing to copy. `.env.local` is optional (set `OPENSHIFT_PROJECT`, `AJMCP_HOST` or `CERT_MANAGER_CLUSTER_ISSUER` there only if you want something other than `ajmcp`, `ajmcp.ncllcagents.com` and `letsencrypt-ncllc`).
3. The first run prints the web admin login (`https://<host>/admin`, generated user like `u-3f9a1c7b24de` + password) once. Only the password's hash is stored in the cluster. Later runs show the user only; `--reset-admin` issues a new user and password. Sites, site tokens, OpenAI/Anthropic keys and the admin password are managed in the admin; settings live on a 1Gi persistent volume (`ajmcp-data`). An optional `sites.json` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` only seeds the first start.
4. Create the DNS record for `ajmcp.ncllcagents.com` pointing to your OpenShift router (CNAME to the public router hostname or A/AAAA to router addresses). Ensure the existing Let's Encrypt/Cloudflare DNS-01 issuer covers `ncllcagents.com`.
5. Run `./bin/3-oc-deploy.sh`. The script creates the project if needed, initializes `ajmcp-secrets`, performs a safe in-cluster image build, and deploys a pinned image digest.

## Regular deployments

- `./bin/3-oc-deploy.sh`: on a dirty Git checkout, offer patch/minor/major/custom version bump, commit and optional GitHub push before building/deploying.
- `./bin/2-bump-version.sh`: version and push independently.
- `./bin/1-pull-latest.sh`: pull changes made directly on GitHub (e.g. by ChatGPT); `--dry-run` previews, `-f` resets to GitHub.
- `./bin/3-oc-deploy.sh --skip-bump`: deploy working tree without Git interaction.
- `./bin/3-oc-deploy.sh 0.1.2`: tag the image explicitly (server version still comes from package.json; prefer a real bump).
- `./bin/3-oc-deploy.sh --sync-secrets`: **explicitly overwrite** the protected Secret from local .env.local and sites.json; normally the existing Secret is preserved.
- `./bin/3-oc-deploy.sh --sync-ollama-ssh`: create/update only the separate Ollama SSH Secret and roll out the tunnel sidecar; ordinary deploys preserve it.

The version in package.json governs the server; tool-versions.json independently pins the Codex and Claude CLI versions. Both pinned versions are set as OpenShift build arguments. A new binary build produces one combined container image; an immutable image digest ensures reliable Deployment rollback on a failed rollout.

## Route and SSL

Like AJ Ops, `openshift/ingress.yaml` uses `ingressClassName: openshift-default` and a cert-manager ClusterIssuer annotation. OpenShift creates the underlying **Route**; cert-manager issues and renews the `ajmcp-tls` certificate for `ajmcp.ncllcagents.com`. The generated edge Route redirects HTTP to HTTPS.

Check `oc get certificate ajmcp-tls -n ajmcp`, `oc get routes -n ajmcp`, and `https://ajmcp.ncllcagents.com/health/ready`. DNS and initial ACME issuance can take additional time. The deploy script cannot itself create your external DNS record or log into your cluster.

**Do not apply the older deploy/openshift.yaml alongside these manifests**: it creates a competing manually named Route. The new bin/3-oc-deploy.sh uses exclusively the new openshift/ directory.

## Secrets and safety

The script uploads only Containerfile, package.json, tool-versions.json and src/ for its binary build. It never sends your private .env.local, sites.json, Git history, credentials or workspace. Site tokens and provider keys stay in ajmcp-secrets, not Git or ConfigMaps. Admin-only CLI jobs remain disabled by default. Automatic rollback restores the prior Deployment revision if a subsequent rollout fails; first installs have no prior revision. Single-node OpenShift does not provide node-level HA.

## Subscription logins (Claude / ChatGPT)

The image contains the Claude Code and Codex CLIs. In `/admin` > Subscription logins, paste the token from `claude setup-token` and a Codex login. For Codex, sign in **inside the pod** so the server has its own login: `oc exec -it -n ajmcp deploy/ajmcp-server -c ajmcp -- env HOME=/data/home codex login --device-auth`. Pasting `~/.codex/auth.json` from your Mac also works, but only until your Mac's Codex refreshes it: ChatGPT refresh tokens are single-use, so the server then fails with `cli_login_expired` (`refresh token was already used`). They are stored on the data volume and survive redeploys. A site then uses them by choosing provider "Claude subscription (CLI)" or "ChatGPT subscription (Codex CLI)"; the WordPress connector needs no other change. Claude runs with no tools. Codex runs as a read-only agent, so prefer Claude for public-facing chat.

## Remote Ollama over SSH

On Ubuntu, keep Ollama on its default loopback listener. Create a dedicated SSH account/key and restrict the public key in `~/.ssh/authorized_keys`:

```text
restrict,port-forwarding,permitopen="127.0.0.1:11434" ssh-ed25519 AAAA... ajmcp-ollama
```

Confirm the server host key out of band and create a private `known_hosts` file (do not use `StrictHostKeyChecking=no`). Set these only in `.env.local` or the process environment:

```dotenv
OLLAMA_SSH_HOST=ollama.example.net
OLLAMA_SSH_USER=ajmcp_tunnel
OLLAMA_SSH_PORT=22
OLLAMA_SSH_PRIVATE_KEY_FILE=/absolute/private/path/id_ed25519
OLLAMA_SSH_KNOWN_HOSTS_FILE=/absolute/private/path/known_hosts
```

Run `./bin/3-oc-deploy.sh --sync-ollama-ssh`. The script validates the non-command settings, uploads the files to `ajmcp-ollama-ssh`, and preserves the Secret on later ordinary deploys. The sidecar enforces strict host-key checking, permits no remote command, forwards only local `127.0.0.1:11434` to remote `127.0.0.1:11434`, uses keepalives, and reconnects. For strongest server-side enforcement also set `AllowTcpForwarding local` and `PermitOpen 127.0.0.1:11434` in a matching `sshd_config` block.

The AJMCP pod shares the sidecar network namespace and calls only `http://127.0.0.1:11434`; there is no configurable Ollama URL. An authenticated administrator can alternatively enter the SSH host/user/port and upload or paste the private key plus verified `known_hosts` in `/admin` > Logins & keys > Remote Ollama. Instead of supplying `known_hosts`, the administrator may paste the independently verified ED25519 `SHA256:…` fingerprint; AJMCP runs `ssh-keyscan` with fixed arguments and creates the entry only when the fetched public key matches exactly. AJMCP has narrowly scoped RBAC to update only `ajmcp-ollama-ssh` and patch only its own Deployment, then triggers the required rollout.

The browser upload is protected in transit by the admin Route's HTTPS. Kubernetes Secret values are base64, not encryption by themselves. Confirm OpenShift encryption at rest is enabled for Secrets in etcd according to your cluster's security policy; AJMCP never writes the key to its database, settings volume, logs, or image.
