import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreebuffTerminal, freebuffLoggedIn } from '../src/freebuff-terminal.js';

function fakePty() {
  const events = new EventEmitter();
  const child = {
    writes: [], dimensions: [], killed: false,
    onData: (fn) => events.on('data', fn), onExit: (fn) => events.on('exit', fn),
    write(data) { this.writes.push(data); }, resize(cols, rows) { this.dimensions.push([cols, rows]); },
    kill() { this.killed = true; events.emit('exit', { exitCode: 0, signal: 0 }); }
  };
  return { child, module: { spawn: () => child }, events };
}

test('Freebuff login detection accepts a saved auth token without exposing it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ajmcp-freebuff-'));
  const dir = join(dataDir, 'home', '.config', 'manicode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ default: { authToken: 'secret' } }));
  assert.equal(freebuffLoggedIn({ dataDir }), true);
  writeFileSync(join(dir, 'credentials.json'), '{}');
  assert.equal(freebuffLoggedIn({ dataDir }), false);
});

test('Freebuff terminal bounds dimensions, forwards data, and stops the PTY', async () => {
  const pty = fakePty();
  const config = { dataDir: mkdtempSync(join(tmpdir(), 'ajmcp-freebuff-')), agentWorkspace: mkdtempSync(join(tmpdir(), 'ajmcp-work-')) };
  const terminal = new FreebuffTerminal(config, { loadPty: async () => pty.module });
  const output = [];
  terminal.subscribe((message) => output.push(message));
  await terminal.start({ cols: 2, rows: 999 });
  pty.events.emit('data', '\u001b[32mready\u001b[0m');
  terminal.input('hello');
  terminal.resize(100, 40);
  assert.deepEqual(pty.child.writes, ['hello']);
  assert.deepEqual(pty.child.dimensions, [[100, 40]]);
  assert.match(output.join(''), /ready/);
  terminal.stop('test');
  assert.equal(pty.child.killed, true);
  assert.equal(terminal.status().running, false);
});
