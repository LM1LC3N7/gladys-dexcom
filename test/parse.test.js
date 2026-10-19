// -----------------------------------------------------------------------------
// The answers of the API, read (src/dexcom/parse.js). Shapes of pydexcom
// 0.5.1 (its recorded test answers), values made up.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TREND_ARROWS } from '../src/constants.js';
import { cut } from '../src/devices.js';
import {
  apiError,
  formatDate,
  parseDate,
  parseReading,
  parseReadings,
  parseTrend,
  parseUuid,
  readJson,
  toMmol,
} from '../src/dexcom/parse.js';
import { reading } from './helpers/fakeDexcom.js';

test('dates: Date(ms±hhmm) and Date(ms), UTC; anything else refused', () => {
  const ms = 1745081013817;
  assert.equal(parseDate(`Date(${ms}-0400)`), ms, 'the offset is the zone of the phone only');
  assert.equal(parseDate(`Date(${ms})`), ms);
  for (const bad of ['Date(12)', `Date(${ms}-04)`, '2026-10-18T07:58:00Z', '', null, 42]) {
    assert.equal(parseDate(bad), null, String(bad));
  }
  assert.equal(formatDate(Date.parse('2026-10-18T15:04:05Z')), '2026-10-18 15:04 UTC');
});

test('trends: names and numbers of pydexcom, anything else 0; arrows', () => {
  assert.equal(parseTrend('Flat'), 4);
  assert.equal(parseTrend('DoubleUp'), 1);
  assert.equal(parseTrend('DoubleDown'), 7);
  assert.equal(parseTrend('RateOutOfRange'), 9);
  assert.equal(parseTrend(5), 5, 'the older API gave a number');
  for (const bad of ['constructor', '__proto__', 'Sideways', 10, -1, 2.5, null]) {
    assert.equal(parseTrend(bad), 0, String(bad));
  }
  assert.equal(TREND_ARROWS[4], '→');
  assert.equal(TREND_ARROWS[0], '-');
  assert.equal(TREND_ARROWS.length, 10);
});

test('a reading: plausible values only; the newest of a list', () => {
  const ms = Date.parse('2026-10-18T07:58:00Z');
  assert.deepEqual(parseReading(reading(ms, 224, 'Flat')), {
    mgdl: 224,
    timestampMs: ms,
    trend: 4,
  });
  assert.deepEqual(parseReading({ Value: 80, WT: `Date(${ms})`, Trend: 'SingleUp' }), {
    mgdl: 80,
    timestampMs: ms,
    trend: 2,
  });
  assert.equal(parseReading(reading(ms, 5)), null, 'not a glucose value');
  assert.equal(parseReading(reading(ms, 12)), null, 'a sensor error code of Dexcom');
  assert.equal(parseReading(reading(ms, 13)).mgdl, 13);
  assert.equal(parseReading(reading(ms, '104')), null);
  assert.equal(parseReading(null), null);
  assert.deepEqual(parseReadings([]), { measurement: null });
  assert.equal(parseReadings({}), null);
  assert.equal(
    parseReadings([reading(ms - 300_000, 90), reading(ms, 95), 'x']).measurement.mgdl,
    95,
  );
  assert.equal(toMmol(104), 5.8);
  assert.equal(toMmol(54), 3);
});

test('ids, JSON and the error body of the API', () => {
  assert.equal(
    parseUuid('"55555555-5555-5555-5555-555555555555"'.slice(1, -1).toUpperCase()),
    '55555555-5555-5555-5555-555555555555',
  );
  assert.equal(parseUuid('not-an-id'), null);
  assert.equal(parseUuid(42), null);
  assert.equal(readJson(Buffer.from('"abc"')), 'abc');
  assert.equal(readJson(Buffer.from('<html>')), undefined);
  assert.deepEqual(apiError({ Code: 'SessionNotValid', Message: 'x' }), {
    code: 'SessionNotValid',
    message: 'x',
  });
  assert.equal(apiError({ Code: 'a b' }), null);
  assert.equal(apiError('SessionNotValid'), null);
  assert.equal(apiError([]), null);
});

test('names are cut on a whole character', () => {
  assert.equal(cut('ab😀', 3), 'ab', 'never half of a surrogate pair');
  assert.equal(cut('ab😀', 4), 'ab😀');
  assert.equal(cut('abc', 2), 'ab');
});
