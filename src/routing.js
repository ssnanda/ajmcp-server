// Routing for text-message conversations. A conversation starts on the assistant whose token the caller used (the
// front desk). That assistant may pass the customer to another assistant it is allowed to transfer to; the server
// validates every transfer, remembers who is active, and answers the same message as the new assistant so the
// customer never repeats themselves and only one assistant ever replies.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runChat } from './chat.js';

export const MAX_HOPS = 4;                       // transfers per conversation before further ones are ignored
export const IDLE_RESET_MS = 24 * 60 * 60 * 1000; // a quiet conversation starts again at the front desk
const MAX_CONVERSATIONS = 5000;
export const KEY_RE = /^[A-Za-z0-9:|+._-]{4,80}$/;
const RESET_RE = /^\s*(menu|main menu|start over|restart)\s*[.!]*\s*$/i;

/** Durable per-conversation state in DATA_DIR/conversations.json (atomic writes, bounded size, 24h idle expiry). */
export class ConversationStore {
  constructor(dataDir, now = () => Date.now()) {
    this.file = dataDir ? join(dataDir, 'conversations.json') : '';
    this.now = now;
    this.map = new Map();
    this.timer = null;
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data.conversations || {})) this.map.set(k, v);
    } catch (error) { if (error.code !== 'ENOENT') console.error('conversations.json unreadable, starting empty'); }
  }

  static id(entryId, key) { return `${entryId}|${key}`; }

  get(entryId, key) {
    const record = this.map.get(ConversationStore.id(entryId, key));
    if (!record) return null;
    if (this.now() - record.updatedAt > IDLE_RESET_MS) { this.map.delete(ConversationStore.id(entryId, key)); return null; }
    return record;
  }

  set(entryId, key, record) {
    this.map.set(ConversationStore.id(entryId, key), { ...record, updatedAt: this.now() });
    if (this.map.size > MAX_CONVERSATIONS) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt).slice(0, this.map.size - MAX_CONVERSATIONS);
      for (const [k] of oldest) this.map.delete(k);
    }
    this.schedule();
  }

  schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ conversations: Object.fromEntries(this.map) }) + '\n', { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) { console.error('could not save conversations.json', error.code || error.message); }
  }
}

const usable = (config, id) => config.sites.find((s) => s.id === id && !s.disabled) || null;

const routingFor = (config, site, arrivedFrom) => ({
  targets: (site.transferTargets || []).map((id) => config.sites.find((s) => s.id === id && !s.disabled)).filter(Boolean).map((s) => ({ id: s.id, label: s.routeLabel || '' })),
  arrivedFrom: arrivedFrom || null
});

/**
 * Answers one text message for a routed conversation. Returns the usual chat result plus `assistant` (who answered)
 * and, when the customer was moved on this message, `routed: { from, to, reason }`.
 */
export async function routeChat({ entry, convs, key, messages, context, config, fetchFn, limiter, log = () => {} }) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const previous = convs.get(entry.id, key);
  let state = previous ? { ...previous, transfers: [...(previous.transfers || [])] } : { active: entry.id, hops: 0, transfers: [] };
  if (RESET_RE.test(lastUser)) { state = { active: entry.id, hops: 0, transfers: [] }; log('reset_to_front_desk'); }

  let active = usable(config, state.active);
  if (!active) { active = entry; state.active = entry.id; log('active_unavailable_reset'); }

  const ask = (site, arrivedFrom) => runChat({ site, messages, context: { ...context, routing: routingFor(config, site, arrivedFrom) }, config, fetchFn, limiter });
  let result = await ask(active, null);
  let routed;

  if (result.transfer) {
    const { target, reason } = result.transfer;
    const dest = usable(config, target);
    const allowed = (active.transferTargets || []).includes(target) && target !== active.id;
    if (!dest || !allowed) log(`transfer_refused:${target}`);
    else if (state.hops >= MAX_HOPS) log('transfer_refused:hop_limit');
    else {
      const from = active.id;
      state.hops += 1;
      state.transfers = [...state.transfers, { from, to: dest.id, reason, at: new Date(convs.now()).toISOString() }].slice(-10);
      state.active = dest.id;
      active = dest;
      routed = { from, to: dest.id, reason };
      log(`transferred:${from}->${dest.id}`);
      // The new assistant answers this same message. A second transfer in the same turn is ignored.
      try { result = await ask(dest, { from, reason }); }
      catch (error) { state.active = from; active = usable(config, from) || entry; routed = undefined; convs.set(entry.id, key, state); throw error; }
    }
  }
  convs.set(entry.id, key, state);
  const { transfer, ...answer } = result;
  return { ...answer, assistant: active.id, ...(routed ? { routed } : {}) };
}
