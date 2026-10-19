// -----------------------------------------------------------------------------
// Non-regression tests of the review of 1ad682b: the hostile scenarios of the
// reviewer (H1-H6, I1-I5, M1-M2 and the checks that held), each turned into
// the behaviour it asked for, and one test per point fixed (B1-B3, I1-I3,
// M1-M5). Around midnight UTC on purpose: test/timezone.test.js runs the
// suite of the app in Lisbon and Helsinki, this file runs in both too.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DexcomApp } from '../src/app.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';
import { accountKey, buildDevice } from '../src/devices.js';
import { DexcomClient } from '../src/dexcom/client.js';
import { CODES, DexcomError } from '../src/dexcom/errors.js';
import { apiError, parseReadings, readJson } from '../src/dexcom/parse.js';
import { registerHandlers } from '../src/handlers.js';
import { ACCOUNT_ID, PASSWORD, USERNAME, createFakeDexcom, reading } from './helpers/fakeDexcom.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

// Lisbon 00:57, Helsinki 02:57: the day differs from UTC.
const T0 = Date.parse('2026-10-18T23:57:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const POLL = 300_000;
const SELECTOR = 'dexcom';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE_CONFIG = { username: USERNAME, password: PASSWORD };
const KEY = accountKey(ACCOUNT_ID);
const device = (unit = 'mgdl') => buildDevice(ids, { key: KEY, name: 'Dexcom' }, unit);
const featureId = (feature) => `ext:${SELECTOR}:account:${KEY}:${feature}`;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ config = {}, created = [device()], dexcom, dataDir, clock } = {}) {
  clock ??= { now: T0, jump: 0 };
  dexcom ??= createFakeDexcom({ now: () => clock.now });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  const app = new DexcomApp({
    gladys,
    logger,
    request: dexcom.request,
    dataDir,
    now: () => clock.now,
    monotonic: () => clock.now - clock.jump,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, dexcom, timers, clock, logs, app, dataDir };
}

const settle = async (app) => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await app.queue;
};
const storeText = (dataDir) =>
  readdirSync(dataDir)
    .map((f) => {
      try {
        return readFileSync(join(dataDir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
const sentOf = (gladys, feature) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId(feature));
const last = (gladys, feature) => gladys.fake.lastState(featureId(feature));
/** Advance the clock to each timer and run it, until `until`. */
async function runFor(timers, clock, until) {
  let rounds = 0;
  while (timers.pending.size > 0 && rounds < 2000) {
    const next = [...timers.pending.values()].sort((a, b) => a.ms - b.ms)[0];
    if (clock.now + next.ms > until) break;
    clock.now += next.ms;
    timers.pending.delete(next.id);
    await next.fn();
    rounds += 1;
  }
}

// --- B1: never more than one reading per 5 min and per account ----------------

test('B1/H1 the test button within 5 min: no request, says when it was read and when next', async () => {
  const { gladys, dexcom, clock } = await setup();
  const before = dexcom.requests.length;
  clock.now += 2 * MIN;
  for (let i = 0; i < 3; i += 1) {
    const ack = await gladys.fake.action(ACTIONS.TEST);
    assert.equal(ack.success, true, ack.error);
    assert.match(ack.data.message.en, /^Read 2 min ago .*current\. Next reading in 3 min\.$/);
    assert.match(ack.data.message.fr, /^Lu il y a 2 min .*Prochaine lecture dans 3 min\.$/);
  }
  assert.equal(dexcom.requests.length, before, 'nothing sent within the floor');
});

test('B1/H2 saving the configuration within 5 min: no request, Discovery in the new unit', async () => {
  const { gladys, dexcom } = await setup();
  const before = dexcom.requests.length;
  await gladys.fake.configUpdated({ ...BASE_CONFIG, glucose_unit: 'mmol' });
  const features = gladys.fake.discoveredDevices.at(-1).features.map((f) => f.external_id);
  assert.ok(features.includes(featureId('glucose_mmol')));
  await gladys.fake.configUpdated({ ...BASE_CONFIG, stale_after: '20' });
  assert.equal(dexcom.requests.length, before);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('B1/H3 the scan button within 5 min reads nothing; the loop reads at its time', async () => {
  const { gladys, dexcom, timers, clock } = await setup();
  const before = dexcom.reads().length;
  await gladys.fake.scanRequest();
  await gladys.fake.scanRequest();
  assert.equal(dexcom.reads().length, before);
  clock.now += POLL;
  await timers.run((ms) => ms === POLL);
  assert.equal(dexcom.reads().length, before + 1);
  await gladys.fake.scanRequest();
  assert.equal(dexcom.reads().length, before + 1, 'just read: the floor again');
});

test('B1/H4 a flapping websocket: no reading, status and Discovery sent again each time', async () => {
  const { gladys, dexcom, app, timers } = await setup();
  const before = dexcom.reads().length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  for (let i = 0; i < 5; i += 1) {
    gladys.emit('connected');
    await settle(app);
  }
  assert.equal(dexcom.reads().length, before);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 5);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(timers.delays(), [POLL], 'one timer: the next reading at last start + interval');
});

test('B1/H5 after a session failure, test clicks never send the password again', async () => {
  const { gladys, dexcom, timers, clock } = await setup();
  const session = {
    status: 500,
    path: 'ReadPublisherLatestGlucoseValues',
    body: { Code: 'SessionNotValid', Message: 'x' },
  };
  dexcom.failures.push(session, { ...session });
  clock.now += POLL;
  await timers.run((ms) => ms === POLL);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the session/);
  const before = dexcom.passwordsSent();
  for (let i = 0; i < 4; i += 1) {
    const ack = await gladys.fake.action(ACTIONS.TEST);
    assert.equal(ack.success, false);
    assert.match(ack.error, /refused the session/);
  }
  assert.equal(dexcom.passwordsSent(), before);
});

test('B1 the floor survives a restart (/data, wall clock), a date ahead is read back as now', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  await setup({ dataDir });
  assert.match(storeText(dataDir), /lastRead\|/);
  await running.stop();
  const dexcom = createFakeDexcom({ now: () => T0 + 2 * MIN });
  const second = await setup({ dataDir, dexcom, clock: { now: T0 + 2 * MIN, jump: 0 } });
  assert.equal(dexcom.requests.length, 0);
  assert.match(
    second.gladys.fake.connectionStatus.message.en,
    /read 2 min ago .*next reading in 3 min/,
  );
  assert.deepEqual(second.timers.delays(), [3 * MIN]);
  second.clock.now += 3 * MIN;
  await second.timers.run();
  assert.equal(dexcom.reads().length, 1);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  await running.stop();
  // A reading dated one hour ahead (the clock set back since): capped at now.
  const dir = mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  await setup({ dataDir: dir, clock: { now: T0 + HOUR, jump: 0 } });
  await running.stop();
  const late = createFakeDexcom({ now: () => T0 });
  const third = await setup({ dataDir: dir, dexcom: late });
  assert.equal(late.requests.length, 0);
  assert.deepEqual(third.timers.delays(), [POLL], 'never more than the interval');
});

test('B1 other credentials after a refusal are tried at once, even within the floor', async () => {
  const { gladys, dexcom } = await setup({ config: { password: 'wrong-1' } });
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(dexcom.reads().length, 1);
});

// --- B2: lock and refusal codes, both spellings; unknown codes of a login ------

for (const [code, words] of [
  ['SSO_AuthenticateMaxAttemptsExceeed', /locked the account/],
  ['SSO_AuthenticateMaxAttemptsExceeded', /locked the account/],
  ['SSO_AuthenticatePasswordInvalid', /refused the user name/],
  ['SSO_AuthenticateAccountNotFound', /refused the user name/],
  ['SomethingNewOnTheLogin', /error this integration does not know/],
]) {
  test(`B2/H6 ${code} on the login: the stop ladder, three passwords in 24 h at most`, async () => {
    const clock = { now: T0, jump: 0 };
    const dexcom = createFakeDexcom({ now: () => clock.now });
    for (let i = 0; i < 100; i += 1) {
      dexcom.failures.push({
        status: 500,
        path: 'AuthenticatePublisherAccount',
        body: { Code: code, Message: 'Publisher account ...' },
      });
    }
    const { gladys, timers } = await setup({ dexcom, clock });
    assert.match(gladys.fake.connectionStatus.message.en, words);
    assert.deepEqual(timers.delays(), [HOUR]);
    await runFor(timers, clock, T0 + 24 * HOUR);
    assert.ok(dexcom.passwordsSent() <= 3, `${dexcom.passwordsSent()} password attempts in 24 h`);
  });
}

test('B2 the client: MaxAttempts is a lock, SSO_Authenticate* a refusal, any login code a stop', async () => {
  const answer = (path, code) => async (url) => ({
    status: 500,
    headers: {},
    body: Buffer.from(url.includes(path) ? JSON.stringify({ Code: code, Message: 'm' }) : '"x"'),
  });
  const latest = (code, path = 'AuthenticatePublisherAccount') =>
    new DexcomClient({
      username: 'u',
      password: 'p',
      region: 'ous',
      request: answer(path, code),
    }).latest();
  await assert.rejects(latest('SSO_AuthenticateMaxAttemptsExceeed'), { code: CODES.LOCKED });
  await assert.rejects(latest('SSO_AuthenticateMaxAttemptsExceeded'), { code: CODES.LOCKED });
  await assert.rejects(latest('SSO_AuthenticateWhatever'), { code: CODES.REFUSED });
  await assert.rejects(latest('AccountNotFound'), { code: CODES.REFUSED });
  await assert.rejects(latest('Unknown'), { code: CODES.LOGIN_ERROR });
  // A session code is never a stop, even on a login.
  await assert.rejects(latest('SessionNotValid'), { code: CODES.SESSION });
});

// --- I1, I2: a login that worked ends a stop ----------------------------------

test('I1 the lock lifted: login OK, reading 503: a pause of the interval, the stop forgotten', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.locked = true;
  const { gladys, timers } = await setup({ dexcom, clock, dataDir });
  clock.now += HOUR;
  await timers.run();
  assert.deepEqual(timers.delays(), [6 * HOUR]);
  clock.now += 6 * HOUR;
  dexcom.locked = false;
  dexcom.failures.push({ status: 503, path: 'ReadPublisherLatestGlucoseValues', body: '' });
  await timers.run();
  assert.equal(dexcom.logins().length, 1, 'the login worked');
  assert.deepEqual(timers.delays(), [POLL], 'a pause of the interval, not a 6 h step');
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503/);
  assert.doesNotMatch(storeText(dataDir), /"refusals": \{\s*"/, 'the stop is forgotten');
  clock.now += POLL;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('I2 a reconnection during the attempt after a lock: the login worked, no step more', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.locked = true;
  const { gladys, timers, app } = await setup({ dexcom, clock, dataDir });
  assert.deepEqual(timers.delays(), [HOUR]);
  clock.now += HOUR;
  dexcom.locked = false;
  let open;
  dexcom.gate = new Promise((resolve) => {
    open = resolve;
  });
  const round = timers.run();
  for (let i = 0; i < 400 && dexcom.authentications().length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(storeText(dataDir), /\\"p\\":true/, 'pending written');
  gladys.emit('connected');
  await new Promise((resolve) => setTimeout(resolve, 20));
  dexcom.gate = null;
  open();
  await round;
  await settle(app);
  assert.doesNotMatch(storeText(dataDir), /"refusals": \{\s*"/, 'the stop is forgotten');
  assert.deepEqual(timers.delays(), [POLL], 'the next reading after the floor, not 6 h');
  clock.now += POLL;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('I2 an attempt closed before any answer: no longer in flight, never one more step', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.locked = true;
  const { app } = await setup({ dexcom });
  const stored = app.storedRefusal(app.baseKey);
  assert.equal(stored.step, 1);
  await app.writeRefusal(app.baseKey, { ...stored, pending: true });
  const closed = new DexcomError(CODES.CLOSED, 'Client closed');
  await app.fail(closed, { baseKey: app.baseKey, key: stored.key, step: 1 }, { session: {} });
  const after = app.storedRefusal(app.baseKey);
  assert.equal(after.pending, false, 'no longer in flight');
  assert.equal(after.step, 1, 'still the first step');
  assert.equal(after.locked, true);
});

// --- I3: sensor error codes are not glucose -------------------------------------

for (const value of [10, 12]) {
  test(`I3 Value ${value} (a sensor error code) is no glucose: nothing published, no event`, async () => {
    const dexcom = createFakeDexcom({ now: () => T0 });
    dexcom.glucose(T0 - MIN, value, 'NotComputable');
    const { gladys } = await setup({ dexcom });
    assert.equal(gladys.fake.sceneEvents.length, 0);
    assert.equal(last(gladys, 'glucose_mgdl'), undefined);
    assert.match(gladys.fake.connectionStatus.message.en, /no measurement/);
  });
}

test('I3 the "LOW" of Dexcom (39 mg/dL) is still a glucose value', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 39, 'DoubleDown');
  const { gladys } = await setup({ dexcom });
  assert.equal(last(gladys, 'glucose_mgdl'), 39);
  assert.ok(gladys.fake.sceneEvents.some((e) => e.key === SCENE_TRIGGERS.GLUCOSE_LOW));
});

// --- M1 (I4): an older measurement than the last one accepted is ignored --------

test('M1/I4 an older measurement after a newer one: ignored, no low, the age goes on', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - MIN, 110);
  const { gladys, timers } = await setup({ dexcom, clock });
  clock.now += POLL;
  dexcom.readings = [reading(T0 - 3 * MIN, 52, 'DoubleDown')];
  await timers.run((ms) => ms === POLL);
  assert.equal(last(gladys, 'glucose_mgdl'), 110);
  assert.equal(last(gladys, 'measurement_age'), 6);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /is current/);
});

// --- B3 (I5): states computed again when published ------------------------------

test('B3/I5 a device update 14 min after the reading never sends a 23-min-old glucose again', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - 9 * MIN, 64);
  const { gladys } = await setup({
    dexcom,
    clock,
    config: { poll_interval: '900', stale_after: '10' },
  });
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 1);
  clock.now += 14 * MIN;
  const created = gladys.fake.devices[0];
  await gladys.fake.deviceUpdated({ ...created, name: 'Renamed' });
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 1, 'not sent again: no longer current');
  assert.equal(sentOf(gladys, 'trend').length, 1);
  assert.equal(last(gladys, 'measurement_age'), 23, 'the age of now');
});

