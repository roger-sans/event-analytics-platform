import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
const sample = {
  schema_version: 1, event_id: '30df93d2-7da6-4694-92dd-c027b281aa91',
  app_id: 'museai', event_name: 'feature_used', event_category: 'engagement',
  event_time: '2026-10-27T14:00:00Z', user_id: 'u1', properties: { feature: 'chat' }
};
test('HTTP ingestion accepts valid event and rejects malformed', async () => {
  let sent = 0;
  const app = buildApp({ publish: async () => { sent++; return 'm1'; }, queryDaily: async () => [], queryCompare: async () => [] });
  const accepted = await app.inject({ method: 'POST', url: '/v1/events', payload: sample });
  assert.equal(accepted.statusCode, 202);
  assert.equal(sent, 1);
  const rejected = await app.inject({ method: 'POST', url: '/v1/events', payload: { ...sample, event_id: 'bad' } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(sent, 1);
  await app.close();
});
test('authenticated HTTP accepts token-only LLM usage but rejects a supplied invalid cost', async () => {
  const published = [];
  const app = buildApp({ ingestApiKey: 'test-ingest', publish: async record => {
    published.push(record);
    return 'llm-message';
  } });
  const llm = { ...sample, event_name: 'llm_call', event_category: 'backend',
    properties: { provider: 'astral-ai', model: 'quasar-mini-2', input_tokens: 812, output_tokens: 245 } };
  const request = payload => app.inject({
    method: 'POST', url: '/v1/events', headers: { 'x-api-key': 'test-ingest' }, payload,
  });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', payload: llm })).statusCode, 401);
  const accepted = await request(llm);
  assert.equal(accepted.statusCode, 202);
  assert.equal(published.length, 1);
  assert.deepEqual(JSON.parse(published[0].properties), llm.properties);
  assert.equal((await request({ ...llm, properties: { ...llm.properties, cost_usd: 'invalid' } })).statusCode, 400);
  assert.equal(published.length, 1);
  await app.close();
});

test('health and daily analytics route', async () => {
  const app = buildApp({ publish: async () => 'm1', queryDaily: async () => [{ dau: 20 }], queryCompare: async () => [] });
  const h = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(h.statusCode, 200);
  const d = await app.inject({ method: 'GET', url: '/v1/analytics/daily?app_id=museai&start_date=2026-10-01&end_date=2026-10-27' });
  assert.equal(d.statusCode, 200);
  assert.equal(d.json().data[0].dau, 20);
  await app.close();
});

test('private analytics endpoint requires a configured demo key', async () => {
  const app = buildApp({ publish: async () => 'm1', queryDaily: async () => [], queryCompare: async () => [], analyticsApiKey: 'test-read-key' });
  const url = '/v1/analytics/compare?start_date=2026-10-01&end_date=2026-10-27';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url, headers: {'x-api-key': 'test-read-key'} })).statusCode, 200);
  await app.close();
});

test('invalid calendar dates and unbounded ranges never reach BigQuery', async () => {
  let queried = 0;
  const app = buildApp({ publish: async () => 'm1', queryDaily: async () => { queried++; return []; }, queryCompare: async () => { queried++; return []; } });
  for (const range of ['start_date=2026-02-30&end_date=2026-03-03', 'start_date=2020-01-01&end_date=2026-01-01']) {
    for (const route of ['daily?app_id=museai&', 'compare?']) {
      assert.equal((await app.inject({ url: '/v1/analytics/' + route + range })).statusCode, 400);
    }
  }
  assert.equal(queried, 0);
  await app.close();
});

test('ingress rejects invalid financial data and retries retain the event ID', async () => {
  const published = [];
  const app = buildApp({ publish: async record => { published.push(record); return 'm1'; } });
  const purchase = { ...sample, event_name: 'purchase', event_category: 'financial', properties: { amount_usd: '9.99' } };
  const bad = await app.inject({ method: 'POST', url: '/v1/events', payload: { ...purchase, properties: { amount_usd: 'bad' } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(published.length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: '/v1/events', payload: purchase })).statusCode, 202);
  assert.equal(published.length, 2); // ingress acknowledges retries; BQ facts perform deduplication.
  assert.equal(published[0].event_id, published[1].event_id);
  await app.close();
});

test('publisher failure returns retryable 503', async () => {
  const app = buildApp({ publish: async () => { throw new Error('simulated transport outage'); } });
  assert.equal((await app.inject({ method: 'POST', url: '/v1/events', payload: sample })).statusCode, 503);
  await app.close();
});

for (const [route, dependency] of Object.entries({ features: 'queryFeatures', costs: 'queryCosts', lifecycle: 'queryLifecycle', events: 'queryEvents' })) {
  test(`${route}: authentication, invalid ranges and valid scoped dispatch`, async () => {
    const seen = [];
    const app = buildApp({ publish: async () => 'm', analyticsApiKey: 'read-key', [dependency]: async params => { seen.push(params); return [{ app_id: params.app_id }]; } });
    const path = '/v1/analytics/' + route + '?app_id=new_app&start_date=2026-10-01&end_date=2026-10-10';
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    assert.equal((await app.inject({ url: path.replace('2026-10-01', '2026-02-30'), headers: { 'x-api-key': 'read-key' } })).statusCode, 400);
    const result = await app.inject({ url: path, headers: { 'x-api-key': 'read-key' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data[0].app_id, 'new_app');
    assert.deepEqual(seen, [{ app_id: 'new_app', start_date: '2026-10-01', end_date: '2026-10-10' }]);
    await app.close();
  });
}
