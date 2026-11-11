#!/usr/bin/env bash
# AJMCP OpenShift deployment, following the AJ Ops clone-and-run workflow.
# Builds a complete image inside OpenShift, no local Docker or external registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

usage() {
  cat <<'USAGE'
AJMCP OpenShift deployment:
  ./bin/3-oc-deploy.sh [version] [--skip-bump] [--sync-secrets]

Defaults: package.json version, interactive bump when Git dirty, keep existing
OpenShift secrets, build in cluster, deploy an immutable image digest.
  --skip-bump     Skip version/commit/push prompt for uncommitted files
  --sync-secrets  Explicitly overwrite ajmcp-secrets using local private files
  --reset-admin   Generate a new admin user + password for the web admin and show them once
First run: just run it. It creates the web admin login and prints it once (save it).
Sites, AI keys and the admin password are then managed at https://<host>/admin.
USAGE
}

VERSION_OVERRIDE=""
SKIP_BUMP=false
SYNC_SECRETS=false
RESET_ADMIN=false
for arg in "$@"; do
  case "$arg" in
    --skip-bump) SKIP_BUMP=true ;;
    --sync-secrets) SYNC_SECRETS=true ;;
    --reset-admin) RESET_ADMIN=true ;;
    --help|-h) usage; exit 0 ;;
    -*) echo "ERROR: Unknown option $arg" >&2; usage; exit 2 ;;
    *)
      if [[ -n "$VERSION_OVERRIDE" ]]; then echo "ERROR: Only one version is allowed." >&2; exit 2; fi
      VERSION_OVERRIDE="$arg"
      ;;
  esac
done