test('B3 a start within the floor computes the currency again (stale by now: age only)', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - 14 * MIN, 64);
  const { gladys, app } = await setup({ dexcom, clock });
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 1);
  clock.now += 2 * MIN;
  gladys.emit('connected');
  await settle(app);
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 1, 'never sent again as current');
  assert.equal(last(gladys, 'measurement_age'), 16);
  assert.match(gladys.fake.connectionStatus.message.en, /more than 15 min old/);
});

// --- M2: a lock is about the account, whatever the password ---------------------

test('M2 locked at step 2, new passwords saved: one attempt at once, then the next step', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.locked = true;
  const { gladys, timers } = await setup({ dexcom, clock });
  clock.now += HOUR;
  await timers.run();
  assert.deepEqual(timers.delays(), [6 * HOUR]);
  const before = dexcom.requests.length;
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other-1' });
  assert.equal(dexcom.requests.length, before + 1, 'one attempt at once');
  assert.deepEqual(timers.delays(), [24 * HOUR], 'the next step, not back to 1 h');
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other-2' });
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other-3' });
  assert.equal(dexcom.requests.length, before + 1, 'never more within the step');
  assert.match(gladys.fake.connectionStatus.message.en, /Already tried again/);
});

// --- Approval round (R1, R2, R4) ---------------------------------------------------

