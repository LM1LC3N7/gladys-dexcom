// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake Dexcom Share
// API, through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DexcomApp } from '../src/app.js';
import { ACTIONS, ALLOWED_HOSTS, INTERVALS, SCENE_TRIGGERS } from '../src/constants.js';
import { accountKey, buildDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import {
  ACCOUNT_ID,
  HOSTS,
  PASSWORD,
  USERNAME,
  createFakeDexcom,
  reading,
} from './helpers/fakeDexcom.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const POLL = 300_000;
const SELECTOR = 'dexcom';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE_CONFIG = { username: USERNAME, password: PASSWORD };
const WRONG = 'not-the-password';
const KEY = accountKey(ACCOUNT_ID);
const device = (unit = 'mgdl', name = 'Dexcom') => buildDevice(ids, { key: KEY, name }, unit);
const featureId = (feature) => `ext:${SELECTOR}:account:${KEY}:${feature}`;
const deviceId = () => `ext:${SELECTOR}:account:${KEY}`;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({
  config = {},
  created = [device()],
  dexcom,
  dataDir,
  now = T0,
  clock = { now, jump: 0 },
} = {}) {
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
  dataDir ??= mkdtempSync(join(tmpdir(), 'dexcom-app-'));
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

const poll = (timers, ms = POLL) => timers.run((delay) => delay === ms);
const last = (gladys, feature) => gladys.fake.lastState(featureId(feature));
const statesOf = (gladys, feature) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId(feature));
const storeText = (dataDir) =>
  readdirSync(dataDir)
    .map((file) => {
      // A write in flight renames its temporary file: read what is there.
      try {
        return readFileSync(join(dataDir, file), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
/** Emit `connected` again (Gladys came back) and wait for the restart. */
async function reconnect(gladys, app) {
  gladys.emit('connected');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await app.queue;
}
const events = (gladys) =>
  gladys.fake.sceneEvents.map((e) => [e.key, e.data.threshold ?? e.data.minutes]);

test('start: account id, session, latest reading; status, Discovery, values; one request per round', async () => {
  const { gladys, dexcom, timers, clock } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Dexcom Share answers: the latest measurement is current.',
      fr: 'Dexcom Share répond : la dernière mesure est à jour.',
    },
  });
  assert.deepEqual(
    dexcom.requests.map((r) => [r.method, r.host, r.path]),
    [
      ['POST', HOSTS.ous, 'General/AuthenticatePublisherAccount'],
      ['POST', HOSTS.ous, 'General/LoginPublisherAccountById'],
      ['POST', HOSTS.ous, 'Publisher/ReadPublisherLatestGlucoseValues'],
    ],
  );
  const [auth, login, read] = dexcom.requests;
  assert.deepEqual(JSON.parse(auth.body), {
    accountName: USERNAME,
    password: PASSWORD,
    applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  });
  assert.deepEqual(JSON.parse(login.body), {
    accountId: ACCOUNT_ID,
    password: PASSWORD,
    applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  });
  assert.match(auth.headers['user-agent'], /^gladys-dexcom\/0\.1\.0$/);
  assert.deepEqual(read.query, {
    sessionId: dexcom.sessions[0],
    minutes: '1440',
    maxCount: '1',
  });
  assert.equal(read.body, '{}', 'no credential with the reading');
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name, d.model]),
    [[deviceId(), 'Dexcom', 'Dexcom Share']],
  );
  const [found] = gladys.fake.discoveredDevices;
  assert.deepEqual(
    found.features.map((f) => f.external_id.split(':').at(-1)),
    ['glucose_mgdl', 'trend', 'trend_arrow', 'measurement_age'],
  );
  assert.ok(
    found.features.every((f) => f.keep_history === false && f.read_only === true),
    'read only, no history by default',
  );
  assert.equal(last(gladys, 'glucose_mgdl'), 110);
  assert.equal(last(gladys, 'trend'), 4);
  assert.equal(last(gladys, 'trend_arrow'), '→');
  assert.equal(last(gladys, 'measurement_age'), 1);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'cloud'));
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.deepEqual(timers.delays(), [POLL]);
  // The next rounds: the session is kept, one request each.
  clock.now += POLL;
  await poll(timers);
  clock.now += POLL;
  await poll(timers);
  assert.equal(dexcom.authentications().length, 1);
  assert.equal(dexcom.logins().length, 1);
  assert.equal(dexcom.reads().length, 3);
  assert.deepEqual(timers.delays(), [POLL]);
});

