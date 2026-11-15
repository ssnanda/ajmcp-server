import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export function fingerprintOfKnownHost(line) {
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 3 || parts[1] !== 'ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2])) throw new Error('invalid_known_hosts');
  const digest = createHash('sha256').update(Buffer.from(parts[2], 'base64')).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function scanKnownHost(host, port, expectedFingerprint, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('ssh-keyscan', ['-T', '10', '-p', String(port), '-t', 'ed25519', host], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 12000) chunks.push(chunk);
      else child.kill('SIGKILL');
    });
    child.on('error', () => reject(new Error('host_key_scan_failed')));
    child.on('close', (code) => {
      if (code !== 0 || size > 12000) return reject(new Error('host_key_scan_failed'));
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      const match = lines.find((line) => {
        try { return fingerprintOfKnownHost(line) === expectedFingerprint; } catch { return false; }
      });
      if (!match) return reject(new Error('host_fingerprint_mismatch'));
      resolve(match + '\n');
    });
  });
}
