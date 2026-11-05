// Shared event-envelope validation: event-specific properties remain intentionally open.
import { isEventTimestamp } from './dates.js';
const REQUIRED_STRING = ['event_id', 'app_id', 'event_name', 'event_category', 'event_time'];
const CATEGORY = new Set(['financial', 'engagement', 'backend']);
const SAFE_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateEvent(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['Event must be a JSON object'];
  }
  for (const key of REQUIRED_STRING) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (typeof value.schema_version !== 'number' || value.schema_version !== 1) {
    errors.push('schema_version must equal 1');
  }
  if (typeof value.event_id === 'string' && !UUID.test(value.event_id)) {
    errors.push('event_id must be a UUID');
  }
  for (const key of ['app_id', 'event_name']) {
    if (typeof value[key] === 'string' && !SAFE_NAME.test(value[key])) {
      errors.push(`${key} must be lowercase snake_case (2-64 chars)`);
    }
  }
  if (typeof value.event_category === 'string' && !CATEGORY.has(value.event_category)) {
    errors.push('event_category must be financial, engagement, or backend');
  }
  if (typeof value.event_time === 'string') {
    if (!isEventTimestamp(value.event_time)) {
      errors.push('event_time must be an ISO 8601 date-time with timezone');
    }
  }
  if (value.user_id !== null && value.user_id !== undefined && typeof value.user_id !== 'string') {
    errors.push('user_id must be a string or null');
  }
  if (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties)) {
    errors.push('properties must be a JSON object');
  } else {
    // Only known metric semantics are validated; new event names/properties stay open.
    const financial = ['purchase', 'renewal', 'refund'].includes(value.event_name);
    const llm = value.event_name === 'llm_call';
    const hasReportedCost = Object.hasOwn(value.properties, 'cost_usd');
    const backendCost = value.event_name === 'backend_cost' || (value.event_category === 'backend' && hasReportedCost);
    if (financial || llm || backendCost) {
      const field = financial ? 'amount_usd' : 'cost_usd';
      const amount = value.properties[field];
      // LLM usage may report tokens without a monetary estimate. An explicitly
      // supplied cost must still meet the same rules as other reported costs.
      if (financial || backendCost || (llm && hasReportedCost)) {
        if (!['string', 'number'].includes(typeof amount) || !/^(?:0|[1-9]\d{0,20})(?:\.\d{1,9})?$/.test(String(amount))) {
          errors.push(`${field} must be a non-negative USD decimal (up to 9 decimal places)`);
        }
      }
      if (value.event_category !== (financial ? 'financial' : 'backend')) errors.push('event_category does not match known event semantics');
    }
    for (const field of llm ? ['input_tokens', 'output_tokens'] : []) {
      if (value.properties[field] !== undefined && (!Number.isSafeInteger(value.properties[field]) || value.properties[field] < 0)) errors.push(`${field} must be a non-negative safe integer`);
    }
    if (['install', 'feature_used'].includes(value.event_name)) {
      if (typeof value.user_id !== 'string' || !value.user_id.trim()) errors.push('user_id required for install/feature usage');
      if (value.event_category !== 'engagement') errors.push('install/feature usage must be engagement');
    }
    if (value.event_name === 'feature_used' && (typeof value.properties.feature !== 'string' || !value.properties.feature.trim() || value.properties.feature.length > 128)) errors.push('feature must be a non-empty string of at most 128 characters');
  }
  if (value.app_version !== undefined && typeof value.app_version !== 'string') {
    errors.push('app_version must be a string');
  }
  if (value.region !== undefined && typeof value.region !== 'string') {
    errors.push('region must be a string');
  }
  return errors;
}

// BigQuery subscription with --use-table-schema expects JSON-typed properties
// to be encoded as a JSON STRING in the message body.
export function toPubsubRecord(event) {
  return {
    schema_version: event.schema_version,
    event_id: event.event_id,
    app_id: event.app_id,
    event_name: event.event_name,
    event_category: event.event_category,
    user_id: event.user_id ?? null,
    event_time: event.event_time,
    app_version: event.app_version ?? null,
    region: event.region ?? null,
    properties: JSON.stringify(event.properties),
  };
}
