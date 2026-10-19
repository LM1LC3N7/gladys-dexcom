// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  GLUCOSE_LOW: 'glucose_low',
  GLUCOSE_HIGH: 'glucose_high',
  MEASUREMENT_STALE: 'measurement_stale',
});

/**
 * Device external ids: `ext:<selector>:account:<account key>`, the account
 * key a hexadecimal digest of the Dexcom account id (src/devices.js). One
 * Dexcom Share account is one sensor wearer: one device.
 */
export const DEVICE_TYPE = 'account';

/**
 * Feature keys. The glucose carries its unit in its key: the core has no
 * glucose unit, so the unit is in the feature name, and a change of the unit
 * setting never gives an existing feature (and its history) values of
 * another unit.
 */
export const FEATURES = Object.freeze({
  GLUCOSE_MGDL: 'glucose_mgdl',
  GLUCOSE_MMOL: 'glucose_mmol',
  TREND: 'trend',
  TREND_ARROW: 'trend_arrow',
  AGE: 'measurement_age',
});

/** The glucose unit chosen in the configuration. */
export const UNITS = Object.freeze(['mgdl', 'mmol']);

/**
 * The Dexcom Share region of the account (pydexcom's `Region`): `ous`
 * (outside the United States: Europe, France, Belgium, Switzerland...), `us`,
 * `jp`.
 */
export const REGION_KEYS = Object.freeze(['ous', 'us', 'jp']);

/**
 * Seconds between two readings (one request each, a login now and then).
 * The sensor sends a value every 5 minutes: never more often than that.
 */
export const POLL_INTERVALS = Object.freeze(['300', '600', '900']);

/**
 * Minutes after which a measurement is no longer current: its glucose and
 * trend are not published, "low" and "high" never fire from it.
 */
export const STALE_AFTER = Object.freeze(['10', '15', '20', '30', '60']);

/** Thresholds of the "glucose low" / "glucose high" triggers, in mg/dL. */
export const LOW_THRESHOLDS = Object.freeze(['54', '70', '80']);
export const HIGH_THRESHOLDS = Object.freeze(['180', '250', '300']);

/** Minutes without a new measurement: the choices of the "stale" trigger. */
export const STALE_MINUTES = Object.freeze(['15', '30', '60', '120', '240']);

/**
 * Trend directions of the Dexcom Share API, and their numbers and arrows, as
 * pydexcom 0.5.1 (`const.py`) maps them: 0 none, 1 rising quickly ... 4
 * steady ... 7 falling quickly, 8 not computable, 9 rate out of range.
 */
export const TREND_DIRECTIONS = Object.freeze({
  None: 0,
  DoubleUp: 1,
  SingleUp: 2,
  FortyFiveUp: 3,
  Flat: 4,
  FortyFiveDown: 5,
  SingleDown: 6,
  DoubleDown: 7,
  NotComputable: 8,
  RateOutOfRange: 9,
});
/** pydexcom's TREND_ARROWS, but "-" instead of an empty text for 0 (none). */
export const TREND_ARROWS = Object.freeze(['-', '↑↑', '↑', '↗', '→', '↘', '↓', '↓↓', '?', '-']);

export const GLUCOSE = Object.freeze({
  /** mg/dL per mmol/L (molar mass of glucose, 180.156 g/mol). */
  MG_PER_MMOL: 18.0156,
  /** "Low" is armed again at threshold + this, "high" at threshold - this (mg/dL). */
  HYSTERESIS_MGDL: 5,
  /** Readings outside this range (mg/dL) are not glucose values. */
  MIN_MGDL: 10,
  MAX_MGDL: 1000,
});

/** Caps: what is published and fired. */
export const LIMITS = Object.freeze({
  /** Scene events sent in one reading. */
  EVENTS_PER_ROUND: 30,
  /** POST /state admits 300 states per minute per integration: stay under 250. */
  STATES_PER_MINUTE: 250,
  /** A device name published to Gladys is cut to this length. */
  NAME_LENGTH: 100,
});

export const TIMEOUTS = Object.freeze({
  /** One request. */
  API: 30_000,
});

export const INTERVALS = Object.freeze({
  /** A failure (network, unexpected answer) is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 60 * 60_000,
  /** HTTP 429 or 5xx: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /**
   * The credentials refused, or the account locked by Dexcom for too many
   * attempts: a stop of 1 h, then 6 h, then 24 h for every refusal after
   * (never a loop: a wrong password tried again and again locks the account).
   */
  REFUSAL_STEPS_MS: Object.freeze([3600_000, 6 * 3600_000, 24 * 3600_000]),
});

/** Size cap of an answer read from Dexcom Share. */
export const MAX_BYTES = 256 * 1024;

/** The persistent store (refusals, pauses: see src/store.js). */
export const STORE_FILE = 'dexcom.json';

/**
 * The Dexcom Share API, as pydexcom 0.5.1 (`const.py`) uses it: one fixed
 * host and application id per region, never a host taken from an answer.
 */
export const BASE_PATH = '/ShareWebServices/Services/';
export const REGIONS = Object.freeze({
  us: Object.freeze({
    host: 'share2.dexcom.com',
    applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  }),
  ous: Object.freeze({
    host: 'shareous1.dexcom.com',
    applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  }),
  jp: Object.freeze({
    host: 'share.dexcom.jp',
    applicationId: 'd8665ade-9673-4e27-9ff6-92db4ce13d13',
  }),
});
export const ALLOWED_HOSTS = Object.freeze(Object.values(REGIONS).map((r) => r.host));

export const ENDPOINTS = Object.freeze({
  AUTHENTICATE: 'General/AuthenticatePublisherAccount',
  LOGIN_BY_ID: 'General/LoginPublisherAccountById',
  READINGS: 'Publisher/ReadPublisherLatestGlucoseValues',
});

/** The latest reading within this window (pydexcom's MAX_MINUTES, one day). */
export const READ_MINUTES = 1440;

/** An id of all zeros: what Dexcom gives instead of a refusal, at times (pydexcom). */
export const DEFAULT_UUID = '00000000-0000-0000-0000-000000000000';
