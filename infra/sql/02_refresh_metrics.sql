-- Explicit UTC bounds also allow backfills. Call with DATE parameters start_date/end_date.
-- Identity: (app_id,event_id); an ID is immutable. Existing facts win on replay.
-- Global target matching preserves identity across backfills, at the cost of target scans.
DECLARE window_start DATE DEFAULT @start_date;
DECLARE window_end DATE DEFAULT @end_date;
ASSERT window_start IS NOT NULL AND window_end IS NOT NULL AND window_start <= window_end AS 'Valid date bounds required';
BEGIN TRANSACTION;
-- Fail visibly instead of silently turning malformed known metrics into zero.
-- Ingress protects the normal path; this also catches direct topic publishers.
ASSERT NOT EXISTS (
  SELECT 1 FROM `PROJECT_ID.event_analytics.raw_events`
  WHERE DATE(event_time) BETWEEN window_start AND window_end
    AND (
      (event_name IN ('purchase', 'renewal', 'refund') AND
        (event_category != 'financial' OR event_category IS NULL OR
         SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC) IS NULL OR
         SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC) < 0))
      OR (event_category = 'backend' AND JSON_QUERY(properties, '$.cost_usd') IS NOT NULL AND
        (SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC) IS NULL OR
         SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC) < 0))
      OR (event_name = 'llm_call' AND
        (event_category != 'backend' OR event_category IS NULL))
      OR (event_name = 'backend_cost' AND
        (event_category != 'backend' OR event_category IS NULL OR
         SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC) IS NULL OR
         SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC) < 0))
    )
) AS 'Malformed known metric in raw_events; inspect data before refresh';
MERGE `PROJECT_ID.event_analytics.fact_events` AS target
USING (
  SELECT DATE(event_time) AS event_date, event_id, app_id, event_name,
    event_category, user_id, event_time, properties
  FROM `PROJECT_ID.event_analytics.raw_events`
  WHERE DATE(event_time) BETWEEN window_start AND window_end
    AND event_id IS NOT NULL
    AND app_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY app_id, event_id ORDER BY publish_time ASC, message_id ASC) = 1
) AS source
ON target.app_id = source.app_id AND target.event_id = source.event_id
WHEN NOT MATCHED THEN
  INSERT (event_date, event_id, app_id, event_name, event_category, user_id, event_time, properties)
  VALUES (source.event_date, source.event_id, source.app_id, source.event_name,
          source.event_category, source.user_id, source.event_time, source.properties);

DELETE FROM `PROJECT_ID.event_analytics.daily_metrics`
WHERE metric_date BETWEEN window_start AND window_end;

INSERT INTO `PROJECT_ID.event_analytics.daily_metrics`
(metric_date, app_id, dau, paying_users, purchases, revenue_usd, feature_events, llm_calls, llm_cost_usd, backend_errors, backend_cost_usd, backend_cost_events)
SELECT
  event_date AS metric_date,
  app_id,
  COUNT(DISTINCT IF(event_category = 'engagement', user_id, NULL)) AS dau,
  COUNT(DISTINCT IF(event_name IN ('purchase', 'renewal'), user_id, NULL)) AS paying_users,
  COUNTIF(event_name IN ('purchase', 'renewal')) AS purchases,
  SUM(CASE
    WHEN event_name IN ('purchase', 'renewal') THEN COALESCE(SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC), 0)
    WHEN event_name = 'refund' THEN -COALESCE(SAFE_CAST(JSON_VALUE(properties, '$.amount_usd') AS NUMERIC), 0)
    ELSE 0 END) AS revenue_usd,
  COUNTIF(event_name = 'feature_used') AS feature_events,
  COUNTIF(event_name = 'llm_call') AS llm_calls,
  CASE
    WHEN COUNTIF(event_name = 'llm_call') = 0 THEN 0
    ELSE SUM(IF(event_name = 'llm_call', SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC), NULL))
  END AS llm_cost_usd,
  COUNTIF(event_name = 'backend_error') AS backend_errors,
  SUM(IF(event_category = 'backend' AND event_name != 'llm_call', SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC), NULL)) AS backend_cost_usd,
  COUNTIF(event_category = 'backend' AND event_name != 'llm_call' AND JSON_VALUE(properties, '$.cost_usd') IS NOT NULL) AS backend_cost_events
FROM `PROJECT_ID.event_analytics.fact_events`
WHERE event_date BETWEEN window_start AND window_end
GROUP BY metric_date, app_id;


DELETE FROM `PROJECT_ID.event_analytics.daily_features`
WHERE metric_date BETWEEN window_start AND window_end;
INSERT INTO `PROJECT_ID.event_analytics.daily_features`
SELECT event_date, app_id, COALESCE(NULLIF(JSON_VALUE(properties, '$.feature'), ''), 'unknown'),
  COUNT(*), COUNT(DISTINCT user_id)
