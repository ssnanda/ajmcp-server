// Recent requests, newest last, kept in memory (a restart clears it) so the admin can see whether a request
// even reached the server and what happened to it. Never holds message text, tokens or passwords.
const FIELDS = ['t', 'requestId', 'method', 'route', 'status', 'ms', 'site', 'via', 'channel', 'sessionId', 'chars', 'assistant', 'routedFrom', 'provider', 'error', 'host'];

export class ActivityLog {
  constructor(max = 300) { this.max = max; this.items = []; this.since = new Date().toISOString(); }

  add(entry) {
    const clean = {};
    for (const key of FIELDS) {
      const v = entry[key];
      if (v === undefined || v === null || v === '') continue;
      clean[key] = typeof v === 'string' ? v.slice(0, 120) : v;
    }
    this.items.push(clean);
    if (this.items.length > this.max) this.items.shift();
  }

  clear() { this.items = []; }

  /** Newest first. `problemsOnly` keeps entries that failed (status >= 400 or an error code). */
  list({ limit = 100, problemsOnly = false } = {}) {
    const rows = [];
    for (let i = this.items.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      const e = this.items[i];
      if (problemsOnly && !(e.status >= 400 || e.error)) continue;
      rows.push(e);
    }
    return rows;
  }
}
