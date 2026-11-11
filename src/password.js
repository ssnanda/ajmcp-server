import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Format: scrypt$N$r$p$salt$hash (base64url). Parameters are stored so they can be raised later.
const N = 16384, R = 8, P = 1, KEYLEN = 32;

const derive = (password, salt, n, r, p) => new Promise((resolve, reject) => {
  scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

export function generatePassword() { return randomBytes(15).toString('base64url'); }

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(String(password), salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export function isPasswordHash(value) {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(String(value || ''));
}

export async function verifyPassword(password, stored) {
  if (!isPasswordHash(stored)) return false;
  const [, n, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(String(password), Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