test('regions: the fixed host and application id of each', async () => {
  for (const [region, appId] of [
    ['us', 'd89443d2-327c-4a6f-89e5-496bbb0317db'],
    ['jp', 'd8665ade-9673-4e27-9ff6-92db4ce13d13'],
  ]) {
    const dexcom = createFakeDexcom({ now: () => T0 });
    dexcom.region = region;
    const { gladys } = await setup({ dexcom, config: { region } });
    assert.equal(gladys.fake.connectionStatus.connected, true, region);
    assert.ok(
      dexcom.requests.every((r) => r.host === HOSTS[region]),
      region,
    );
    assert.equal(JSON.parse(dexcom.requests[0].body).applicationId, appId);
    await running.stop();
  }
});

test('mmol/L: the feature of that unit, value converted, one decimal', async () => {
  const { gladys } = await setup({ config: { glucose_unit: 'mmol' }, created: [device('mmol')] });
  const [found] = gladys.fake.discoveredDevices;
  assert.equal(found.features[0].external_id.split(':').at(-1), 'glucose_mmol');
  assert.match(found.features[0].name, /\(mmol\/L\)$/);
  assert.equal(last(gladys, 'glucose_mmol'), 6.1);
});

test('a device published again never loses a feature (unit changed); each gets its unit', async () => {
  const { gladys } = await setup({ created: [device('mmol')] });
  const [found] = gladys.fake.discoveredDevices;
  const keys = found.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('glucose_mgdl') && keys.includes('glucose_mmol'));
  assert.equal(last(gladys, 'glucose_mmol'), 6.1, 'the created feature keeps its values');
  assert.equal(last(gladys, 'glucose_mgdl'), undefined, 'not created yet: nothing');
});

test('a stale measurement is never published as current: only its age, and the status says so', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - 20 * MIN, 50, 'DoubleDown');
  const { gladys, timers, clock } = await setup({ dexcom });
  assert.equal(last(gladys, 'glucose_mgdl'), undefined, 'not published');
  assert.equal(last(gladys, 'trend'), undefined);
  assert.equal(last(gladys, 'trend_arrow'), undefined);
  assert.equal(last(gladys, 'measurement_age'), 20);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /more than 15 min old/);
  assert.match(gladys.fake.connectionStatus.message.fr, /plus de 15 min/);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'never low from a stale measurement');
  // A current measurement: published; then it gets old: only the age moves.
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 120);
  await poll(timers);
  assert.equal(last(gladys, 'glucose_mgdl'), 120);
  assert.match(gladys.fake.connectionStatus.message.en, /is current/);
  const sent = statesOf(gladys, 'glucose_mgdl').length;
  for (let i = 0; i < 4; i += 1) {
    clock.now += POLL;
    await poll(timers);
  }
  assert.equal(statesOf(gladys, 'glucose_mgdl').length, sent, 'never sent again');
  assert.equal(last(gladys, 'measurement_age'), 21);
  assert.match(gladys.fake.connectionStatus.message.en, /more than 15 min old/);
});

test('the stale delay is a setting', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - 20 * MIN, 130);
  const { gladys } = await setup({ dexcom, config: { stale_after: '30' } });
  assert.equal(last(gladys, 'glucose_mgdl'), 130);
  await running.stop();
  const short = createFakeDexcom({ now: () => T0 });
  short.glucose(T0 - 11 * MIN, 130);
  const second = await setup({ dexcom: short, config: { stale_after: '10' } });
  assert.equal(last(second.gladys, 'glucose_mgdl'), undefined);
  assert.match(second.gladys.fake.connectionStatus.message.en, /more than 10 min old/);
});

test('no reading in the last 24 hours: nothing published, the status says so', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.readings = [];
  const { gladys } = await setup({ dexcom });
  assert.equal(gladys.fake.states.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /no measurement for the last 24 hours/);
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'the device is still offered');
});

test('a measurement missing from an answer: the age goes on, stale may fire, never low/high', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 110);
  const { gladys, timers, clock } = await setup({ dexcom });
  clock.now += 5 * MIN;
  dexcom.readings = [];
  await poll(timers);
  assert.equal(last(gladys, 'measurement_age'), 6, 'from the last measurement accepted');
  assert.equal(last(gladys, 'glucose_mgdl'), 110, 'the last value is kept, nothing new');
  assert.match(gladys.fake.connectionStatus.message.en, /no measurement for the last 24 hours/);
  clock.now = T0 - MIN + 15 * MIN;
  await poll(timers);
  assert.deepEqual(events(gladys), [[SCENE_TRIGGERS.MEASUREMENT_STALE, '15']]);
});

