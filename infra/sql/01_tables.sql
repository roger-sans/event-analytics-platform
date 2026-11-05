-- Replace PROJECT_ID throughout before executing in Google Cloud BigQuery.
-- Create the dataset in EU first (e.g. bq --location=EU mk -d PROJECT_ID:event_analytics).
-- BigQuery subscription settings: use table schema + write metadata.
CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.raw_events` (
  schema_version INT64,
  event_id STRING,
  app_id STRING,
  event_name STRING,
  event_category STRING,
  user_id STRING,
  event_time TIMESTAMP,
  app_version STRING,
  region STRING,
  properties JSON,
  subscription_name STRING,
  message_id STRING,
  publish_time TIMESTAMP,
  attributes JSON
)
PARTITION BY DATE(event_time)
CLUSTER BY app_id, event_name
OPTIONS(description='Append-only Pub/Sub -> BigQuery events; delivery may be duplicated');

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.fact_events` (
  event_date DATE NOT NULL,
  event_id STRING NOT NULL,
  app_id STRING NOT NULL,
  event_name STRING NOT NULL,
  event_category STRING NOT NULL,
  user_id STRING,
  event_time TIMESTAMP NOT NULL,
  properties JSON
)
PARTITION BY event_date
CLUSTER BY app_id, event_name
OPTIONS(description='Deduplicated event facts for metric calculation');

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.daily_metrics` (
  metric_date DATE NOT NULL,
  app_id STRING NOT NULL,
  dau INT64,
  paying_users INT64,
  purchases INT64,
  revenue_usd NUMERIC,
  feature_events INT64,
  llm_calls INT64,
  llm_cost_usd NUMERIC,
  backend_errors INT64
)
PARTITION BY metric_date
CLUSTER BY app_id
OPTIONS(description='Pre-aggregated metrics for fast analytics API serving');

-- Additive migration: existing installations keep their tables and data.
ALTER TABLE `PROJECT_ID.event_analytics.daily_metrics`
ADD COLUMN IF NOT EXISTS backend_cost_usd NUMERIC;
ALTER TABLE `PROJECT_ID.event_analytics.daily_metrics`
ADD COLUMN IF NOT EXISTS backend_cost_events INT64;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.daily_features` (
  metric_date DATE NOT NULL, app_id STRING NOT NULL, feature STRING NOT NULL,
  events INT64, users INT64
) PARTITION BY metric_date CLUSTER BY app_id, feature;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.daily_costs` (
  metric_date DATE NOT NULL, app_id STRING NOT NULL, cost_kind STRING NOT NULL,
  provider STRING, model STRING, component STRING,
  events INT64, cost_records INT64, cost_usd NUMERIC,
  input_tokens INT64, output_tokens INT64, token_reported_calls INT64
) PARTITION BY metric_date CLUSTER BY app_id, cost_kind, model;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.daily_event_usage` (
  metric_date DATE NOT NULL, app_id STRING NOT NULL, event_name STRING NOT NULL,
  event_category STRING NOT NULL, events INT64, users INT64
) PARTITION BY metric_date CLUSTER BY app_id, event_name;

CREATE TABLE IF NOT EXISTS `PROJECT_ID.event_analytics.daily_lifecycle` (
  metric_date DATE NOT NULL, app_id STRING NOT NULL,
  new_installs INT64, installed_users INT64, activated_users INT64,
  first_payers INT64, engaged_installed_users INT64, paid_installed_users INT64,
  inactive_7d_users INT64
) PARTITION BY metric_date CLUSTER BY app_id;
