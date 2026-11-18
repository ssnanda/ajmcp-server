// Recent requests, newest last, kept only in memory (a restart clears it). Chat transcripts are bounded and
// visible only through the authenticated admin API. Tokens, credentials and arbitrary request bodies are excluded.
const FIELDS = ['t', 'requestId', 'method', 'route', 'status', 'ms', 'site', 'via', 'channel', 'sessionId', 'conversation', 'purpose', 'chars', 'assistant', 'routedFrom', 'provider', 'model', 'error', 'host'];
const TRANSCRIPT_ROLES = new Set(['user', 'assistant', 'tool']);

function cleanTranscript(raw) {
  if (!Array.isArray(raw)) return undefined;
  let remaining = 20000;
  const out = [];
  for (const item of raw.slice(-40)) {
    if (!item || !TRANSCRIPT_ROLES.has(item.role) || typeof item.content !== 'string' || remaining <= 0) continue;
    const content = item.content.slice(0, Math.min(4000, remaining));
    remaining -= content.length;
    out.push({ role: item.role, content, ...(item.name ? { name: String(item.name).slice(0, 48) } : {}) });
  }
  return out.length ? out : undefined;
}

export class ActivityLog {
  constructor(max = 300) { this.max = max; this.items = []; this.running = new Set(); this.since = new Date().toISOString(); }

  add(entry) {
    const clean = {};
    for (const key of FIELDS) {
      const v = entry[key];
      if (v === undefined || v === null || v === '') continue;
      clean[key] = typeof v === 'string' ? v.slice(0, 120) : v;
    }
    const transcript = cleanTranscript(entry.transcript);
    if (transcript) clean.transcript = transcript;
    this.items.push(clean);
    if (this.items.length > this.max) this.items.shift();
  }

  clear() { this.items = []; }

  /** Marks a request as running until `end` (a slow model call would otherwise show nothing until it finishes). Returns a handle. */
  start(base, note) {
    const live = { base, note, start: Date.now() };
    this.running.add(live);
    return live;
  }
  end(live) { this.running.delete(live); }

  /** Newest first. `problemsOnly` keeps entries that failed (status >= 400 or an error code). */
  list({ limit = 100, problemsOnly = false } = {}) {
    const rows = [];
    for (const live of [...this.running].reverse()) {
      const n = live.note || {};
      const e = { ...live.base, ...Object.fromEntries(FIELDS.filter((k) => n[k] !== undefined && n[k] !== null && n[k] !== '').map((k) => [k, typeof n[k] === 'string' ? n[k].slice(0, 120) : n[k]])), status: 0, running: true, ms: Date.now() - live.start };
      if (!problemsOnly) rows.push(e);
    }
    for (let i = this.items.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      const e = this.items[i];
      if (problemsOnly && !(e.status >= 400 || e.error)) continue;
      rows.push(e);
    }
    return rows;
  }
}
