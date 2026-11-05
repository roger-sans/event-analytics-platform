import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsCache, AnalyticsBusy } from '../src/analytics-cache.js';
import { buildApp } from '../src/app.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

test('100 simultaneous requests share one query; expiry starts on completion', async () => {
  let now = 0, calls = 0;
  const cache = createAnalyticsCache({ now: () => now, ttlMs: 30, maxWaiters: 100 });
  const gate = deferred();
  const load = () => { calls++; return gate.promise; };
  const requests = Array.from({ length: 100 }, () => cache.get('daily/app/dates', load));
  now = 500; gate.resolve([{ purchases: 1 }]);
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.equal(results.filter(r => r.status === 'MISS').length, 1);
  assert.equal(results.filter(r => r.status === 'COALESCED').length, 99);
  now = 529;
  assert.equal((await cache.get('daily/app/dates', load)).status, 'HIT');
  now = 530;
  assert.equal((await cache.get('daily/app/dates', load)).status, 'MISS');
  assert.equal(calls, 2);
});

test('rejections release capacity and are not cached; overload is bounded', async () => {
  const cache = createAnalyticsCache({ maxInflight: 1, maxWaiters: 1 });
  const gate = deferred();
  const first = cache.get('a', () => gate.promise);
  const joined = cache.get('a', () => assert.fail('must coalesce'));
  await assert.rejects(cache.get('b', () => []), AnalyticsBusy);
  await assert.rejects(cache.get('a', () => []), AnalyticsBusy);
  const failures = Promise.allSettled([first, joined]);
  gate.reject(new Error('warehouse unavailable'));
  assert.equal((await failures).filter(r => r.status === 'rejected').length, 2);
  assert.deepEqual(await cache.get('a', async () => [1]), { data: [1], status: 'MISS' });
});

test('LRU eviction, byte budget, oversized results and disabled mode', async () => {
  const cache = createAnalyticsCache({ maxEntries: 2, maxBytes: 6, maxEntryBytes: 4 });
  const get = key => cache.get(key, async () => [1]); // 3 serialized bytes
  await get('a'); await get('b'); await get('a'); await get('c');
  assert.equal((await get('a')).status, 'HIT');
  assert.equal((await get('b')).status, 'MISS');
  for (let i = 0; i < 2; i++) assert.equal((await cache.get('large', async () => [123456])).status, 'MISS');
  const disabled = createAnalyticsCache({ ttlMs: 0 });
  let calls = 0;
  await Promise.all(Array.from({ length: 4 }, () => disabled.get('a', async () => ++calls)));
  assert.equal(calls, 4);
  assert.equal((await disabled.get('a', async () => 1)).status, 'DISABLED');
  assert.throws(() => createAnalyticsCache({ ttlMs: NaN }));
});

test('HTTP cache respects auth, endpoint/app/date identity and retry headers', async () => {
  let calls = 0;
  const app = buildApp({ analyticsApiKey: 'key', queryDaily: async p => { calls++; return [p]; },
    queryFeatures: async () => { calls++; return []; } });
  const url = '/v1/analytics/daily?app_id=museai&start_date=2026-10-01&end_date=2026-10-02';
  const get = path => app.inject({ url: path, headers: { 'x-api-key': 'key' } });
  assert.equal((await get(url)).headers['x-analytics-cache'], 'MISS');
  const hit = await get(url);
  assert.equal(hit.headers['x-analytics-cache'], 'HIT');
  assert.equal(hit.headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ url })).statusCode, 401);
  await get(url.replace('museai', 'storyhub'));
  await get(url.replace('2026-10-02', '2026-10-03'));
  await get(url.replace('/daily?', '/features?'));
  assert.equal(calls, 4);
  await app.close();
  const busy = buildApp({ analyticsCache: { get: async () => { throw new AnalyticsBusy(); } } });
  const response = await busy.inject({ url });
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(response.json().error, 'analytics_busy');
  await busy.close();
});
