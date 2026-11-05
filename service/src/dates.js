export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isEventTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  if (!isCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return false;
  const year = new Date(value).getUTCFullYear();
  return year >= 1 && year <= 9999;
}

export function isDateRange(start, end) {
  return isCalendarDate(start) && isCalendarDate(end) && start <= end
    && (Date.parse(end) - Date.parse(start)) / 86400000 <= 365;
}
