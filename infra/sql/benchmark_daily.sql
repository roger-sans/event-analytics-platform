-- Baseline: recompute the same daily contract from append-only rows on each query.
WITH events AS (
  SELECT DATE(event_time) AS event_date, event_id, app_id, event_name,
    event_category, user_id, event_time, properties
  FROM `BENCHMARK_TABLE_PREFIX.raw_events`
  WHERE DATE(event_time) BETWEEN @start_date AND @end_date AND app_id = @app_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY app_id, event_id ORDER BY publish_time, message_id) = 1
)
SELECT event_date AS metric_date, app_id,
  COUNT(DISTINCT IF(event_category = 'engagement', user_id, NULL)) AS dau,
  COUNT(DISTINCT IF(event_name IN ('purchase', 'renewal'), user_id, NULL)) AS paying_users,
  COUNTIF(event_name IN ('purchase', 'renewal')) AS purchases,
  SUM(CASE
    WHEN event_name IN ('purchase', 'renewal') THEN COALESCE(SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC), 0)
    WHEN event_name = 'refund' THEN -COALESCE(SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC), 0)
    ELSE 0 END) AS revenue_usd,
  COUNTIF(event_name = 'feature_used') AS feature_events,
  COUNTIF(event_name = 'llm_call') AS llm_calls,
  SUM(IF(event_name = 'llm_call', COALESCE(SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC), 0), 0)) AS llm_cost_usd,
  COUNTIF(event_name = 'backend_error') AS backend_errors,
  SUM(IF(event_category = 'backend' AND event_name != 'llm_call', SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC), NULL)) AS backend_cost_usd,
  COUNTIF(event_category = 'backend' AND event_name != 'llm_call' AND JSON_VALUE(properties, '$.cost_usd') IS NOT NULL) AS backend_cost_events
FROM events
GROUP BY metric_date, app_id
ORDER BY metric_date;
