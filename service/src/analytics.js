// Table names are fixed here. Only validated project/dataset identifiers enter SQL.
export function analyticsQueries(project, dataset) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) throw new Error('Invalid analytics identifiers');
  const table = name => `\`${project}.${dataset}.${name}\``;
  const scoped = (name, order) => `SELECT * FROM ${table(name)} WHERE metric_date BETWEEN @start_date AND @end_date AND app_id = @app_id ORDER BY ${order}`;
  return {
    daily: scoped('daily_metrics', 'metric_date'),
    features: scoped('daily_features', 'metric_date, feature'),
    costs: scoped('daily_costs', 'metric_date, cost_kind, provider, model, component'),
    lifecycle: scoped('daily_lifecycle', 'metric_date'),
    events: scoped('daily_event_usage', 'metric_date, event_name, event_category'),
    compare: `SELECT app_id, SUM(revenue_usd) AS revenue_usd, SUM(purchases) AS purchases,
      SUM(feature_events) AS feature_events,
      CASE WHEN SUM(llm_calls) = 0 THEN 0
        ELSE SUM(IF(llm_calls > 0, llm_cost_usd, NULL)) END AS llm_cost_usd,
      SUM(llm_calls) AS llm_calls, SUM(backend_errors) AS backend_errors,
      SUM(backend_cost_usd) AS backend_cost_usd, SUM(backend_cost_events) AS backend_cost_events,
      SUM(dau) AS active_user_days, SAFE_DIVIDE(SUM(dau), DATE_DIFF(@end_date, @start_date, DAY) + 1) AS average_dau
      FROM ${table('daily_metrics')} WHERE metric_date BETWEEN @start_date AND @end_date
      GROUP BY app_id ORDER BY revenue_usd DESC, app_id`,
  };
}