test('glucose low: a current measurement fires once per crossing, armed again 5 mg/dL above', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 65, 'SingleDown');
  const { gladys, timers, clock } = await setup({ dexcom });
  // The first reading tells a current low (decision: a missing alert is worse).
  assert.deepEqual(events(gladys), [
    [SCENE_TRIGGERS.GLUCOSE_LOW, '70'],
    [SCENE_TRIGGERS.GLUCOSE_LOW, '80'],
  ]);
  const event = gladys.fake.sceneEvents[0];
  assert.equal(event.data.device, deviceId());
  assert.equal(event.data.device_name, 'Dexcom');
  assert.equal(event.data.glucose, 65);
  assert.equal(event.data.unit, 'mg/dL');
  assert.equal(event.data.trend, 6);
  assert.equal(event.data.trend_arrow, '↓');
  assert.equal(event.data.measured_at, '2026-10-18 07:59 UTC');
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 60);
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 2, 'still low: nothing more');
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 72);
  await poll(timers);
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 68);
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 2, 'within the hysteresis');
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 90);
  await poll(timers);
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 50);
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 5, '54, 70, 80 again');
  assert.equal(gladys.fake.sceneEvents.at(-1).data.glucose, 50);
});

test('glucose high in mmol/L; never for a device not created', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 260, 'DoubleUp');
  const { gladys } = await setup({ dexcom, created: [] });
  assert.equal(gladys.fake.sceneEvents.length, 0, 'not created');
  await running.stop();
  const second = await setup({
    dexcom,
    config: { glucose_unit: 'mmol' },
    created: [device('mmol', 'Maman')],
  });
  assert.deepEqual(events(second.gladys), [
    [SCENE_TRIGGERS.GLUCOSE_HIGH, '180'],
    [SCENE_TRIGGERS.GLUCOSE_HIGH, '250'],
  ]);
  const [event] = second.gladys.fake.sceneEvents;
  assert.equal(event.data.glucose, 14.4);
  assert.equal(event.data.unit, 'mmol/L');
  assert.equal(event.data.device_name, 'Maman', 'the name of the created device');
  assert.equal(event.data.trend_arrow, '↑↑');
});

test('low told again after a gap between measurements; a reconnection never fires twice', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 50);
  const { gladys, timers, clock, app } = await setup({ dexcom });
  const lows = () =>
    gladys.fake.sceneEvents.filter((e) => e.key === SCENE_TRIGGERS.GLUCOSE_LOW).length;
  assert.equal(lows(), 3);
  clock.now += POLL;
  await poll(timers);
  await reconnect(gladys, app);
  assert.equal(lows(), 3, 'the memory survives a reconnection');
  clock.now += 20 * MIN;
  dexcom.glucose(clock.now - MIN, 50);
  await poll(timers);
  assert.equal(lows(), 6, 'a new episode');
});

test('measurement too old: never at the first reading, once per threshold, re-armed by news', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - 20 * MIN, 110);
  const { gladys, timers, clock } = await setup({ dexcom });
  assert.equal(gladys.fake.sceneEvents.length, 0, '15 min already reached at start');
  clock.now = T0 - 20 * MIN + 30 * MIN;
  await poll(timers);
  assert.deepEqual(events(gladys), [[SCENE_TRIGGERS.MEASUREMENT_STALE, '30']]);
  assert.equal(gladys.fake.sceneEvents[0].data.stale_for, 30);
  clock.now += POLL;
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'once');
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 112);
  await poll(timers);
  assert.equal(last(gladys, 'measurement_age'), 1);
  assert.equal(last(gladys, 'glucose_mgdl'), 112);
  clock.now += 15 * MIN;
  await poll(timers);
  assert.deepEqual(events(gladys), [
    [SCENE_TRIGGERS.MEASUREMENT_STALE, '30'],
    [SCENE_TRIGGERS.MEASUREMENT_STALE, '15'],
  ]);
});

test('no scene event at a reading after a clock jump', async () => {
  const { gladys, dexcom, timers, clock } = await setup();
  clock.now += 2 * HOUR;
  clock.jump = 2 * HOUR - POLL;
  dexcom.glucose(clock.now - MIN, 40);
  await poll(timers);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  clock.now += POLL;
  dexcom.glucose(clock.now - MIN, 41);
  await poll(timers);
  assert.ok(gladys.fake.sceneEvents.length > 0, 'the next reading tells it');
});

