import { PubSub } from '@google-cloud/pubsub';
import { BigQuery } from '@google-cloud/bigquery';
import { buildApp } from './app.js';
import { analyticsQueryOptions } from './query-options.js';
import { createAnalyticsCache } from './analytics-cache.js';
import { analyticsQueries } from './analytics.js';

const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
const topicId = process.env.PUBSUB_TOPIC_ID || 'app-events';
const datasetId = process.env.BIGQUERY_DATASET || 'event_analytics';
const port = Number(process.env.PORT || 8080);
if (!projectId) throw new Error('Missing GCP_PROJECT_ID');
if (process.env.NODE_ENV === 'production' && (!process.env.INGEST_API_KEY || !process.env.ANALYTICS_API_KEY)) {
  throw new Error('INGEST_API_KEY and ANALYTICS_API_KEY required in production');
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(datasetId)) throw new Error('Invalid BIGQUERY_DATASET');

const pubsub = new PubSub({ projectId });
const topic = pubsub.topic(topicId);
const bigquery = new BigQuery({ projectId });
const queries = analyticsQueries(projectId, datasetId);

async function runQuery(query, params) {
  const [rows] = await bigquery.query(analyticsQueryOptions(query, params, process.env.BIGQUERY_LOCATION || 'EU'));
  return rows.map((row) => ({ ...row, metric_date: row.metric_date?.value ?? row.metric_date }));
}

const cacheTtlMs = Number(process.env.ANALYTICS_CACHE_TTL_MS ?? 30000);
const app = buildApp({
  analyticsCache: createAnalyticsCache({ ttlMs: cacheTtlMs }),
  ingestApiKey: process.env.INGEST_API_KEY || '',
  analyticsApiKey: process.env.ANALYTICS_API_KEY || '',
  publish: async (record) => {
    const data = Buffer.from(JSON.stringify(record), 'utf8');
    return String(await topic.publishMessage({ data }));
  },
  queryDaily: params => runQuery(queries.daily, params),
  queryCompare: params => runQuery(queries.compare, params),
  queryFeatures: params => runQuery(queries.features, params),
  queryCosts: params => runQuery(queries.costs, params),
  queryLifecycle: params => runQuery(queries.lifecycle, params),
  queryEvents: params => runQuery(queries.events, params),
});

try {
  await app.listen({ host: '0.0.0.0', port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
