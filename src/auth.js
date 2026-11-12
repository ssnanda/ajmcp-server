import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (value) => createHash('sha256').update(String(value)).digest();

export const tokenHash = (token) => sha(token).toString('hex');

function constantTimeMatch(a, b) {
  if (!a || !b) return false;
  return timingSafeEqual(sha(a), sha(b));
}

export function identityForBearer(header, config) {
  const match = /^Bearer ([^\s]+)$/i.exec(String(header || ''));
  if (!match) return null;
  const candidate = match[1];
  if (constantTimeMatch(candidate, config.adminToken)) return { kind: 'admin', id: 'admin' };
  const candidateHash = sha(candidate);
  // Always iterate every tenant; caller-supplied site identifiers are never trusted.
  // Sites carry either a stored tokenHash (managed in the admin UI) or a plain token (seed file).
  let matched = null;
  for (const site of config.sites) {
    // The primary token plus any extra named tokens. Every one is compared, so timing does not reveal which matched.
    const hashes = [site.tokenHash ? Buffer.from(site.tokenHash, 'hex') : sha(site.token || '')];
    for (const extra of site.tokens || []) hashes.push(Buffer.from(String(extra.tokenHash), 'hex'));
    let hit = false;
    let which = -1;
    hashes.forEach((expected, index) => { if (expected.length === candidateHash.length && timingSafeEqual(candidateHash, expected)) { hit = true; which = index; } });
    // `via` says which of the site's tokens was used (for the admin activity list); never the token itself.
    if (hit && !site.disabled) matched = { kind: 'site', id: site.id, site, via: which <= 0 ? 'primary' : String(site.tokens[which - 1]?.label || 'token').slice(0, 40) };
  }
  return matched;
}

export function authorizeSite(identity) {
  return identity?.kind === 'site' ? identity.site : null;
}