b64() { printf %s "$1" | base64 | tr -d '\n'; }
unb64() { printf %s "$1" | node -p "Buffer.from(require('fs').readFileSync(0,'utf8'),'base64').toString()"; }
secret_field() {
  local value
  value="$(oc get secret ajmcp-secrets -n "$PROJECT" -o "go-template={{index .data \"$1\"}}" 2>/dev/null || true)"
  [[ "$value" == "<no value>" ]] && value=""
  printf %s "$value"
}

# Web admin login. The password is shown once and only its scrypt hash is stored in the cluster Secret.
ADMIN_PASSWORD_SHOWN=""
ADMIN_USER_NAME=""
ensure_admin_login() {
  local hash_b64 user_b64 password hash
  hash_b64="$(secret_field admin-password-hash)"
  user_b64="$(secret_field admin-user)"
  if [[ -n "$hash_b64" && -n "$user_b64" && "$RESET_ADMIN" == false ]]; then
    ADMIN_USER_NAME="$(unb64 "$user_b64")"
    return 0
  fi
  # Not "admin": fully random (48 bits), unless ADMIN_USER is set in the environment or .env.local.
  ADMIN_USER_NAME="${ADMIN_USER:-u-$(node -p "require('crypto').randomBytes(6).toString('hex')")}"
  password="$(node --input-type=module -e 'import { generatePassword } from "./src/password.js"; console.log(generatePassword())')"
  hash="$(AJMCP_PW="$password" node --input-type=module -e 'import { hashPassword } from "./src/password.js"; console.log(await hashPassword(process.env.AJMCP_PW))')"
  [[ -n "$password" && -n "$hash" ]] || { echo "ERROR: Could not create the admin login." >&2; exit 1; }
  oc patch secret ajmcp-secrets -n "$PROJECT" --type=merge \
    -p "{\"data\":{\"admin-user\":\"$(b64 "$ADMIN_USER_NAME")\",\"admin-password-hash\":\"$(b64 "$hash")\"}}" >/dev/null
  ADMIN_PASSWORD_SHOWN="$password"
  show_admin_login
}

show_admin_login() {
  echo ""
  echo "  Web admin:  https://$HOSTNAME/admin"
  echo "  User:       $ADMIN_USER_NAME"
  if [[ -n "$ADMIN_PASSWORD_SHOWN" ]]; then
    echo "  Password:   $ADMIN_PASSWORD_SHOWN   (shown once - save it now; change it in the admin)"
  fi
  echo ""
}

for binary in oc node mktemp sed cp; do
  command -v "$binary" >/dev/null 2>&1 || { echo "ERROR: Missing $binary" >&2; exit 1; }
done
# .env and .env.local are optional (as in AJ Ops). Everything has a default except the AI provider key,
# which is asked for on the first run when it is not already set.
set -a
for env_file in .env .env.local; do
  # shellcheck disable=SC1090
  if [[ -f "$env_file" ]]; then source "$env_file"; fi
done
set +a
if [[ "$SKIP_BUMP" == false && -z "$VERSION_OVERRIDE" ]]; then
  "$SCRIPT_DIR/2-bump-version.sh" --if-dirty
fi
PACKAGE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
VERSION="${VERSION_OVERRIDE:-$PACKAGE_VERSION}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "ERROR: Invalid version $VERSION" >&2; exit 1; }
if [[ "$VERSION" != "$PACKAGE_VERSION" ]]; then
  echo "WARNING: Image tag $VERSION differs from package.json version $PACKAGE_VERSION."
fi

PROJECT="${OPENSHIFT_PROJECT:-ajmcp}"
HOSTNAME="${AJMCP_HOST:-ajmcp.ncllcagents.com}"
ISSUER="${CERT_MANAGER_CLUSTER_ISSUER:-letsencrypt-ncllc}"
APP="ajmcp-server"
REGISTRY="image-registry.openshift-image-registry.svc:5000"
[[ "$PROJECT" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "ERROR: OPENSHIFT_PROJECT must be a valid project name (set it in .env.local or the environment)." >&2; exit 1; }
[[ "$HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$HOSTNAME" == *.* && ${#HOSTNAME} -le 253 ]] || { echo "ERROR: Invalid AJMCP_HOST" >&2; exit 1; }
[[ "$ISSUER" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { echo "ERROR: Invalid issuer" >&2; exit 1; }
CODEX_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).codex")"
CLAUDE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('tool-versions.json','utf8')).claude")"
for v in "$CODEX_VERSION" "$CLAUDE_VERSION"; do
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "ERROR: Invalid CLI version $v" >&2; exit 1; }
done

oc whoami >/dev/null 2>&1 || { echo "ERROR: oc login is required." >&2; exit 1; }
echo ""
echo "============================================="
echo "  AJMCP Server — OpenShift deployment"
echo "============================================="
echo "  Version:    $VERSION"
echo "  Codex CLI:  $CODEX_VERSION"
echo "  Claude CLI: $CLAUDE_VERSION"
echo "  Namespace:  $PROJECT"
echo "  HTTPS URL:  https://$HOSTNAME"
echo "  Issuer:     $ISSUER"
echo "  OC user:    $(oc whoami)"
echo "============================================="
echo ""

if ! oc get project "$PROJECT" >/dev/null 2>&1; then
  oc new-project "$PROJECT" --display-name="AJMCP Server" --description="AJMCP AI and MCP gateway"
fi
# Namespace isolation: never touch the existing AJ Ops deployment.
oc get clusterissuer "$ISSUER" >/dev/null 2>&1 || { echo "ERROR: Missing/unreadable ClusterIssuer $ISSUER (AJ Ops uses letsencrypt-ncllc)" >&2; exit 1; }
oc get ingressclass openshift-default >/dev/null 2>&1 || { echo "ERROR: Missing/unreadable openshift-default IngressClass" >&2; exit 1; }

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [[ "$SYNC_SECRETS" == true ]] || ! oc get secret ajmcp-secrets -n "$PROJECT" >/dev/null 2>&1; then
  # sites.json is only a seed: once you save anything in the web admin, the admin's list takes over.
  SITE_FILE="${AJMCP_SITES_FILE:-sites.json}"
  OPENAI_API_KEY="${OPENAI_API_KEY:-}"
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
  if [[ -f "$SITE_FILE" ]]; then cp "$SITE_FILE" "$TMP/sites.json"; else echo '{"sites":[]}' > "$TMP/sites.json"; fi
  node - "$TMP/sites.json" <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(config.sites)) throw new Error('sites.json needs a sites array');
const tokens = new Set();
for (const site of config.sites) {
  if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(site.id || '')) throw new Error('Invalid site id');
  if (typeof site.token !== 'string' || site.token.length < 32 || /REPLACE_WITH|EXAMPLE|SAMPLE/i.test(site.token)) throw new Error('Site '+site.id+' needs real 32+ character token');
  if (tokens.has(site.token)) throw new Error('Duplicate site token');
  tokens.add(site.token);
  if (!['openai','anthropic'].includes(site.provider || 'openai')) throw new Error('Invalid site provider');
}
NODE
  ADMIN_TOKEN="${ADMIN_TOKEN:-}"
  if [[ -z "$ADMIN_TOKEN" ]]; then
    command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl required for token generation." >&2; exit 1; }
    ADMIN_TOKEN="$(openssl rand -hex 32)"
    printf '\nADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >> .env.local
    chmod 600 .env.local
    echo "Generated and saved a private ADMIN_TOKEN in .env.local."
  fi
  [[ ${#ADMIN_TOKEN} -ge 32 ]] || { echo "ERROR: Admin token too short" >&2; exit 1; }
  printf %s "$OPENAI_API_KEY" > "$TMP/openai-api-key"
  printf %s "$ANTHROPIC_API_KEY" > "$TMP/anthropic-api-key"
  printf %s "$ADMIN_TOKEN" > "$TMP/admin-token"
  chmod 600 "$TMP"/*
  # --sync-secrets must keep the existing web admin login: carry its Secret fields over.
  EXTRA=()
  for key in admin-user admin-password-hash; do
    value="$(secret_field "$key")"
    if [[ -n "$value" ]]; then printf %s "$(unb64 "$value")" > "$TMP/$key"; EXTRA+=("--from-file=$key=$TMP/$key"); fi
  done
  oc create secret generic ajmcp-secrets -n "$PROJECT" \
    --from-file="openai-api-key=$TMP/openai-api-key" \
    --from-file="anthropic-api-key=$TMP/anthropic-api-key" \
    --from-file="admin-token=$TMP/admin-token" \
    --from-file="sites.json=$TMP/sites.json" \
    ${EXTRA[@]+"${EXTRA[@]}"} \
    --dry-run=client -o yaml | oc apply -n "$PROJECT" -f -
else
  echo "Keeping current ajmcp-secrets. Use --sync-secrets to rotate deliberately."
fi
for key in admin-token sites.json; do
  if [[ -z "$(secret_field "$key")" ]]; then
    echo "ERROR: ajmcp-secrets is missing $key. Run with --sync-secrets." >&2
    exit 1
  fi
done
ensure_admin_login

render() {
  sed -e "s|AJMCP_HOST_PLACEHOLDER|$HOSTNAME|g" \
      -e "s|AJMCP_ISSUER_PLACEHOLDER|$ISSUER|g" \
      -e "s|AJMCP_IMAGE_PLACEHOLDER|${IMAGE_REF:-placeholder}|g" \
      -e "s|AJMCP_VERSION_PLACEHOLDER|$VERSION|g" \
      -e "s|AJMCP_DEPLOYED_AT_PLACEHOLDER|${DEPLOYED_AT:-placeholder}|g" "$1"
}

echo "Applying ImageStream, BuildConfig, ConfigMap, Service and data volume..."
for file in openshift/imagestream.yaml openshift/buildconfig.yaml openshift/configmap.yaml openshift/service.yaml openshift/pvc.yaml; do
  render "$file" | oc apply -n "$PROJECT" -f -
done
oc patch buildconfig "$APP" -n "$PROJECT" --type=merge \
  -p "{\"spec\":{\"strategy\":{\"dockerStrategy\":{\"buildArgs\":[{\"name\":\"CODEX_VERSION\",\"value\":\"$CODEX_VERSION\"},{\"name\":\"CLAUDE_VERSION\",\"value\":\"$CLAUDE_VERSION\"}]}}}}" >/dev/null

# Whitelist the binary build contents: never upload .env.local, sites.json, .git, secrets.
mkdir -p "$TMP/build"
cp Containerfile package.json tool-versions.json "$TMP/build/"
cp -R src "$TMP/build/src"
echo "Building AJMCP + Codex + Claude inside OpenShift..."
oc start-build "$APP" -n "$PROJECT" --from-dir="$TMP/build" --follow --wait

oc tag -n "$PROJECT" "$APP:latest" "$APP:$VERSION"
DIGEST="$(oc get imagestreamtag "$APP:$VERSION" -n "$PROJECT" -o jsonpath='{.image.metadata.name}')"
[[ "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "ERROR: Cannot resolve immutable image digest: $DIGEST" >&2; exit 1; }
IMAGE_REF="$REGISTRY/$PROJECT/$APP@$DIGEST"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREVIOUS_DEPLOYMENT=false
if oc get deployment "$APP" -n "$PROJECT" >/dev/null 2>&1; then PREVIOUS_DEPLOYMENT=true; fi

render openshift/deployment.yaml | oc apply -n "$PROJECT" -f -
render openshift/ingress.yaml | oc apply -n "$PROJECT" -f -
if ! oc rollout status "deployment/$APP" -n "$PROJECT" --timeout=240s; then
  echo "ERROR: Rollout failed" >&2
  if [[ "$PREVIOUS_DEPLOYMENT" == true ]]; then
    echo "Rolling back to last Deployment revision..." >&2
    oc rollout undo "deployment/$APP" -n "$PROJECT" || true
    oc rollout status "deployment/$APP" -n "$PROJECT" --timeout=90s || true
  else
    echo "No previous revision exists for rollback." >&2
  fi
  echo "Inspect: oc logs deployment/$APP -n '$PROJECT' --all-containers=true" >&2
  exit 1
fi

echo ""
echo "Deployed AJMCP $VERSION ($DIGEST)"
echo "URL: https://$HOSTNAME"
echo "Status: https://$HOSTNAME/health/ready"
echo "Route: oc get routes -n '$PROJECT'"
echo "TLS: oc get certificate ajmcp-tls -n '$PROJECT'"
show_admin_login
echo "Ensure DNS points $HOSTNAME to OpenShift router; cert-manager manages renewal."
if command -v curl >/dev/null 2>&1; then
  if curl --connect-timeout 5 --max-time 10 -fsS "https://$HOSTNAME/health/ready" >/dev/null 2>&1; then
    echo "Public HTTPS health check: OK"
  else
    echo "Public HTTPS check pending (DNS or certificate not yet ready)."
  fi
fi