test('a measurement dated in the future is not current; the status asks to check the clock', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 + HOUR, 50);
  const { gladys } = await setup({ dexcom });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /dated in the future: check the clock of Gladys/,
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /vérifiez l’horloge de Gladys/);
  assert.equal(last(gladys, 'glucose_mgdl'), undefined);
  assert.equal(gladys.fake.sceneEvents.length, 0);
});

test('refused credentials stop for 1 h, 6 h, 24 h, persisted; one forced attempt per series', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const { gladys, dexcom, timers, app } = await setup({ config: { password: WRONG }, dataDir });
  assert.equal(dexcom.requests.length, 1, 'one password sent');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name or the password/);
  assert.match(gladys.fake.connectionStatus.message.en, /stops for 1 h/);
  assert.match(gladys.fake.connectionStatus.message.fr, /a refusé le nom d’utilisateur/);
  assert.deepEqual(timers.delays(), [HOUR]);
  await reconnect(gladys, app);
  assert.match(gladys.fake.connectionStatus.message.en, /refused these credentials earlier/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(dexcom.requests.length, 1, 'nothing sent');
  await running.stop();
  const second = await setup({ config: { password: WRONG }, dataDir, dexcom, now: T0 + 10 * MIN });
  assert.equal(dexcom.requests.length, 1, 'a restart sends nothing');
  assert.deepEqual(second.timers.delays(), [50 * MIN]);
  second.clock.now = T0 + HOUR;
  await second.timers.run();
  assert.equal(dexcom.requests.length, 2);
  assert.deepEqual(second.timers.delays(), [6 * HOUR]);
  second.clock.now += 6 * HOUR;
  await second.timers.run();
  assert.deepEqual(second.timers.delays(), [24 * HOUR]);
  // Saving the same credentials: one attempt, at the end of the floor of
  // 5 min (read moments ago), then never again in this series.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, password: WRONG });
  assert.equal(dexcom.requests.length, 3, 'never within 5 min of the last reading');
  assert.deepEqual(second.timers.delays(), [POLL]);
  second.clock.now += POLL;
  await second.timers.run();
  assert.equal(dexcom.requests.length, 4);
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, password: WRONG });
  assert.equal(dexcom.requests.length, 4);
  assert.match(second.gladys.fake.connectionStatus.message.en, /Already tried again/);
  // The right password works at once and the stop is forgotten.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(storeText(dataDir), /"refusals": \{\s*"/, 'no refusal left');
});

test('a wrong region is a refusal; another region is tried at once', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.region = 'us';
  const { gladys } = await setup({ dexcom });
  assert.equal(dexcom.requests.length, 1);
  assert.match(gladys.fake.connectionStatus.message.en, /not in the chosen region/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, region: 'us' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  for (const r of dexcom.requests) assert.ok(ALLOWED_HOSTS.includes(r.host), r.host);
});

test('the account locked by Dexcom: a stop, never a loop; a restart says why', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.locked = true;
  const { gladys, timers, clock } = await setup({ dexcom, dataDir });
  assert.equal(dexcom.requests.length, 1);
  assert.match(gladys.fake.connectionStatus.message.en, /locked the account/);
  assert.deepEqual(timers.delays(), [HOUR]);
  clock.now += HOUR;
  await timers.run();
  assert.equal(dexcom.requests.length, 2);
  assert.deepEqual(timers.delays(), [6 * HOUR]);
  await running.stop();
  const second = await setup({ dexcom, dataDir, now: T0 + 2 * HOUR });
  assert.equal(dexcom.requests.length, 2);
  assert.match(second.gladys.fake.connectionStatus.message.en, /locked the account earlier/);
});

test('an attempt in flight when the app stops counts as a refusal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const first = await setup({ config: { password: WRONG }, dataDir });
  first.clock.now = T0 + HOUR;
  first.dexcom.gate = new Promise(() => {});
  const before = first.dexcom.requests.length;
  void first.timers.run();
  // The request leaves only once the pending attempt is written (renamed) to /data.
  for (let i = 0; i < 400 && first.dexcom.requests.length === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(storeText(dataDir), /\\"p\\":true/);
  await running.stop();
  const dexcom = createFakeDexcom({ now: () => T0 + HOUR });
  const second = await setup({ config: { password: WRONG }, dataDir, dexcom, now: T0 + HOUR });
  assert.equal(dexcom.requests.length, 0);
  assert.deepEqual(second.timers.delays(), [6 * HOUR], 'one more step');
});

