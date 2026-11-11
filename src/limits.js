export class Limiter {
  constructor({ rateLimitPerMinute, maxConcurrent }, now = () => Date.now()) {
    this.rate = rateLimitPerMinute;
    this.maxConcurrent = maxConcurrent;
    this.now = now;
    this.buckets = new Map();
    this.active = 0;
  }
  acquire(identity) {
    const key = identity.id;
    const tick = this.now();
    const existing = this.buckets.get(key) || { window: tick, used: 0 };
    const current = tick - existing.window >= 60_000 ? { window: tick, used: 0 } : existing;
    if (current.used >= this.rate) return { ok: false, code: 'rate_limit', status: 429 };
    if (this.active >= this.maxConcurrent) return { ok: false, code: 'busy', status: 503 };
    current.used += 1;
    this.buckets.set(key, current);
    this.active += 1;
    // Bound memory as tenants/keys are rotated.
    if (this.buckets.size > 2048) {
      for (const [id, bucket] of this.buckets) {
        if (tick - bucket.window > 120_000) this.buckets.delete(id);
      }
    }
    let released = false;
    return { ok: true, release: () => { if (!released) { released = true; this.active -= 1; } } };
  }
}
