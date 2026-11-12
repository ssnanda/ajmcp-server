// Record of lead-save attempts (not their contents): when, which site and chat, what happened, which AJCore lead.
// No names, emails or phone numbers are kept here; the admin reads those live from AJCore.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_EVENTS = 1000;
const DAY = 86_400_000;

export class LeadLog {
  constructor(dataDir) {
    this.dir = dataDir || '';
    this.file = this.dir ? join(this.dir, 'lead-events.json') : '';
    this.events = [];
    if (this.file) {
      try { const data = JSON.parse(readFileSync(this.file, 'utf8')); if (Array.isArray(data)) this.events = data.slice(-MAX_EVENTS); } catch { /* none yet */ }
    }
  }

  add(event) {
    const entry = {
      id: randomBytes(5).toString('hex'),
      time: new Date().toISOString(),
      siteId: String(event.siteId),
      conversationId: String(event.conversationId || ''),
      status: event.status,                     // created | updated | failed
      leadId: Number.isInteger(event.leadId) ? event.leadId : null,
      matchedBy: event.matchedBy || null,
      error: event.error ? String(event.error).slice(0, 80) : '',
      services: Array.isArray(event.services) ? event.services.slice(0, 5) : [],
      entityStatus: event.entityStatus || ''
    };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.persist();
    return entry;
  }

  persist() {
    if (!this.file) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.events), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* in-memory only until the next successful write */ }
  }

  forSite(siteId, limit = 50) { return this.events.filter((e) => e.siteId === siteId).slice(-limit).reverse(); }

  counts(siteId, days = 30, now = Date.now()) {
    const out = { created: 0, updated: 0, failed: 0, days };
    for (const e of this.events) if (e.siteId === siteId && now - Date.parse(e.time) <= days * DAY) out[e.status] += 1;
    return out;
  }

  removeSite(siteId) { this.events = this.events.filter((e) => e.siteId !== siteId); this.persist(); }
}
