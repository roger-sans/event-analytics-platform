import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, toPubsubRecord } from '../src/event.js';
const sample = () => ({
  schema_version: 1,
  event_id: '30df93d2-7da6-4694-92dd-c027b281aa91',
  app_id: 'museai',
  event_name: 'llm_call',
  event_category: 'backend',
  user_id: 'user-1',
  event_time: '2026-10-27T14:00:00Z',
  app_version: '1.2.0',
  region: 'ES',
  properties: { model: 'quasar-mini', input_tokens: 100, cost_usd: 0.003 }
});
test('valid common envelope and open event properties', () => {
  assert.deepEqual(validateEvent(sample()), []);
  const newEvent = { ...sample(), app_id: 'new_app', event_name: 'totally_new_feature', properties: { unknown: [1, 'a'] } };
  assert.deepEqual(validateEvent(newEvent), []);
});
test('rejects missing event id and malformed category', () => {
  const event = { ...sample(), event_id: '', event_category: 'something' };
  const errors = validateEvent(event).join(' ');
  assert.match(errors, /event_id/);
  assert.match(errors, /event_category/);
});
test('preserves ID; encodes JSON properties for BigQuery subscription', () => {
  const record = toPubsubRecord(sample());
  assert.equal(record.event_id, sample().event_id);
  assert.deepEqual(JSON.parse(record.properties), sample().properties);
  assert.equal(record.some_future_field, undefined);
});

test('rejects impossible calendar timestamps without rejecting valid offsets', () => {
  for (const event_time of ['2026-02-30T14:00:00Z', '2026-13-01T14:00:00Z', '2026-10-27T25:00:00Z', '2026-10-27']) {
    assert.ok(validateEvent({ ...sample(), event_time }).some(x => x.startsWith('event_time')));
  }
  for (const event_time of ['2024-02-29T23:59:59.123456Z', '2026-10-27T14:00:00+02:00']) {
    assert.deepEqual(validateEvent({ ...sample(), event_time }), []);
  }
});

test('known financial amounts reject malformed values and retain exact decimal strings', () => {
  const purchase = { ...sample(), event_name: 'purchase', event_category: 'financial' };
  for (const amount_usd of [undefined, null, 'not-a-number', -1, '', true, {}, '0.0000000001']) {
    assert.ok(validateEvent({ ...purchase, properties: { amount_usd } }).some(x => x.startsWith('amount_usd')));
  }
  for (const amount_usd of [0, 9.99, '9.990000001']) {
    assert.deepEqual(validateEvent({ ...purchase, properties: { amount_usd } }), []);
  }
});

test('LLM token usage may omit monetary cost, but supplied costs must be valid', () => {
  const tokenOnly = { ...sample(), properties: { provider: 'astral-ai', model: 'quasar-mini-2', input_tokens: 812, output_tokens: 245 } };
  assert.deepEqual(validateEvent(tokenOnly), []);
  assert.deepEqual(JSON.parse(toPubsubRecord(tokenOnly).properties), tokenOnly.properties);
  assert.deepEqual(validateEvent({ ...sample(), properties: {} }), []);
  for (const cost_usd of [undefined, null, -1, 'bad', '', true, '0.0000000001']) {
    assert.ok(validateEvent({ ...sample(), properties: { cost_usd } }).some(e => e.startsWith('cost_usd')));
  }
  assert.ok(validateEvent({ ...tokenOnly, event_category: 'engagement' }).some(e => e.includes('event_category')));
  assert.ok(validateEvent({ ...tokenOnly, properties: { ...tokenOnly.properties, input_tokens: 1.5 } }).length);
  assert.deepEqual(validateEvent({ ...tokenOnly, properties: { ...tokenOnly.properties, cost_usd: '0' } }), []);
  assert.deepEqual(validateEvent({ ...tokenOnly, properties: { ...tokenOnly.properties, cost_usd: '0.002' } }), []);
});

test('backend cost contract rejects invalid reported costs without closing new event names', () => {
  for (const event_name of ['backend_cost', 'new_backend_type']) {
    assert.ok(validateEvent({ ...sample(), event_name, properties: { cost_usd: 'oops' } }).length);
    assert.deepEqual(validateEvent({ ...sample(), event_name, properties: { cost_usd: '0.03', component: 'api' } }), []);
  }
  assert.ok(validateEvent({ ...sample(), event_name: 'backend_cost', properties: {} }).length);
  assert.deepEqual(validateEvent({ ...sample(), event_name: 'new_backend_type', properties: { arbitrary: true } }), []);
});

test('install and named feature semantics require an attributable user', () => {
  for (const event_name of ['install', 'feature_used']) {
    assert.ok(validateEvent({ ...sample(), event_name, event_category: 'engagement', user_id: null, properties: { feature: 'chat' } }).length);
  }
  assert.ok(validateEvent({ ...sample(), event_name: 'feature_used', event_category: 'engagement', properties: {} }).length);
  assert.deepEqual(validateEvent({ ...sample(), event_name: 'install', event_category: 'engagement', properties: { source: 'organic' } }), []);
});
