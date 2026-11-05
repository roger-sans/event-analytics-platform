import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { AnalyticsBusy, createAnalyticsCache } from './analytics-cache.js';
import { validateEvent, toPubsubRecord } from './event.js';
import { isDateRange } from './dates.js';

const APP = /^[a-z][a-z0-9_]{1,63}$/;

export function buildApp({ publish, queryDaily, queryCompare, queryFeatures, queryCosts, queryLifecycle, queryEvents, ingestApiKey = '', analyticsApiKey = '', analyticsCache = createAnalyticsCache() }) {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
  const instanceId = randomUUID();
  async function analytics(name, query, params, reply) {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Analytics-Instance', instanceId);
    try {
      const key = JSON.stringify([name, params.app_id ?? null, params.start_date, params.end_date]);
      const result = await analyticsCache.get(key, () => query(params));
      reply.header('X-Analytics-Cache', result.status);
      return { data: result.data };
    } catch (err) {
      if (err instanceof AnalyticsBusy) {
        reply.header('Retry-After', '1');
        return reply.code(503).send({ error: 'analytics_busy' });
      }
      throw err;
    }
  }
  app.get('/health', async () => ({ status: 'ok', service: 'event-analytics-platform' }));

  app.post('/v1/events', async (request, reply) => {
    if (ingestApiKey && request.headers['x-api-key'] !== ingestApiKey) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const errors = validateEvent(request.body);
    if (errors.length) return reply.code(400).send({ error: 'invalid_event', details: errors });
    try {
      const messageId = await publish(toPubsubRecord(request.body));
      return reply.code(202).send({ accepted: true, event_id: request.body.event_id, message_id: messageId });
    } catch (err) {
      request.log.error({ err }, 'pubsub_publish_failed');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  });

  for (const [name, query] of Object.entries({ daily: queryDaily, features: queryFeatures, costs: queryCosts, lifecycle: queryLifecycle, events: queryEvents })) {
    app.get('/v1/analytics/' + name, async (request, reply) => {
      if (analyticsApiKey && request.headers['x-api-key'] !== analyticsApiKey) return reply.code(401).send({ error: 'unauthorized' });
      const { app_id, start_date, end_date } = request.query;
      if (typeof app_id !== 'string' || !APP.test(app_id) || !isDateRange(start_date, end_date)) {
        return reply.code(400).send({ error: 'Valid app_id and calendar dates required; max 365 elapsed days' });
      }
      try {
        return await analytics(name, query, { app_id, start_date, end_date }, reply);
      } catch (err) {
        request.log.error({ err }, 'analytics_query_failed');
        return reply.code(503).send({ error: 'analytics_unavailable' });
      }
    });
  }

  app.get('/v1/analytics/compare', async (request, reply) => {
    if (analyticsApiKey && request.headers['x-api-key'] !== analyticsApiKey) return reply.code(401).send({ error: 'unauthorized' });
    const { start_date, end_date } = request.query;
    if (!isDateRange(start_date, end_date)) {
      return reply.code(400).send({ error: 'start_date and end_date are required and must be valid' });
    }
    try {
      return await analytics('compare', queryCompare, { start_date, end_date }, reply);
    } catch (err) {
      request.log.error({ err }, 'analytics_query_failed');
      return reply.code(503).send({ error: 'analytics_unavailable' });
    }
  });

  return app;
}