test('a session expired: one login by account id, one more reading; refused again: a failure', async () => {
  const { gladys, dexcom, timers, clock } = await setup();
  dexcom.sessions.push('expired-elsewhere');
  clock.now += POLL;
  await poll(timers);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(dexcom.authentications().length, 1, 'the account id is kept');
  assert.equal(dexcom.logins().length, 2);
  assert.equal(dexcom.reads().length, 3);
  // Refused twice in a row (old, then fresh session): retried later, never a loop.
  const sessionError = {
    status: 500,
    path: 'ReadPublisherLatestGlucoseValues',
    body: { Code: 'SessionNotValid', Message: 'Session not active or timed out' },
  };
  dexcom.failures.push(sessionError, { ...sessionError });
  clock.now += POLL;
  await poll(timers);
  assert.equal(dexcom.logins().length, 3);
  assert.equal(dexcom.reads().length, 5);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the session/);
  assert.deepEqual(timers.delays(), [POLL], 'not a pause of a server error, not a refusal');
  clock.now += POLL;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(dexcom.logins().length, 4, 'the session refused was dropped');
});

test('the account id typed as user name: no AuthenticatePublisherAccount', async () => {
  const { gladys, dexcom } = await setup({ config: { username: ACCOUNT_ID.toUpperCase() } });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(dexcom.authentications().length, 0);
  assert.equal(JSON.parse(dexcom.logins()[0].body).accountId, ACCOUNT_ID);
});

test('an id of all zeros answered by a login is a refusal', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.failures.push({
    status: 200,
    path: 'AuthenticatePublisherAccount',
    body: '"00000000-0000-0000-0000-000000000000"',
  });
  const { gladys, timers } = await setup({ dexcom });
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name/);
  assert.deepEqual(timers.delays(), [HOUR]);
  assert.equal(dexcom.logins().length, 0);
});

test('a login answered 401 is a refusal; a 403 page is not', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.failures.push({ status: 401, path: 'AuthenticatePublisherAccount', body: '' });
  const { gladys, timers } = await setup({ dexcom });
  assert.match(gladys.fake.connectionStatus.message.en, /refused the user name/);
  assert.deepEqual(timers.delays(), [HOUR]);
  await running.stop();
  const other = createFakeDexcom({ now: () => T0 });
  other.failures.push({ status: 403, body: '<html>Forbidden</html>' });
  const second = await setup({ dexcom: other });
  assert.match(second.gladys.fake.connectionStatus.message.en, /HTTP 403/);
  assert.deepEqual(second.timers.delays(), [POLL]);
});

test('HTTP 429: a bounded pause of every path, kept across a reconnection and a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.failures.push({ status: 429, headers: { 'retry-after': '99999999' }, body: '' });
  const { gladys, timers, app } = await setup({ dexcom, dataDir });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [INTERVALS.BUSY_MAX_MS], 'capped at 6 h');
  await reconnect(gladys, app);
  assert.equal(dexcom.requests.length, 1, 'a reconnection does not read');
  assert.match(gladys.fake.connectionStatus.message.en, /pause goes on/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(dexcom.requests.length, 1, 'nor a saved configuration');
  await running.stop();
  const second = await setup({ dexcom, dataDir, now: T0 + HOUR });
  assert.equal(dexcom.requests.length, 1, 'nor a restart');
  assert.deepEqual(second.timers.delays(), [5 * HOUR]);
  second.clock.now = T0 + 6 * HOUR;
  await second.timers.run();
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.ok(!storeText(dataDir).includes('pausedUntil'), 'forgotten after a reading that works');
});

