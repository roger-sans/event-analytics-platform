-- Baseline: identity deduplication plus feature/user aggregation on every query.
WITH events AS (
  SELECT DATE(event_time) AS event_date, event_id, app_id, event_name, user_id, properties
  FROM `BENCHMARK_TABLE_PREFIX.raw_events`
  WHERE DATE(event_time) BETWEEN @start_date AND @end_date AND app_id = @app_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY app_id, event_id ORDER BY publish_time, message_id) = 1
)
SELECT event_date AS metric_date, app_id,
  COALESCE(NULLIF(JSON_VALUE(properties, '$.feature'), ''), 'unknown') AS feature,
  COUNT(*) AS events, COUNT(DISTINCT user_id) AS users
FROM events WHERE event_name = 'feature_used'
GROUP BY metric_date, app_id, feature
ORDER BY metric_date, feature;
