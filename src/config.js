// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { POLL_INTERVALS, REGION_KEYS, STALE_AFTER, UNITS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  region: 'ous',
  poll_interval: '300',
  stale_after: '15',
  glucose_unit: 'mgdl',
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  // A password pasted with its line end: the line end is not part of it.
  const password = typeof raw.password === 'string' ? raw.password.replace(/[\r\n]+$/, '') : '';
  return {
    username,
    password,
    usernameInvalid: username !== '' && (CONTROL.test(username) || username.length > 254),
    passwordInvalid: password !== '' && (CONTROL.test(password) || password.length > 512),
    region: pick('region', REGION_KEYS),
    pollSeconds: Number(pick('poll_interval', POLL_INTERVALS)),
    staleMinutes: Number(pick('stale_after', STALE_AFTER)),
    unit: pick('glucose_unit', UNITS),
  };
}
