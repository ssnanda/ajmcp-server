import { createHash, timingSafeEqual } from 'node:crypto';

function constantTimeMatch(a, b) {
  if (!a || !b) return false;
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export function identityForBearer(header, config) {
  const match = /^Bearer ([^\s]+)$/i.exec(String(header || ''));
  if (!match) return null;
  const candidate = match[1];
  if (constantTimeMatch(candidate, config.adminToken)) return { kind: 'admin', id: 'admin' };
  // Always iterate every tenant; caller-supplied site identifiers are never trusted.
  let matched = null;
  for (const site of config.sites) {
    if (constantTimeMatch(candidate, site.token)) matched = { kind: 'site', id: site.id, site };
  }
  return matched;
}

export function authorizeSite(identity) {
  return identity?.kind === 'site' ? identity.site : null;
}
