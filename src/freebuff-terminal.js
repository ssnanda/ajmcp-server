// Admin-only interactive Freebuff terminal. Freebuff has no headless/print mode, so it must own a PTY.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BACKLOG = 256 * 1024;
const IDLE_MS = 30 * 60 * 1000;
const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

const dimensions = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function freebuffLoggedIn(config) {
  const file = join(config.dataDir ? join(config.dataDir, 'home') : (process.env.HOME || '/tmp'), '.config', 'manicode', 'credentials.json');
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Boolean(data && typeof data === 'object' && Object.values(data).some((entry) =>
      entry && typeof entry === 'object' && (typeof entry.authToken === 'string' || entry.tokenStore === 'keychain')));
  } catch { return false; }
}

export class FreebuffTerminal {
  constructor(config, { loadPty = () => import('node-pty') } = {}) {
    this.config = config;
    this.loadPty = loadPty;
    this.terminal = null;
    this.startedAt = 0;
    this.lastActivity = 0;
    this.backlog = '';
    this.listeners = new Set();
    this.idleTimer = null;
    this.maxTimer = null;
    this.reason = '';
  }

  status() {
    return { installed: existsSync('/usr/local/bin/freebuff') || Boolean(process.env.FREEBUFF_BINARY), loggedIn: freebuffLoggedIn(this.config), running: Boolean(this.terminal), startedAt: this.startedAt || null };
  }

  emit(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const listener of this.listeners) listener(message);
  }

  touch() {
    this.lastActivity = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop('idle_timeout'), IDLE_MS);
    this.idleTimer.unref?.();
  }

  async start({ cols, rows } = {}) {
    if (this.terminal) return this.status();
    const home = this.config.dataDir ? join(this.config.dataDir, 'home') : (process.env.HOME || '/tmp');
    const cwd = join(this.config.agentWorkspace, 'freebuff');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let pty;
    try { pty = await this.loadPty(); }
    catch { throw Object.assign(new Error('freebuff_terminal_unavailable'), { status: 503 }); }
    const binary = process.env.FREEBUFF_BINARY || 'freebuff';
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home,
      LANG: 'C.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', DISABLE_AUTOUPDATER: '1'
    };
    try {
      this.terminal = pty.spawn(binary, [], {
        name: 'xterm-256color', cols: dimensions(cols, 120, 40, 300), rows: dimensions(rows, 36, 10, 120),
        cwd, env
      });
    } catch { throw Object.assign(new Error('freebuff_unavailable'), { status: 503 }); }
    this.startedAt = this.lastActivity = Date.now();
    this.backlog = '';
    this.reason = '';
    this.terminal.onData((data) => {
      this.backlog = (this.backlog + String(data)).slice(-MAX_BACKLOG);
      this.emit('output', String(data));
    });
    this.terminal.onExit(({ exitCode, signal }) => {
      this.terminal = null;
      clearTimeout(this.idleTimer);
      clearTimeout(this.maxTimer);
      this.reason = this.reason || 'exited';
      this.emit('exit', { exitCode, signal, reason: this.reason });
    });
    this.touch();
    this.maxTimer = setTimeout(() => this.stop('session_limit'), MAX_SESSION_MS);
    this.maxTimer.unref?.();
    return this.status();
  }

  input(data) {
    if (!this.terminal) throw Object.assign(new Error('freebuff_not_running'), { status: 409 });
    if (typeof data !== 'string' || !data || data.length > 8192) throw Object.assign(new Error('invalid_terminal_input'), { status: 400 });
    this.terminal.write(data);
    this.touch();
  }

  resize(cols, rows) {
    if (!this.terminal) throw Object.assign(new Error('freebuff_not_running'), { status: 409 });
    this.terminal.resize(dimensions(cols, 120, 40, 300), dimensions(rows, 36, 10, 120));
    this.touch();
  }

  stop(reason = 'stopped') {
    if (!this.terminal) return;
    this.reason = reason;
    this.terminal.kill();
  }

  subscribe(write) {
    this.listeners.add(write);
    if (this.backlog) write(`event: output\ndata: ${JSON.stringify(this.backlog)}\n\n`);
    write(`event: status\ndata: ${JSON.stringify(this.status())}\n\n`);
    return () => this.listeners.delete(write);
  }
}
