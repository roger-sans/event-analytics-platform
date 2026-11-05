import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { analyticsQueryOptions } from '../src/query-options.js';
import { analyticsQueries } from '../src/analytics.js';

// Exercise the installed SDK's actual request serializer; only transport is intercepted.
// Route stubs do not catch typed DATE strings being serialized without a value.
for (const app_id of ['smoke_wire_test', undefined]) {
  test(`SDK sends populated DATE parameters for ${app_id ? 'daily' : 'compare'} queries`, async () => {
    const client = new BigQuery({ projectId: 'test-project' });
    let payload;
    client.request = (request, callback) => {
      payload = request.json;
      callback(null, {
        jobComplete: true, schema: { fields: [] }, rows: [], totalRows: '0',
        jobReference: { projectId: 'test-project', jobId: 'local-regression', location: 'EU' },
      });
    };
    const params = { start_date: '2026-10-29', end_date: '2026-10-30' };
    if (app_id) params.app_id = app_id;
    await client.query(analyticsQueryOptions('SELECT @start_date, @end_date', params));
    const bound = Object.fromEntries(payload.queryParameters.map(p => [p.name, p]));
    for (const field of ['start_date', 'end_date']) {
      assert.equal(bound[field].parameterType.type, 'DATE');
      assert.equal(bound[field].parameterValue.value, params[field]);
    }
    if (app_id) assert.equal(bound.app_id.parameterValue.value, app_id);
  });
}

test('comparison SQL does not turn unreported LLM costs into zero on no-call days', () => {
  const sql = analyticsQueries('test-project', 'event_analytics').compare;
  assert.match(sql, /CASE WHEN SUM\(llm_calls\) = 0 THEN 0/);
  assert.match(sql, /SUM\(IF\(llm_calls > 0, llm_cost_usd, NULL\)\)/);
  assert.doesNotMatch(sql, /COALESCE\(llm_cost_usd,\s*0\)/);
});
