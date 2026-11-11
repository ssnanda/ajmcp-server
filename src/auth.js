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
    const expected = site.tokenHash ? Buffer.from(site.tokenHash, 'hex') : sha(site.token || '');
    if (expected.length === candidateHash.length && timingSafeEqual(candidateHash, expected) && !site.disabled) {
      matched = { kind: 'site', id: site.id, site };
    }
  }
  return matched;
}

export function authorizeSite(identity) {
  return identity?.kind === 'site' ? identity.site : null;
}