test('R1 reconnections, test clicks and saves without a new measurement send no glucose again', async () => {
  const { gladys, app, clock } = await setup();
  const before = () =>
    ['glucose_mgdl', 'trend', 'trend_arrow'].map((f) => sentOf(gladys, f).length);
  assert.deepEqual(before(), [1, 1, 1]);
  for (let i = 0; i < 3; i += 1) {
    clock.now += 20_000;
    gladys.emit('connected');
    await settle(app);
  }
  for (let i = 0; i < 3; i += 1) await gladys.fake.action(ACTIONS.TEST);
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.deepEqual(before(), [1, 1, 1], 'one state per measurement');
  // A device updated in Gladys forgets its values: sent again once.
  await gladys.fake.deviceUpdated({ ...gladys.fake.devices[0], name: 'Renamed' });
  assert.deepEqual(before(), [2, 2, 2]);
  // Another account: what was sent for the previous one says nothing.
  assert.ok(app.published.size > 0);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, username: 'other@example.org' });
  assert.equal(app.published.size, 0);
});

test('R2 a locked account: the status says another password waits for the next step', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.locked = true;
  const { gladys, timers } = await setup({ dexcom, clock });
  clock.now += HOUR;
  await timers.run();
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other-1' });
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'other-2' });
  const { en, fr } = gladys.fake.connectionStatus.message;
  assert.match(
    en,
    /another password waits for the next step; another region or another account: at once/,
  );
  assert.match(
    fr,
    /un autre mot de passe attend le palier suivant ; une autre région ou un autre compte : tout de suite/,
  );
});

