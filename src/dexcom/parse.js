// -----------------------------------------------------------------------------
// Answers of the Dexcom Share API -> plain values, as pydexcom 0.5.1 reads
// them (dexcom.py, glucose_reading.py). Only what the integration publishes
// is kept: the account id (digested at once by the app), the session id
// (memory only) and the latest reading. Nothing here is ever logged.
// -----------------------------------------------------------------------------

import { DEFAULT_UUID, GLUCOSE, TREND_DIRECTIONS } from '../constants.js';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID (lowercase), or null. The all-zero id is kept: the caller decides. */
export const parseUuid = (value) =>
  typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;

export const isDefaultUuid = (value) => value === DEFAULT_UUID;

/** A JSON value of a body (string, array, object...), or undefined. */
export function readJson(body) {
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    return undefined;
  }
}

/**
 * The error body of the API (`{ "Code": "...", "Message": "..." }`, sent with
 * HTTP 500 for most errors, wrong passwords included): { code, message } or
 * null. The message may quote the session id: it is only matched, never
 * shown nor logged.
 */
export function apiError(value) {
  if (!isObject(value) || typeof value.Code !== 'string' || !value.Code) return null;
  if (!/^[A-Za-z0-9_]{1,80}$/.test(value.Code)) return null;
  return { code: value.Code, message: typeof value.Message === 'string' ? value.Message : '' };
}

/**
 * `Date(1745081013817-0400)` (DT) or `Date(1745081013817)` (WT, ST) -> epoch
 * ms, or null. The offset only tells the zone of the phone: the number is
 * already UTC. Implausible dates (before 2000, after 2100) are refused.
 */
export function parseDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^Date\((\d{1,15})([+-]\d{4})?\)$/.exec(value.trim());
  if (!m) return null;
  const ms = Number(m[1]);
  return ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/** A date for people: `2026-10-18 07:58 UTC` (the zone of Gladys is unknown). */
export function formatDate(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A glucose value in mg/dL within the plausible range, else null. */
export const plausibleMgdl = (value) => {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return v !== null && v >= GLUCOSE.MIN_MGDL && v <= GLUCOSE.MAX_MGDL ? v : null;
};

/** mg/dL -> mmol/L, one decimal (as the app shows it; may differ by 0.1). */
export const toMmol = (mgdl) =>
  mgdl === null ? null : Math.round((mgdl / GLUCOSE.MG_PER_MMOL) * 10) / 10;

/**
 * The trend of a reading: a direction name (the API today) or its number
 * (the API before, as pydexcom notes) -> 0 to 9; anything else 0 (none).
 */
export function parseTrend(value) {
  if (typeof value === 'string' && Object.hasOwn(TREND_DIRECTIONS, value)) {
    return TREND_DIRECTIONS[value];
  }
  if (Number.isInteger(value) && value >= 0 && value <= 9) return value;
  return 0;
}

/** One reading `{ WT, ST, DT, Value, Trend }` -> { mgdl, timestampMs, trend } or null. */
export function parseReading(value) {
  if (!isObject(value)) return null;
  const mgdl = plausibleMgdl(value.Value);
  const timestampMs = parseDate(value.DT) ?? parseDate(value.WT) ?? parseDate(value.ST);
  if (mgdl === null || timestampMs === null) return null;
  return { mgdl, timestampMs, trend: parseTrend(value.Trend) };
}

/**
 * The answer of ReadPublisherLatestGlucoseValues: { measurement } (the
 * newest readable reading, or null when there is none), or null when it is
 * not a list.
 */
export function parseReadings(value) {
  if (!Array.isArray(value)) return null;
  let newest = null;
  for (const item of value.slice(0, 300)) {
    const reading = parseReading(item);
    if (reading && (newest === null || reading.timestampMs > newest.timestampMs)) {
      newest = reading;
    }
  }
  return { measurement: newest };
}
