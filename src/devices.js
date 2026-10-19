// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   account  `ext:<selector>:account:<account key>`
//            one per Dexcom Share account (one sensor wearer): glucose (in
//            the unit of the configuration), trend (number and arrow), age of
//            the measurement. All read only, no history by default.
//
// The key is a digest of the Dexcom account id (stable; the id itself never
// appears in Gladys).
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them (a
// change of the unit setting adds the feature of the new unit).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';

export const ID_PATTERN = /^[0-9a-f]{16}$/;

/** The id of an account in Gladys: a digest of its Dexcom account id. */
export const accountKey = (id) =>
  createHash('sha256')
    .update(`gladys-dexcom:account:${String(id).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);

export const deviceIds = (gladys, key) => gladys.externalIds(DEVICE_TYPE, key);

/** A text cut to `length` code units, never in the middle of a surrogate pair. */
export function cut(text, length) {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** The glucose feature key of one unit. */
export const glucoseFeature = (unit) =>
  unit === 'mmol' ? FEATURES.GLUCOSE_MMOL : FEATURES.GLUCOSE_MGDL;

/** Health data: no history by default (the user may turn it on per feature). */
const feature = (ids, key, name, spec) => ({
  name,
  external_id: ids.feature(key),
  read_only: true,
  has_feedback: false,
  ...spec,
  keep_history: false,
});

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(gladys, device, devices = gladys.devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * Units and types: only the pairs and units the core lists
 * (server/utils/constants.js: DEVICE_FEATURE_UNITS_BY_CATEGORY). The core
 * has no glucose category nor unit (neither mg/dL nor mmol/L): the glucose
 * is `unknown`/`decimal` without unit, the unit in the name. The trend is an
 * `unknown`/`integer` (0 to 9) and a `text`/`text` arrow; the age a
 * `duration`/`integer` in minutes.
 *
 * @param {{ key: string, name: string }} account
 * @param {'mgdl' | 'mmol'} unit
 */
export function buildDevice(gladys, { key, name }, unit = 'mgdl') {
  const ids = deviceIds(gladys, key);
  const label = unit === 'mmol' ? 'mmol/L' : 'mg/dL';
  const features = [
    feature(ids, glucoseFeature(unit), `Glucose (${label})`, {
      category: C.UNKNOWN,
      type: T.SENSOR.DECIMAL,
      min: 0,
      max: unit === 'mmol' ? 60 : 1000,
    }),
    feature(
      ids,
      FEATURES.TREND,
      'Trend (1 rising quickly, 4 steady, 7 falling quickly, 8-9 unknown, 0 none)',
      {
        category: C.UNKNOWN,
        type: T.SENSOR.INTEGER,
        min: 0,
        max: 9,
      },
    ),
    feature(ids, FEATURES.TREND_ARROW, 'Trend arrow', {
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
    }),
    feature(ids, FEATURES.AGE, 'Measurement age', {
      category: C.DURATION,
      type: T.DURATION.INTEGER,
      unit: U.MINUTES,
      min: 0,
      max: 1_000_000,
    }),
  ];
  return withCreatedFeatures(gladys, {
    name: cut(name, LIMITS.NAME_LENGTH),
    external_id: ids.device,
    model: 'Dexcom Share',
    should_poll: false,
    features,
  });
}

/**
 * What a device or feature external id of this integration designates:
 * { key, feature } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [key, featureKey, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !ID_PATTERN.test(key ?? '')) return null;
  return { key, feature: featureKey ?? null };
}

/** The created devices of this integration: [{ key, externalId }]. */
export function createdDevices(gladys, devices = gladys.devices) {
  const list = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    list.push({ key: parsed.key, externalId: device.external_id });
  }
  return list;
}
