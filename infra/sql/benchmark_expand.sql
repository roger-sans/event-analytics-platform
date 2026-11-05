-- Isolated benchmark only. These generated rows do not traverse HTTP/Pub/Sub.
INSERT INTO `BENCHMARK_TABLE_PREFIX.raw_events`
(schema_version, event_id, app_id, event_name, event_category, user_id, event_time,
 app_version, region, properties, subscription_name, message_id, publish_time, attributes)
WITH expanded AS (
  SELECT s.*, replica,
    TO_HEX(SHA256(CONCAT(CAST(@seed AS STRING), ':', s.app_id, ':', s.event_id, ':', CAST(replica AS STRING)))) AS h
  FROM `BENCHMARK_TABLE_PREFIX.seed_events` s
  CROSS JOIN UNNEST(GENERATE_ARRAY(1, @copies)) AS replica
)
SELECT schema_version,
  LOWER(FORMAT('%s-%s-5%s-a%s-%s', SUBSTR(h, 1, 8), SUBSTR(h, 9, 4), SUBSTR(h, 14, 3), SUBSTR(h, 18, 3), SUBSTR(h, 21, 12))),
  app_id, event_name, event_category,
  IF(user_id IS NULL, NULL, CONCAT(user_id, ':bench:', CAST(@seed AS STRING), ':', CAST(replica AS STRING))),
  event_time, app_version, region, properties, 'benchmark-generated',
  CONCAT(h, ':', CAST(delivery AS STRING)),
  TIMESTAMP_ADD(event_time, INTERVAL delivery SECOND), attributes
FROM expanded
CROSS JOIN UNNEST(IF(MOD(replica + @seed, 10) = 0, [0, 1], [0])) AS delivery;
