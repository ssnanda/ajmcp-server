// Recent requests, newest last, kept only in memory (a restart clears it). Chat transcripts are bounded and
// visible only through the authenticated admin API. Tokens, credentials and arbitrary request bodies are excluded.
const FIELDS = ['t', 'requestId', 'method', 'route', 'status', 'ms', 'site', 'via', 'channel', 'sessionId', 'chars', 'assistant', 'routedFrom', 'provider', 'model', 'error', 'host'];
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
  constructor(max = 300) { this.max = max; this.items = []; this.since = new Date().toISOString(); }

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