test('R4 a saved configuration whose attempt waits for the end of the floor: its own status', async () => {
  const clock = { now: T0, jump: 0 };
  const { gladys, dexcom, timers } = await setup({ clock, config: { password: 'wrong' } });
  assert.deepEqual(timers.delays(), [HOUR]);
  clock.now += MIN;
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'wrong' });
  assert.match(gladys.fake.connectionStatus.message.en, /Configuration saved: .*leaves in 4 min/);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /Configuration enregistrée : .*part donc dans 4 min/,
  );
  assert.equal(dexcom.requests.length, 1);
  clock.now += 4 * MIN;
  await timers.run();
  assert.equal(dexcom.requests.length, 2, 'the attempt at the end of the floor');
  assert.deepEqual(timers.delays(), [6 * HOUR]);
});

// --- M3: the same value at a new measurement is sent again -----------------------

test('M3 the same glucose at every new measurement is sent again (dated right by Gladys)', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - MIN, 110);
  const { gladys, timers } = await setup({ dexcom, clock });
  for (let i = 0; i < 6; i += 1) {
    clock.now += POLL;
    dexcom.glucose(clock.now - MIN, 110);
    await timers.run((ms) => ms === POLL);
  }
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 7);
  assert.equal(sentOf(gladys, 'trend').length, 7);
  // The same measurement read again: not sent again.
  clock.now += POLL;
  await timers.run((ms) => ms === POLL);
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 7);
});