FROM `PROJECT_ID.event_analytics.fact_events`
WHERE event_date BETWEEN window_start AND window_end AND event_name = 'feature_used'
GROUP BY 1, 2, 3;

DELETE FROM `PROJECT_ID.event_analytics.daily_costs`
WHERE metric_date BETWEEN window_start AND window_end;
INSERT INTO `PROJECT_ID.event_analytics.daily_costs`
SELECT event_date, app_id, IF(event_name = 'llm_call', 'llm', 'backend'),
  COALESCE(JSON_VALUE(properties, '$.provider'), 'unknown'),
  IF(event_name = 'llm_call', COALESCE(JSON_VALUE(properties, '$.model'), 'unknown'), 'not_applicable'),
  COALESCE(JSON_VALUE(properties, '$.component'), 'unknown'),
  COUNT(*), COUNTIF(JSON_VALUE(properties, '$.cost_usd') IS NOT NULL),
  SUM(SAFE_CAST(JSON_VALUE(properties, '$.cost_usd') AS NUMERIC)),
  SUM(IF(event_name = 'llm_call', SAFE_CAST(JSON_VALUE(properties, '$.input_tokens') AS INT64), NULL)),
  SUM(IF(event_name = 'llm_call', SAFE_CAST(JSON_VALUE(properties, '$.output_tokens') AS INT64), NULL)),
  COUNTIF(event_name = 'llm_call' AND JSON_VALUE(properties, '$.input_tokens') IS NOT NULL
    AND JSON_VALUE(properties, '$.output_tokens') IS NOT NULL)
FROM `PROJECT_ID.event_analytics.fact_events`
WHERE event_date BETWEEN window_start AND window_end AND event_category = 'backend'
GROUP BY 1, 2, 3, 4, 5, 6;

DELETE FROM `PROJECT_ID.event_analytics.daily_event_usage`
WHERE metric_date BETWEEN window_start AND window_end;
INSERT INTO `PROJECT_ID.event_analytics.daily_event_usage`
SELECT event_date, app_id, event_name, event_category, COUNT(*), COUNT(DISTINCT user_id)
FROM `PROJECT_ID.event_analytics.fact_events`
WHERE event_date BETWEEN window_start AND window_end
GROUP BY 1, 2, 3, 4;

-- Explicit install cohort. Historical facts are scanned during refresh, never by API requests.
-- Recompute daily as-of states to avoid leaking a later reactivation into older dates.
CREATE TEMP TABLE installed_users AS
SELECT app_id, user_id, MIN(event_time) AS installed_at
FROM `PROJECT_ID.event_analytics.fact_events`
WHERE event_date <= window_end AND event_name = 'install' AND NULLIF(user_id, '') IS NOT NULL
GROUP BY app_id, user_id;

CREATE TEMP TABLE lifecycle_activity AS
SELECT e.app_id, e.user_id, e.event_date, e.event_category, e.event_name
FROM `PROJECT_ID.event_analytics.fact_events` e
JOIN installed_users u ON e.app_id = u.app_id AND e.user_id = u.user_id
WHERE e.event_date <= window_end AND e.event_time >= u.installed_at
  AND ((e.event_category = 'engagement' AND e.event_name != 'install')
    OR e.event_name IN ('purchase', 'renewal'));

DELETE FROM `PROJECT_ID.event_analytics.daily_lifecycle`
WHERE metric_date BETWEEN window_start AND window_end;
INSERT INTO `PROJECT_ID.event_analytics.daily_lifecycle`
WITH per_user_day AS (
  SELECT metric_date, u.app_id, u.user_id, DATE(u.installed_at) AS install_date,
    MIN(IF(e.event_category = 'engagement', e.event_date, NULL)) AS first_engaged,
    MAX(IF(e.event_category = 'engagement', e.event_date, NULL)) AS last_engaged,
    MIN(IF(e.event_name IN ('purchase', 'renewal'), e.event_date, NULL)) AS first_paid
  FROM installed_users u
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(GREATEST(window_start, DATE(u.installed_at)), window_end)) AS metric_date
  LEFT JOIN lifecycle_activity e ON e.app_id = u.app_id AND e.user_id = u.user_id AND e.event_date <= metric_date
  GROUP BY metric_date, u.app_id, u.user_id, install_date
)
SELECT metric_date, app_id,
  COUNTIF(install_date = metric_date), COUNT(*), COUNTIF(first_engaged = metric_date),
  COUNTIF(first_paid = metric_date), COUNTIF(first_engaged IS NOT NULL),
  COUNTIF(first_paid IS NOT NULL),
  COUNTIF(DATE_DIFF(metric_date, COALESCE(last_engaged, install_date), DAY) >= 7)
FROM per_user_day GROUP BY metric_date, app_id;
COMMIT TRANSACTION;
