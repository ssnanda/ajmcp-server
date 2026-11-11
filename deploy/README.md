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

The version in package.json governs the server; tool-versions.json independently pins the Codex and Claude CLI versions. Both pinned versions are set as OpenShift build arguments. A new binary build produces one combined container image; an immutable image digest ensures reliable Deployment rollback on a failed rollout.

## Route and SSL

Like AJ Ops, `openshift/ingress.yaml` uses `ingressClassName: openshift-default` and a cert-manager ClusterIssuer annotation. OpenShift creates the underlying **Route**; cert-manager issues and renews the `ajmcp-tls` certificate for `ajmcp.ncllcagents.com`. The generated edge Route redirects HTTP to HTTPS.

Check `oc get certificate ajmcp-tls -n ajmcp`, `oc get routes -n ajmcp`, and `https://ajmcp.ncllcagents.com/health/ready`. DNS and initial ACME issuance can take additional time. The deploy script cannot itself create your external DNS record or log into your cluster.

**Do not apply the older deploy/openshift.yaml alongside these manifests**: it creates a competing manually named Route. The new bin/3-oc-deploy.sh uses exclusively the new openshift/ directory.

## Secrets and safety

The script uploads only Containerfile, package.json, tool-versions.json and src/ for its binary build. It never sends your private .env.local, sites.json, Git history, credentials or workspace. Site tokens and provider keys stay in ajmcp-secrets, not Git or ConfigMaps. Admin-only CLI jobs remain disabled by default. Automatic rollback restores the prior Deployment revision if a subsequent rollout fails; first installs have no prior revision. Single-node OpenShift does not provide node-level HA.

## Subscription logins (Claude / ChatGPT)

The image contains the Claude Code and Codex CLIs. In `/admin` > Subscription logins, paste the token from `claude setup-token` and the `~/.codex/auth.json` from `codex login` (both made on your Mac). They are stored on the data volume and survive redeploys. A site then uses them by choosing provider "Claude subscription (CLI)" or "ChatGPT subscription (Codex CLI)"; the WordPress connector needs no other change. Claude runs with no tools. Codex runs as a read-only agent, so prefer Claude for public-facing chat.
