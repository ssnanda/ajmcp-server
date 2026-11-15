import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fingerprintOfKnownHost, scanKnownHost } from '../src/ssh.js';

const line = '203.0.113.10 ssh-ed25519 aGVsbG8=';

test('calculates and verifies an ED25519 known_hosts fingerprint', async () => {
  const fingerprint = fingerprintOfKnownHost(line);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const spawnFn = (command, args) => {
    assert.equal(command, 'ssh-keyscan');
    assert.deepEqual(args, ['-T', '10', '-p', '22', '-t', 'ed25519', '203.0.113.10']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from(line + '\n')); child.emit('close', 0); });
    return child;
  };
  assert.equal(await scanKnownHost('203.0.113.10', 22, fingerprint, spawnFn), line + '\n');
  await assert.rejects(scanKnownHost('203.0.113.10', 22, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', spawnFn), /host_fingerprint_mismatch/);
});

test('rejects malformed known_hosts entries', () => {
  assert.throws(() => fingerprintOfKnownHost('not a host key'), /invalid_known_hosts/);
});
