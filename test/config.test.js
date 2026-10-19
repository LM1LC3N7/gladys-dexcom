// -----------------------------------------------------------------------------
// The configuration, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('defaults and choices outside the list', () => {
  const config = normalizeConfig();
  assert.equal(config.pollSeconds, Number(DEFAULTS.poll_interval));
  assert.equal(config.pollSeconds, 300, 'one reading every 5 min at most by default');
  assert.equal(config.staleMinutes, 15);
  assert.equal(config.region, 'ous');
  assert.equal(config.unit, DEFAULTS.glucose_unit);
  assert.equal(config.username, '');
  assert.equal(normalizeConfig({ poll_interval: '60' }).pollSeconds, 300, 'never under 5 min');
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollSeconds, 600);
  assert.equal(normalizeConfig({ stale_after: '30' }).staleMinutes, 30);
  assert.equal(normalizeConfig({ stale_after: '1' }).staleMinutes, 15);
  assert.equal(normalizeConfig({ region: 'us' }).region, 'us');
  assert.equal(normalizeConfig({ region: 'eu' }).region, 'ous');
  assert.equal(normalizeConfig({ region: '__proto__' }).region, 'ous');
  assert.equal(normalizeConfig({ glucose_unit: 'mmol' }).unit, 'mmol');
  assert.equal(normalizeConfig(null).pollSeconds, 300);
});

test('credentials: trimmed user name, password kept but its line end, invalid ones said', () => {
  const config = normalizeConfig({ username: ' +33600000000 ', password: ' pass word \n' });
  assert.equal(config.username, '+33600000000');
  assert.equal(config.password, ' pass word ');
  assert.equal(config.usernameInvalid, false);
  assert.equal(config.passwordInvalid, false);
  assert.equal(normalizeConfig({ username: 'a\nb' }).usernameInvalid, true);
  assert.equal(normalizeConfig({ password: 'a\tb' }).passwordInvalid, true);
  assert.equal(normalizeConfig({ password: 42 }).password, '');
});