// --- M4: a measurement in the future gives no age -------------------------------

test('M4 a measurement in the future: no value, the age of the last one not in the future', async () => {
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - MIN, 110);
  const { gladys, timers } = await setup({ dexcom, clock });
  clock.now += POLL;
  dexcom.glucose(clock.now + HOUR, 50);
  await timers.run((ms) => ms === POLL);
  assert.equal(last(gladys, 'measurement_age'), 6, 'from the last measurement accepted');
  assert.equal(sentOf(gladys, 'glucose_mgdl').length, 1);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /dated in the future/);
});

// --- M5 and the checks that held ------------------------------------------------

test('M5 around midnight UTC: the date of an event is UTC whatever the zone', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 63);
  const { gladys } = await setup({ dexcom });
  const low = gladys.fake.sceneEvents.find((e) => e.key === SCENE_TRIGGERS.GLUCOSE_LOW);
  assert.equal(low.data.measured_at, '2026-10-18 23:56 UTC');
});

test('hostile JSON: no prototype pollution, bounded list', () => {
  const body = Buffer.from(
    '[{"__proto__":{"polluted":1,"Value":50},"DT":"Date(1760000000000+0200)","Value":100,"Trend":"constructor"}]',
  );
  const out = parseReadings(readJson(body));
  assert.equal({}.polluted, undefined);
  assert.equal(out.measurement.mgdl, 100);
  assert.equal(out.measurement.trend, 0, 'an inherited name is not a trend');
  assert.equal(apiError(readJson('{"__proto__":{"Code":"AccountPasswordInvalid"}}')), null);
  const many = Array.from({ length: 5000 }, (_, i) => reading(T0 - i * MIN, 100));
  assert.ok(parseReadings(many).measurement);
});

test('privacy: refusal, lock, session, test button, floor: no secret in logs, /data, statuses', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-review-'));
  const clock = { now: T0, jump: 0 };
  const dexcom = createFakeDexcom({ now: () => clock.now });
  dexcom.glucose(T0 - MIN, 63);
  const { gladys, timers, logs } = await setup({ dexcom, clock, dataDir });
  dexcom.failures.push({
    status: 500,
    path: 'ReadPublisherLatestGlucoseValues',
    body: { Code: 'SessionNotValid', Message: `SessionId=${dexcom.sessions[0]}` },
  });
  clock.now += POLL;
  await timers.run();
  await gladys.fake.action(ACTIONS.TEST);
  dexcom.locked = true;
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'Wr0ng!' });
  const statuses = gladys.fake.bodies('POST', '/connection_status').map((b) => JSON.stringify(b));
  const text = `${logs.join('\n')}\n${storeText(dataDir)}\n${statuses.join('\n')}`;
  for (const secret of [
    USERNAME,
    PASSWORD,
    'Wr0ng!',
    ACCOUNT_ID,
    ...dexcom.sessions,
    'dexcom.com',
  ]) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
  assert.doesNotMatch(`${logs.join('\n')}\n${statuses.join('\n')}`, /\b63\b/, 'no glucose');
});