test('5xx of the reading (an unknown Code or none): a pause; other failures retried, doubling', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  const path = 'ReadPublisherLatestGlucoseValues';
  dexcom.failures.push(
    { status: 500, path, body: { Code: 'SomethingNew', Message: 'x' } },
    { status: 503, path, body: '<html>maintenance</html>' },
    { status: 200, path, body: '<html>portal</html>' },
  );
  const { gladys, timers } = await setup({ dexcom });
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 500/);
  assert.deepEqual(timers.delays(), [POLL]);
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503/);
  assert.deepEqual(timers.delays(), [2 * POLL], 'doubling');
  await timers.run();
  assert.match(gladys.fake.connectionStatus.message.en, /unexpected way/);
  assert.deepEqual(timers.delays(), [4 * POLL]);
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a disconnection between the login and the reading: nothing in /data, read again after the floor', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const { gladys, dexcom, timers, app, clock } = await setup({ dataDir });
  app.session.sessionId = null;
  let open;
  dexcom.gate = new Promise((resolve) => {
    open = resolve;
  });
  const logins = dexcom.logins().length;
  clock.now += POLL;
  const round = poll(timers);
  for (let i = 0; i < 400 && dexcom.logins().length === logins; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(dexcom.logins().length, logins + 1, 'the login left');
  gladys.emit('disconnected');
  dexcom.gate = null;
  open();
  await round;
  const reads = dexcom.reads().length;
  assert.equal(reads, 1, 'never read by the closed client');
  const text = storeText(dataDir);
  assert.ok(!/retryAt|pausedUntil/.test(text), text);
  assert.doesNotMatch(text, /"refusals": \{\s*"/);
  await reconnect(gladys, app);
  assert.equal(dexcom.reads().length, reads, 'the attempt left moments ago: the floor');
  assert.deepEqual(timers.delays(), [POLL]);
  clock.now += POLL;
  await timers.run();
  assert.equal(dexcom.reads().length, reads + 1);
  assert.equal(dexcom.logins().length, logins + 1, 'the session of that login is kept');
});

test('a reconnection to Gladys sends the status and Discovery again, without a new login', async () => {
  const { gladys, dexcom, app, clock } = await setup();
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  clock.now += POLL;
  await reconnect(gladys, app);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  assert.equal(dexcom.logins().length, 1, 'the session is kept');
  assert.equal(dexcom.reads().length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('privacy: no health data, user name, password, id nor URL in the logs or /data', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dexcom-app-'));
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.glucose(T0 - MIN, 61);
  const { gladys, timers, logs, clock } = await setup({ dexcom, dataDir });
  dexcom.failures.push(
    { status: 429, body: '' },
    {
      status: 500,
      path: 'ReadPublisherLatestGlucoseValues',
      body: { Code: 'Weird', Message: `SessionId = ${dexcom.sessions[0]}` },
    },
  );
  clock.now += POLL;
  await poll(timers);
  clock.now += HOUR;
  await timers.run();
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: WRONG });
  const text = `${logs.join('\n')}\n${storeText(dataDir)}`;
  for (const secret of [
    USERNAME,
    PASSWORD,
    WRONG,
    ACCOUNT_ID,
    dexcom.sessions[0],
    '55555555',
    'dexcom.com',
    'sessionId',
    'Publisher',
    '"61"',
    ': 61',
  ]) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
  assert.ok(!/glucose|mg\/dL|mmol/i.test(storeText(dataDir)), 'no health data in /data');
});

test('read only: a command is refused; the test button says whether the measurement is current', async () => {
  const { gladys, clock } = await setup();
  const found = gladys.fake.discoveredDevices[0];
  const ack = await gladys.fake.setValue(found, found.features[0], 1);
  assert.equal(ack.success, false);
  clock.now += POLL;
  const result = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(result.success, true, result.error);
  assert.match(result.data.message.en, /Connected: the latest measurement is current/);
});

test('missing or invalid credentials: nothing is sent', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  const { gladys } = await setup({ dexcom, config: { username: '' } });
  assert.match(gladys.fake.connectionStatus.message.en, /Type the user name/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, username: 'a\nb' });
  assert.match(gladys.fake.connectionStatus.message.en, /user name holds a line break/);
  await gladys.fake.configUpdated({ ...BASE_CONFIG, password: 'a\u0007b' });
  assert.match(gladys.fake.connectionStatus.message.en, /control character/);
  assert.equal(dexcom.requests.length, 0);
});

test('readings: the newest readable one is used; a list unreadable is a bad answer', async () => {
  const dexcom = createFakeDexcom({ now: () => T0 });
  dexcom.readings = [
    reading(T0 - 6 * MIN, 100, 'Flat'),
    reading(T0 - MIN, 105, 'FortyFiveUp'),
    { Value: 'x', DT: 'nope' },
  ];
  const { gladys, timers, clock } = await setup({ dexcom });
  assert.equal(last(gladys, 'glucose_mgdl'), 105);
  assert.equal(last(gladys, 'trend_arrow'), '↗');
  dexcom.readings = { not: 'a list' };
  clock.now += POLL;
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /unexpected way/);
});
