# Deploy AJMCP on OpenShift (AJ Ops-style)

This is the recommended, clone-and-run workflow. It builds the AJMCP + Codex + Claude container inside OpenShift using a binary BuildConfig and the cluster's internal ImageStream. No local Docker/Podman, external registry, or image push is required.

## First deployment

1. Clone the repository; authenticate using your normal `oc login`. Have Node.js and oc installed locally.
2. Copy `deploy/oc-deploy.env.example` to `.env.local`; enter your OpenShift project and OpenAI or Anthropic API key. Default hostname: `ajmcp.ncllcagents.com`. Default ClusterIssuer: `letsencrypt-ncllc`, matching AJ Ops.
3. Copy `examples/sites.example.json` to `sites.json` (ignored by Git). Replace every placeholder with **real** 32+ character random site tokens, a supported provider/model, and site-specific instructions. Use `openssl rand -hex 32` to generate tokens. Site tokens belong only in your server-side WordPress connector.
4. Create the DNS record for `ajmcp.ncllcagents.com` pointing to your OpenShift router (CNAME to the public router hostname or A/AAAA to router addresses). Ensure the existing Let's Encrypt/Cloudflare DNS-01 issuer covers `ncllcagents.com`.
5. Run `./bin/oc-deploy.sh`. The script creates the project if needed, initializes `ajmcp-secrets`, performs a safe in-cluster image build, and deploys a pinned image digest.

## Regular deployments

- `./bin/oc-deploy.sh`: on a dirty Git checkout, offer patch/minor/major/custom version bump, commit and optional GitHub push before building/deploying.
- `./bin/bump.sh`: version and push independently.
- `./bin/oc-deploy.sh --skip-bump`: deploy working tree without Git interaction.
- `./bin/oc-deploy.sh 0.1.2`: tag the image explicitly (server version still comes from package.json; prefer a real bump).
- `./bin/oc-deploy.sh --sync-secrets`: **explicitly overwrite** the protected Secret from local .env.local and sites.json; normally the existing Secret is preserved.

The version in package.json governs the server; tool-versions.json independently pins the Codex and Claude CLI versions. Both pinned versions are set as OpenShift build arguments. A new binary build produces one combined container image; an immutable image digest ensures reliable Deployment rollback on a failed rollout.

## Route and SSL

Like AJ Ops, `openshift/ingress.yaml` uses `ingressClassName: openshift-default` and a cert-manager ClusterIssuer annotation. OpenShift creates the underlying **Route**; cert-manager issues and renews the `ajmcp-tls` certificate for `ajmcp.ncllcagents.com`. The generated edge Route redirects HTTP to HTTPS.

Check `oc get certificate ajmcp-tls -n ajmcp`, `oc get routes -n ajmcp`, and `https://ajmcp.ncllcagents.com/health/ready`. DNS and initial ACME issuance can take additional time. The deploy script cannot itself create your external DNS record or log into your cluster.

**Do not apply the older deploy/openshift.yaml alongside these manifests**: it creates a competing manually named Route. The new bin/oc-deploy.sh uses exclusively the new openshift/ directory.

## Secrets and safety

The script uploads only Containerfile, package.json, tool-versions.json and src/ for its binary build. It never sends your private .env.local, sites.json, Git history, credentials or workspace. Site tokens and provider keys stay in ajmcp-secrets, not Git or ConfigMaps. Admin-only CLI jobs remain disabled by default. Automatic rollback restores the prior Deployment revision if a subsequent rollout fails; first installs have no prior revision. Single-node OpenShift does not provide node-level HA.
