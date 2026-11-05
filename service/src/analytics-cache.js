import { performance } from 'node:perf_hooks';

export class AnalyticsBusy extends Error {}

// Authentication and validation must precede get(). This cache belongs to one process.
export function createAnalyticsCache({ ttlMs = 30_000, maxEntries = 128,
  maxBytes = 8 * 1024 * 1024, maxEntryBytes = 1024 * 1024,
  maxInflight = 8, maxWaiters = 64, now = () => performance.now() } = {}) {
  for (const [name, value] of Object.entries({ ttlMs, maxEntries, maxBytes, maxEntryBytes, maxInflight, maxWaiters })) {
    if (!Number.isSafeInteger(value) || value < 0 || (name === 'maxInflight' && value === 0)) {
      throw new Error('Invalid analytics cache option: ' + name);
    }
  }
  const entries = new Map(), pending = new Map();
  let bytes = 0, active = 0, waiters = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  function prune() {
    for (const [key, entry] of entries) if (entry.expires <= now()) remove(key);
  }
  async function get(key, load) {
    prune();
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key); entries.set(key, hit);
      return { data: hit.data, status: 'HIT' };
    }
    // TTL=0 disables storage and coalescing for a controlled baseline.
    if (ttlMs > 0 && pending.has(key)) {
      if (waiters >= maxWaiters) throw new AnalyticsBusy('Analytics waiter limit');
      waiters++;
      try { return { data: await pending.get(key), status: 'COALESCED' }; }
      finally { waiters--; }
    }
    if (active >= maxInflight) throw new AnalyticsBusy('Analytics query limit');
    active++;
    const promise = (async () => {
      const data = await load();
      if (ttlMs > 0 && maxEntries > 0) {
        const size = Buffer.byteLength(JSON.stringify(data));
        if (size <= maxEntryBytes && size <= maxBytes) {
          prune();
          while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) remove(entries.keys().next().value);
          entries.set(key, { data, bytes: size, expires: now() + ttlMs });
          bytes += size;
        }
      }
      return data;
    })();
    if (ttlMs > 0) pending.set(key, promise);
    try { return { data: await promise, status: ttlMs > 0 ? 'MISS' : 'DISABLED' }; }
    finally { active--; pending.delete(key); }
  }
  return { get };
}
