// -----------------------------------------------------------------------------
// DexcomApp: the integration. One Dexcom Share account (the account of the
// person wearing a Dexcom G6, G7 or ONE+ sensor, with Share turned on), read
// through the cloud of Dexcom with its user name and password, in the region
// chosen in the configuration. Read only.
//
//   start(config)  (re)connects: the account read, Discovery published, the
//                  loop started
//   loop           every `poll_interval` s (5 min by default): one POST
//                  ReadPublisherLatestGlucoseValues (a login only when the
//                  session is missing or refused) -> glucose, trend, age of
//                  the measurement. A measurement older than `stale_after`
//                  (15 min by default) is not current: only its age is
//                  published (never its glucose nor its trend), and the
//                  status says so. Triggers `glucose_low`, `glucose_high`
//                  (current measurements only, once per crossing) and
//                  `measurement_stale` (once per threshold, never for what
//                  was already stale at start)
//   failures       refused credentials (or a wrong region), or the account
//                  locked by Dexcom, stop for 1 h, then 6 h, then 24 h, kept
//                  in /data: never a loop (a wrong password tried again and
//                  again locks the account); HTTP 429 and 5xx pause every
//                  request (bounded, kept in /data); anything else is
//                  retried, never faster than the poll interval, doubling up
//                  to 1 h
//
// Health data (glucose values, trends, dates of measurements), the user name,
// the password, the account and session ids are never logged nor written to
// /data. The loop is one chain of timers: halt() bumps an epoch, and a run of
// an older epoch (still in flight when Dexcom failed) never schedules itself
// again.
// -----------------------------------------------------------------------------

import { createHash, createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  FEATURES,
  GLUCOSE,
  HIGH_THRESHOLDS,
  INTERVALS,
  LIMITS,
  LOW_THRESHOLDS,
  SCENE_TRIGGERS,
  STALE_MINUTES,
  STORE_FILE,
  TIMEOUTS,
  TREND_ARROWS,
  UNITS,
} from './constants.js';
import {
  accountKey,
  buildDevice,
  createdDevices,
  cut,
  deviceIds,
  glucoseFeature,
} from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { DexcomClient, newSession } from './dexcom/client.js';
import { CODES, DexcomError, isStop } from './dexcom/errors.js';
import { httpRequest } from './dexcom/http.js';
import { formatDate, toMmol } from './dexcom/parse.js';

/** The "Test the connection" button waits 60 s: answer within 55 s. */
const TEST_BUDGET_MS = 55_000;
/** A date this far in the future (clock of Gladys late) is not current. */
const FUTURE_MS = 5 * 60_000;
/** Wall clock and monotonic clock apart by more than this: the clock jumped. */
const CLOCK_JUMP_MS = 5 * 60_000;
/** The configuration could not be read from Gladys: try again after this. */
const CONFIG_RETRY_MS = 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Added to the poll interval: the gap that means "a reading missed". */
const GAP_MARGIN_MS = 2 * MINUTE;
/** Entries per publishTransports call (the SDK refuses more). */
export const TRANSPORTS_PER_CALL = 100;
/** The name Discovery offers (the API gives no name; the user may rename it). */
export const DEVICE_NAME = 'Dexcom';
const STALE = STALE_MINUTES.map(Number);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** A glucose value (mg/dL) in a unit: mg/dL rounded, or mmol/L with one decimal. */
const inUnit = (mgdl, unit) => {
  if (mgdl === null || mgdl === undefined) return null;
  return unit === 'mmol' ? toMmol(mgdl) : Math.round(mgdl);
};
/** The value of a state entry, number or text, as one comparable key. */
const valueOf = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
/** A failure answered by an HTTP status (not a refusal carried by a 500). */
const httpStatus = (err) => (err?.code === CODES.HTTP ? err.status : undefined);

export class DexcomApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Dexcom Share)
   * @param {(host: string) => string} [options.urlOf] the base URL of a host (loopback tests)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now] the wall clock (ms)
   * @param {() => number} [options.monotonic] a clock that never jumps (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'dexcom' }),
    request = httpRequest,
    urlOf,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.urlOf = urlOf;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now: monotonic });
    /** Both clocks at the last reading (a jump of the wall clock is a new baseline). */
    this.lastClock = null;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    this.lastStatus = null;
    /** The /data key of the account: a salted digest of its user name and region (set by run()). */
    this.baseKey = null;
    /**
     * In memory only, kept across a restart of the app for the same account
     * (a reconnection to Gladys), forgotten for another one:
     *   session  the account and session ids (for the same credentials
     *            only: a reconnection never logs in again)
     *   known    the account last read (Discovery during a pause)
     *   stale    key -> { since, reached }: the date of the measurement that
     *            opened the current wait, and the thresholds (minutes)
     *            already reached in it
     *   alarms   key -> { low, high }: the thresholds of "low" and "high"
     *            fired and not armed again yet
     *   lastMeasurement  key -> { timestampMs, firstSeen }: the date of the
     *            last measurement accepted (the age goes on from it when an
     *            answer lacks one) and when it was first seen (monotonic)
     *   lastSeen key -> the monotonic time of the last reading with it
     * Never written to /data.
     */
    this.memoryKey = null;
    this.sessionKey = null;
    this.session = newSession();
    this.known = null;
    this.stale = new Map();
    this.alarms = new Map();
    this.lastMeasurement = new Map();
    this.lastSeen = new Map();
    /**
     * After a failed reading: { key (HMAC of the credentials), at, delay,
     * message }, so that a reconnection to Gladys does not skip the wait.
     */
    this.retryWait = null;
    /** Values last accepted by Gladys (feature -> value), to budget only changes. */
    this.published = new Map();
    /** Where the next cut of each group of states starts (they take turns). */
    this.cursors = new Map();
    /** The reading in flight: one at a time (loop, Discovery). */
    this.reading = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.refusalStep = 0;
    /** A saved configuration may make its one attempt within a stop (see run()). */
    this.forceAttempt = false;
    this.retryDelay = this.minRetry();
    /** key -> account, the account of the last reading (one at most). */
    this.devices = new Map();
    /** The measurement of the last reading is dated in the future (clock of Gladys?). */
    this.future = false;
    this.discoveredKey = null;
    this.transports = new Map();
    this.published.clear();
  }

  /** A failure is never read again faster than the poll interval. */
  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, (this.config?.pollSeconds ?? 300) * 1000);
  }

  pollMs() {
    return this.config.pollSeconds * 1000;
  }

  /** A measurement older than this is not current. */
  staleMs() {
    return this.config.staleMinutes * MINUTE;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: one attempt at once, even within the stop that
   * follows a refusal (a new refusal moves to the next, longer step).
   * `immediate`: read now even within the retry wait of a failure (the test
   * button); neither lifts a pause asked by Dexcom.
   */
  start(rawConfig, { force = false, immediate = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force, immediate }));
  }

  /**
   * Which credentials a refusal or a wait is about: 4 hex of an HMAC (salt of
   * /data) of the user name, password and region. Short on purpose: it only
   * tells a change, and is useless to check a guessed password (1 chance in
   * 65536 that other credentials look the same: they then wait the stop).
   */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.username.toLowerCase(), config.password, config.region]))
      .digest('hex')
      .slice(0, 4);
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  /**
   * The stop kept for this account: { key, step, until, pending, forced,
   * locked } or null. `pending`: an attempt was in flight (counted as a
   * refusal if the app stopped before its answer); `forced`: the one attempt
   * a saved configuration may make in this series was used; `locked`: the
   * last stop was the account locked by Dexcom (else refused credentials).
   */
  storedRefusal(baseKey) {
    const raw = baseKey ? this.store.get('refusals', baseKey) : null;
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (typeof value?.k !== 'string' || !value.k) return null;
      return {
        key: value.k,
        step: Math.max(1, Math.floor(Number(value.s)) || 1),
        until: Number(value.u) || 0,
        pending: value.p === true,
        forced: value.f === true,
        locked: value.l === true,
      };
    } catch {
      return null;
    }
  }

  async writeRefusal(baseKey, refusal) {
    const value = refusal
      ? JSON.stringify({
          k: refusal.key,
          s: refusal.step,
          u: refusal.until,
          p: refusal.pending === true,
          f: refusal.forced === true,
          l: refusal.locked === true,
        })
      : null;
    await this.store.set('refusals', baseKey, value);
  }

  /** Wait for the reading in flight, if any, at most the time of its requests. */
  async settleReading() {
    const reading = this.reading;
    if (!reading) return;
    let handle;
    // A reading makes five requests at most (account id, session, read,
    // session again, read again).
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMEOUTS.API * 5);
    });
    await Promise.race([reading.catch(() => {}), limit]);
    this.timers.clearTimeout(handle);
  }

  /** The stop after the n-th refusal in a row: 1 h, 6 h, then 24 h. */
  stepDelay(step) {
    const steps = INTERVALS.REFUSAL_STEPS_MS;
    return steps[Math.min(Math.max(1, step), steps.length) - 1];
  }

  /**
   * Start from the configuration kept by Gladys (at every connection). If it
   * cannot be read, the last one the SDK received is used; without any, the
   * status says so and a timer tries again: never without status nor timer.
   */
  async startFromGladys() {
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Configuration not read from Gladys: ${err.message}`);
      const kept = this.gladys.config;
      if (kept && typeof kept === 'object' && Object.keys(kept).length > 0) {
        config = kept;
      } else {
        await this.enqueue(async () => {
          this.halt();
          await this.setStatus(false, T.status.configUnreadable);
          this.schedule(CONFIG_RETRY_MS, () => this.startFromGladys());
        });
        return;
      }
    }
    await this.start(config);
  }

  async run(rawConfig, { force = false, immediate = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    // The core keeps the status and Discovery in memory: a start (a
    // reconnection to Gladys included) always sends them again.
    this.lastStatus = null;
    await this.store.load();
    // A reading of this process still in flight (a reconnection or a saved
    // configuration during the attempt that follows a stop): wait for its
    // outcome, written to /data by read(), before looking at the refusal
    // kept there. `pending` then only counts for a process that really died,
    // and never two readings run at once.
    await this.settleReading();

    if (!config.username || !config.password) {
      await this.stopWith(T.status.missingCredentials);
      return;
    }
    if (config.usernameInvalid) {
      await this.stopWith(T.status.usernameInvalid);
      return;
    }
    if (config.passwordInvalid) {
      await this.stopWith(T.status.passwordInvalid);
      return;
    }
    const user = config.username.toLowerCase();
    const memoryKey = createHash('sha256')
      .update(JSON.stringify([user, config.region]))
      .digest('hex');
    if (memoryKey !== this.memoryKey) {
      this.memoryKey = memoryKey;
      this.known = null;
      this.stale = new Map();
      this.alarms = new Map();
      this.lastMeasurement = new Map();
      this.lastSeen = new Map();
      this.retryWait = null;
    }
    // The session of these very credentials is kept (a reconnection to
    // Gladys never logs in again); other credentials start a new session.
    const sessionKey = createHash('sha256')
      .update(JSON.stringify([user, config.password, config.region]))
      .digest('hex');
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.session = newSession();
    }
    this.client = new DexcomClient({
      username: config.username,
      password: config.password,
      region: config.region,
      request: this.request,
      session: this.session,
      ...(this.urlOf ? { urlOf: this.urlOf } : {}),
    });
    // Never the user name.
    this.logger.info(`Reading the configured Dexcom Share account (region ${config.region})`);

    // /data never holds the user name: its entries are keyed by a salted digest.
    this.baseKey = createHmac('sha256', await this.store.salt())
      .update(`account:${config.region}:${user}`)
      .digest('hex')
      .slice(0, 32);
    // A stop for these very credentials: wait for its end (1 h, 6 h, 24 h).
    // Saving the configuration makes one attempt per series; other
    // credentials are tried at once.
    const base = this.baseKey;
    let refusal = this.storedRefusal(base);
    const key = await this.refusalKey(config);
    if (refusal && refusal.key !== key) {
      await this.writeRefusal(base, null);
      refusal = null;
    }
    if (refusal) {
      if (refusal.pending) {
        // An attempt was in flight when the app stopped: its answer is
        // unknown, so it counts as one more refusal (never a loop).
        const step = refusal.step + 1;
        refusal = { ...refusal, step, until: this.now() + this.stepDelay(step), pending: false };
        await this.writeRefusal(base, refusal);
      }
      this.refusalStep = refusal.step;
      // The end read back is capped by the delay of its own step.
      const until = Math.min(refusal.until, this.now() + this.stepDelay(refusal.step));
      if (until < refusal.until) {
        refusal = { ...refusal, until };
        await this.writeRefusal(base, refusal);
      }
      if (this.now() < until) {
        if (force && !refusal.forced) {
          // The one forced attempt of this series: marked used by read(),
          // when its request really leaves (never during a pause).
          this.forceAttempt = true;
        } else {
          this.blocked = true;
          await this.publishKnown();
          const message =
            force && refusal.forced
              ? T.status.alreadyRetried(until - this.now())
              : T.status.stillRefused(until - this.now(), refusal.forced, refusal.locked);
          await this.setStatus(false, message);
          this.schedule(until - this.now(), () => this.retryAfterRefusal(generation));
          return;
        }
      }
    }
    // A pause (HTTP 429 or 5xx) outlives a restart, a reconnection to Gladys
    // and a saved configuration; its end is capped (a clock jump, a file
    // written by hand) and the capped end is written back.
    const stored = Number(this.store.get('meta', this.pauseKey())) || 0;
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (pausedUntil < stored) await this.store.set('meta', this.pauseKey(), String(pausedUntil));
    if (this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.publishKnown();
      await this.setStatus(false, T.status.paused(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    // After a failed reading, a reconnection to Gladys waits for the retry
    // like the loop would (never faster than the interval); the button and
    // a saved configuration read at once.
    // The wait is also kept in /data: a restart of the container waits too.
    const waiting = this.retryWait?.key === key ? this.retryWait : this.storedRetry(key);
    if (!force && !immediate && waiting) {
      if (this.now() < waiting.at) {
        this.retryDelay = waiting.delay;
        await this.publishKnown();
        await this.setStatus(
          false,
          waiting.message ?? T.status.retryPending(waiting.at - this.now()),
        );
        this.schedule(waiting.at - this.now(), () => this.connect(generation));
        return;
      }
      this.retryDelay = waiting.delay;
    }
    await this.connect(generation);
  }

  /** The stop after a refusal is over: one attempt (a new refusal goes one step further). */
  async retryAfterRefusal(generation) {
    if (generation !== this.generation) return;
    this.blocked = false;
    await this.connect(generation);
  }

  /** Discovery from the account last read, and the badges (during a stop). */
  async publishKnown() {
    if (this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
      await this.publishDiscovered();
    }
    await this.publishTransports();
  }

  pauseKey() {
    return `pausedUntil|${this.baseKey}`;
  }

  /**
   * The retry wait after a failed reading, kept in /data as `retryAt|<account
   * digest>` = `<credential key>|<end ms>|<delay ms>`: { key, at, delay } or
   * null. Its end is capped by the longest retry delay.
   */
  storedRetry(key, baseKey = this.baseKey) {
    const raw = baseKey ? this.store.get('meta', `retryAt|${baseKey}`) : null;
    if (!raw) return null;
    const [k, at, delay] = raw.split('|');
    if (k !== key) return null;
    const end = Math.min(Number(at) || 0, this.now() + INTERVALS.RETRY_MAX_MS);
    const wait = Math.min(Math.max(Number(delay) || 0, this.minRetry()), INTERVALS.RETRY_MAX_MS);
    return { key, at: end, delay: wait };
  }

  /** Stopped before any request (configuration): status and badges. */
  async stopWith(message) {
    await this.publishTransports();
    await this.setStatus(false, message);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** Schedule the next reading of the current epoch. */
  scheduleLoop(delay, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => this.loop(generation, epoch));
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** The first reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    try {
      await this.refresh({ publish: true });
      if (generation !== this.generation) return;
      this.logger.info('Dexcom Share answers');
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(this.pollMs(), generation);
  }

  async loop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.reading) {
      // A Discovery reading is in flight: it is this round's.
      await this.reading.catch(() => {});
      if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
      return;
    }
    try {
      await this.refresh({ publish: false });
    } catch (err) {
      // What Dexcom answered is kept in /data even when this loop is no
      // longer the current one; only the rescheduling is skipped then.
      if (this.current(generation, epoch)) await this.failed(err, generation);
      else await this.persistFailure(err);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(this.pollMs(), generation);
  }

  /**
   * Write what a failed reading means to /data, whatever the generation (a
   * refusal or a 429 answered while Gladys disconnected, or while a new
   * configuration started, is never lost). Uses the context captured when
   * the reading started (account key, HMAC, step). Returns the plan:
   * { kind: 'refused' | 'stepWait' | 'pause' | 'retry', step?, delay? }.
   */
  async persistFailure(err) {
    // Already written by read() when the answer arrived: never twice.
    if (err?.plan) return err.plan;
    // The client was replaced (a new configuration): Dexcom said nothing,
    // nothing is written.
    if (err?.code === CODES.CLOSED) return { kind: 'retry' };
    const ctx = err?.context ?? {
      baseKey: this.baseKey,
      key: null,
      step: this.refusalStep,
      pollMs: this.pollMs(),
      retryDelay: this.retryDelay,
    };
    if (!ctx.baseKey || !this.config.username) return { kind: 'retry' };
    const key = ctx.key ?? (await this.refusalKey(this.config));
    const stored = this.storedRefusal(ctx.baseKey);
    const forced = stored?.key === key ? stored.forced : false;
    const now = this.now();
    if (isStop(err)) {
      // 1 h, 6 h, then 24 h for every refusal after: never a loop.
      const step = ctx.step + 1;
      const delay = this.stepDelay(step);
      const locked = err.code === CODES.LOCKED;
      await this.writeRefusal(ctx.baseKey, { key, step, until: now + delay, forced, locked });
      return { kind: 'refused', step, delay };
    }
    // Only an HTTP failure pauses: a session refused comes as a 500 too.
    const status = httpStatus(err);
    let pause = null;
    if (status === 429) {
      // Too many requests: a bounded pause of every path.
      pause = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        Math.max(INTERVALS.BUSY_MIN_MS, ctx.pollMs),
        INTERVALS.BUSY_MAX_MS,
      );
    } else if (status >= 500) {
      const floor = ctx.retryDelay ?? this.retryDelay;
      pause = clamp(err.retryAfterMs ?? floor, floor, INTERVALS.BUSY_MAX_MS);
    }
    if (pause !== null) {
      await this.store.set('meta', `pausedUntil|${ctx.baseKey}`, String(now + pause));
    }
    if (ctx.step > 0) {
      // Within a series of refusals, no failure (a timeout...) is ever
      // retried before the end of the current step.
      const delay = Math.max(this.stepDelay(ctx.step), pause ?? 0);
      await this.writeRefusal(ctx.baseKey, {
        key,
        step: ctx.step,
        until: now + delay,
        forced,
        locked: stored?.key === key ? stored.locked : false,
      });
      return { kind: 'stepWait', step: ctx.step, delay };
    }
    // The retry wait goes to /data too: a failure answered during a
    // reconnection (or before a restart) is never read again sooner.
    const retryDelay = ctx.retryDelay ?? this.retryDelay;
    const next = status === 429 ? retryDelay : Math.min(retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    await this.store.set(
      'meta',
      `retryAt|${ctx.baseKey}`,
      `${key}|${now + (pause ?? retryDelay)}|${next}`,
    );
    return pause !== null ? { kind: 'pause', delay: pause } : { kind: 'retry' };
  }

  /** A reading failed: a long stop on a refusal, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    const plan = await this.persistFailure(err);
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (plan.kind === 'refused' || plan.kind === 'stepWait') {
      this.refusalStep = plan.step;
      this.blocked = true;
      if (plan.kind === 'refused') {
        const what =
          err.code === CODES.LOCKED
            ? 'Dexcom locked the account (too many attempts)'
            : 'Credentials refused by Dexcom';
        this.logger.warn(
          `${what} (stop ${plan.step} in a row): next attempt in ${Math.round(plan.delay / MINUTE)} min`,
        );
      } else {
        this.logger.warn(`Dexcom Share fails after a stop: ${this.describe(err)}`);
      }
      let message;
      if (plan.kind === 'stepWait') message = this.errorMessage(err, plan.delay);
      else if (err.code === CODES.LOCKED) message = T.status.locked(plan.delay);
      else message = T.status.refused(plan.delay);
      await this.setStatus(false, message);
      this.schedule(plan.delay, () => this.retryAfterRefusal(generation));
      return;
    }
    let delay = this.retryDelay;
    const pause = plan.kind === 'pause';
    if (pause) {
      delay = plan.delay;
      this.pausedUntil = this.now() + delay;
    }
    if (httpStatus(err) !== 429)
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    if (!(err instanceof DexcomError)) {
      this.logger.error(`Internal error of the integration: ${this.describe(err)}`);
    } else if (wasOnline || delay === this.minRetry() || pause) {
      this.logger.warn(`Dexcom Share fails: ${this.describe(err)}`);
    }
    const message = this.errorMessage(err, delay);
    this.retryWait = {
      key: await this.refusalKey(this.config),
      at: this.now() + delay,
      delay: this.retryDelay,
      message,
    };
    if (this.baseKey) {
      const { key, at, delay: next } = this.retryWait;
      await this.store.set('meta', `retryAt|${this.baseKey}`, `${key}|${at}|${next}`);
    }
    if (generation !== this.generation) return;
    await this.setStatus(false, message);
    this.schedule(delay, () => this.connect(generation));
  }

  /**
   * A failure in a few words for the logs: never a URL, an id nor a value.
   * A DexcomError message is one of the fixed texts of src/dexcom/; any
   * other error is reduced to its name (its message could quote an answer).
   */
  describe(err) {
    if (!(err instanceof DexcomError)) return `${err?.name ?? 'Error'}`;
    return `${err.name}: ${err.message}`;
  }

  errorMessage(err, delay) {
    // A fault of the integration itself is never shown as a fault of Dexcom.
    if (!(err instanceof DexcomError)) return T.status.internal(delay);
    if (err.code === CODES.TOO_LARGE) return T.status.tooLarge(delay);
    if (err.code === CODES.TLS_UNTRUSTED) return T.status.tlsUntrusted(delay);
    if (err.code === CODES.REGION) return T.status.region(delay);
    if (err.code === CODES.SESSION) return T.status.session(delay);
    if (err.code === CODES.REFUSED) return T.status.refused(delay);
    if (err.code === CODES.LOCKED) return T.status.locked(delay);
    const status = httpStatus(err);
    if (status === 429) return T.status.busy(delay);
    if (status >= 500) return T.status.serverError(status, delay);
    if (status === 403) return T.status.forbidden(delay);
    if (err.code === CODES.BAD_ANSWER || err.code === CODES.HTTP) {
      return T.status.badAnswer(delay);
    }
    return T.status.unreachable(err, delay);
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -----------------------------------------------------------------

  /** Read the account and publish it. Throws when it cannot be read. */
  refresh(options) {
    const reading = this.read(options).finally(() => {
      if (this.reading === reading) this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  /** Attach the context of the reading to a failure and write its outcome to /data. */
  async fail(err, context, session) {
    // The client was replaced: nothing Dexcom said, nothing to keep.
    if (err?.code === CODES.CLOSED) {
      err.plan = { kind: 'retry' };
      return err;
    }
    if (err && typeof err === 'object') {
      // Refused credentials or a locked account: the session is no longer used.
      if (isStop(err)) {
        session.accountId = null;
        session.sessionId = null;
      }
      err.context = context;
      // The outcome is in /data before anyone (a restart waiting for this
      // reading) looks at it; failed() reuses this plan.
      err.plan = await this.persistFailure(err);
    }
    return err;
  }

  async read({ publish }) {
    const client = this.client;
    if (!client) return;
    // The context of this reading, kept with its failure: what is written to
    // /data never depends on what the app became in between.
    const context = {
      baseKey: this.baseKey,
      key: await this.refusalKey(this.config),
      step: this.refusalStep,
      pollMs: this.pollMs(),
      retryDelay: this.retryDelay,
    };
    if (context.step > 0) {
      // An attempt after a stop: if the app stops before the answer, the
      // next start counts it as a refusal.
      const stored = this.storedRefusal(context.baseKey);
      const same = stored?.key === context.key;
      await this.writeRefusal(context.baseKey, {
        key: context.key,
        step: context.step,
        until: same ? stored.until : this.now(),
        pending: true,
        // The one forced attempt of a saved configuration is used now that
        // its request leaves.
        forced: (same && stored.forced) || this.forceAttempt,
        locked: same && stored.locked,
      });
      this.forceAttempt = false;
    }
    let result;
    try {
      result = await client.latest();
    } catch (err) {
      throw await this.fail(err, context, client.session);
    }
    // The credentials work: forget a stop and a pause asked earlier (even if
    // the app moved on meanwhile: the answer is true for these values).
    if (this.storedRefusal(context.baseKey)?.key === context.key) {
      await this.writeRefusal(context.baseKey, null);
    }
    for (const name of ['pausedUntil', 'retryAt']) {
      if (this.store.get('meta', `${name}|${context.baseKey}`)) {
        await this.store.set('meta', `${name}|${context.baseKey}`, null);
      }
    }
    if (client !== this.client) return;
    this.refusalStep = 0;
    this.pausedUntil = 0;

    const createdKeys = new Set(createdDevices(this.gladys).map((c) => c.key));
    // The Dexcom account id is digested at once and not kept here.
    const account = { key: accountKey(result.accountId), name: DEVICE_NAME };
    const followed = [account];

    const now = this.now();
    // A jump of the wall clock between two readings (NTP after a start with
    // a wrong clock): this reading is a new baseline, no event.
    const mono = this.monotonic();
    const jumped =
      this.lastClock !== null &&
      Math.abs(now - this.lastClock.wall - (mono - this.lastClock.mono)) > CLOCK_JUMP_MS;
    if (jumped) this.logger.info('The clock jumped: no scene event at this reading');
    this.lastClock = { wall: now, mono };

    const staleMs = this.staleMs();
    // "A new episode" means at least one reading missed: never less than the
    // stale delay, nor than the poll interval + 2 min (a slow request included).
    const gapMs = Math.max(staleMs, this.pollMs() + GAP_MARGIN_MS);
    // A measurement dated more than a day ahead is no measurement (a phone
    // or a sensor with a wrong clock); any measurement more than 5 min ahead
    // is never current, and counts for the clock warning of the status.
    const raw = result.measurement;
    const future = Boolean(raw && raw.timestampMs - now > FUTURE_MS);
    const m = raw && raw.timestampMs <= now + DAY ? raw : null;
    // Not seen for a while (readings missed): what "low" and "high" fired is
    // forgotten, a low still there is told again.
    const seen = this.lastSeen.get(account.key);
    if (seen !== undefined && mono - seen > gapMs) this.alarms.delete(account.key);
    this.lastSeen.set(account.key, mono);
    const previous = this.lastMeasurement.get(account.key);
    if (m && m.timestampMs !== previous?.timestampMs) {
      // A gap between two measurements: a new episode.
      if (previous && Math.abs(m.timestampMs - previous.timestampMs) > gapMs) {
        this.alarms.delete(account.key);
      }
      this.lastMeasurement.set(account.key, { timestampMs: m.timestampMs, firstSeen: mono });
    }
    const known = this.lastMeasurement.get(account.key) ?? null;
    account.hasMeasurement = m !== null;
    account.mgdl = m?.mgdl ?? null;
    account.trend = m ? m.trend : null;
    // Without a measurement in this answer, the age goes on from the last
    // one accepted (never a value, never "low" nor "high" from it).
    account.timestampMs = m?.timestampMs ?? known?.timestampMs ?? null;
    account.firstSeen = m ? known.firstSeen : null;
    account.age = account.timestampMs === null ? null : Math.max(0, now - account.timestampMs);
    // Current: a measurement of this answer, not older than the stale
    // delay, not in the future. Only then are its glucose and trend
    // published, and may "low" or "high" fire.
    account.current = m !== null && account.age <= staleMs && m.timestampMs - now <= FUTURE_MS;

    /** [trigger, account, threshold, reached]: events to fire (marked reached once sent). */
    const candidates = [];
    try {
      if (account.age !== null) {
        const created = createdKeys.has(account.key);
        if (account.hasMeasurement) {
          this.checkAlarms(account, created && !jumped, mono, candidates);
        }
        this.checkStale(account, created, jumped, candidates);
      }
    } catch (err) {
      this.logger.debug(`The triggers were skipped: ${this.describe(err)}`);
    }
    this.devices = new Map(followed.map((d) => [d.key, d]));
    this.future = future;
    this.online = true;
    this.retryDelay = this.minRetry();
    this.retryWait = null;
    this.known = { devices: followed };

    const discoveredKey = JSON.stringify([this.config.unit, followed.map((d) => [d.key, d.name])]);
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishStates();
    await this.publishTransports();
    // An event is marked reached only once it left; beyond 30, the rest
    // waits for the next reading.
    for (const [trigger, item, threshold, reached] of candidates.slice(
      0,
      LIMITS.EVENTS_PER_ROUND,
    )) {
      if (await this.fire(trigger, item, threshold)) reached.add(threshold);
    }
    if (candidates.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.info(
        `${candidates.length - LIMITS.EVENTS_PER_ROUND} scene event(s) left for the next reading`,
      );
    }
    await this.setStatus(true, this.okMessage());
  }

  /**
   * "Low" and "high": per threshold, once per crossing. Only a current
   * measurement (not older than the stale delay, not in the future, first
   * seen by the integration within the stale delay) of a device created in
   * Gladys fires, the first reading included (a low already there at start
   * is told; after a restart of the container it may be told again). Armed
   * again 5 mg/dL back inside the threshold, or when the account was not
   * read for the gap delay, or after a gap between two measurements. A
   * device not created records nothing: once created, a low still there is
   * told.
   */
  checkAlarms(account, canFire, mono, candidates) {
    const entry = this.alarms.get(account.key) ?? { low: new Set(), high: new Set() };
    this.alarms.set(account.key, entry);
    const fresh = account.current && mono - account.firstSeen <= this.staleMs();
    const value = account.mgdl;
    const hyst = GLUCOSE.HYSTERESIS_MGDL;
    for (const threshold of LOW_THRESHOLDS) {
      const mg = Number(threshold);
      if (value >= mg + hyst) entry.low.delete(threshold);
      else if (value < mg && !entry.low.has(threshold) && fresh && canFire) {
        candidates.push([SCENE_TRIGGERS.GLUCOSE_LOW, account, threshold, entry.low]);
      }
    }
    for (const threshold of HIGH_THRESHOLDS) {
      const mg = Number(threshold);
      if (value <= mg - hyst) entry.high.delete(threshold);
      else if (value > mg && !entry.high.has(threshold) && fresh && canFire) {
        candidates.push([SCENE_TRIGGERS.GLUCOSE_HIGH, account, threshold, entry.high]);
      }
    }
  }

  /**
   * "Measurement too old": per threshold (minutes), once per wait for a new
   * measurement; never for a threshold already reached at the first
   * reading, for a new device, nor after a clock jump. A newer measurement
   * arms again the thresholds above its age.
   */
  checkStale(account, created, jumped, candidates) {
    const { age, timestampMs } = account;
    // A date far in the future (the clock of Gladys late at start): no
    // baseline from it.
    if (timestampMs - this.now() > FUTURE_MS) return;
    const state = this.stale.get(account.key);
    const first = jumped || !state;
    const entry = state ?? { since: timestampMs, reached: new Set() };
    if (state && timestampMs > state.since) {
      for (const minutes of [...entry.reached]) {
        if (minutes * MINUTE > age) entry.reached.delete(minutes);
      }
      entry.since = timestampMs;
    }
    this.stale.set(account.key, entry);
    const reached = entry.reached;
    if (age < STALE[0] * MINUTE) {
      reached.clear();
      return;
    }
    for (const minutes of STALE) {
      if (age < minutes * MINUTE || reached.has(minutes)) continue;
      // Only the devices created in Gladys fire; the others only record.
      if (first || !created) reached.add(minutes);
      else candidates.push([SCENE_TRIGGERS.MEASUREMENT_STALE, account, minutes, reached]);
    }
  }

  /**
   * 'current'; 'future' (dated ahead: clock of Gladys?); 'none' (the last
   * answer gave no measurement); 'stale' (only its age is published).
   */
  measurementState() {
    const account = [...this.devices.values()][0];
    if (account?.current) return 'current';
    if (this.future) return 'future';
    if (!account?.hasMeasurement) return 'none';
    return 'stale';
  }

  okMessage() {
    return T.status.ok({
      state: this.measurementState(),
      staleMinutes: this.config.staleMinutes,
    });
  }

  /** A glucose value (mg/dL) in the unit of the configuration. */
  inUnit(mgdl) {
    return inUnit(mgdl, this.config.unit);
  }

  /** The name of the device created in Gladys (renamed by the user), else the default. */
  createdName(account) {
    const id = deviceIds(this.gladys, account.key).device;
    const created = (this.gladys.devices ?? []).find((d) => d?.external_id === id);
    const name = typeof created?.name === 'string' && created.name ? created.name : account.name;
    return cut(name, LIMITS.NAME_LENGTH);
  }

  /** Resolves true when the event left, false otherwise (never throws). */
  async fire(trigger, account, threshold) {
    const common = {
      device: deviceIds(this.gladys, account.key).device,
      device_name: this.createdName(account),
      measured_at: formatDate(account.timestampMs) ?? '',
    };
    const data =
      trigger === SCENE_TRIGGERS.MEASUREMENT_STALE
        ? { ...common, minutes: String(threshold), stale_for: Math.floor(account.age / MINUTE) }
        : {
            ...common,
            threshold,
            glucose: this.inUnit(account.mgdl),
            unit: this.config.unit === 'mmol' ? 'mmol/L' : 'mg/dL',
            trend: account.trend,
            trend_arrow: TREND_ARROWS[account.trend] ?? '-',
          };
    return this.gladys.publishSceneEvent(trigger, data).then(
      () => true,
      (err) => {
        this.logger.warn(`Scene event not sent: ${err.message}`);
        return false;
      },
    );
  }

  /** Never throws: a refusal of Gladys is not a Dexcom failure. */
  async publishDiscovered() {
    const devices = [...this.devices.values()].map((account) =>
      buildDevice(this.gladys, account, this.config.unit),
    );
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.reading) {
      // A reading is in flight: no second request, publish what it brings.
      await this.reading.catch(() => {});
      await this.publishDiscovered();
      return;
    }
    if (this.online && !this.paused() && this.client) {
      const generation = this.generation;
      const done = await this.refresh({ publish: true }).then(
        () => true,
        async (err) => {
          // Any failure takes the usual path (refusal, pause, retry); an
          // older generation only keeps what Dexcom answered.
          if (generation !== this.generation) {
            await this.persistFailure(err);
            return true;
          }
          await this.failed(err, generation);
          return false;
        },
      );
      if (done) return;
    }
    if (this.devices.size === 0 && this.known) {
      for (const device of this.known.devices) this.devices.set(device.key, device);
    }
    await this.publishDiscovered();
  }

  /**
   * The states of the created device: the age whenever a measurement is
   * known; the glucose (every glucose feature the device has, each in the
   * unit of its key) and the trend only when the measurement is current.
   * Only the features of the created device get a state (a feature it lacks
   * waits for "Update"). A created device missing from the reading gets
   * nothing.
   */
  statesOf() {
    const groups = { measurement: [] };
    const units = UNITS.map((unit) => [unit, glucoseFeature(unit)]);
    for (const created of this.gladys.devices ?? []) {
      const account = this.devices.get(this.keyOf(created));
      if (!account || account.age === null) continue;
      const ids = deviceIds(this.gladys, account.key);
      const has = new Set((created.features ?? []).map((f) => f?.external_id));
      const state = (key, value) =>
        value === null || value === undefined || !has.has(ids.feature(key))
          ? null
          : { device_feature_external_id: ids.feature(key), state: value };
      const text = (key, value) =>
        !has.has(ids.feature(key))
          ? null
          : { device_feature_external_id: ids.feature(key), text: value };
      const age = state(FEATURES.AGE, Math.min(1_000_000, Math.floor(account.age / MINUTE)));
      const bundle = account.current
        ? [
            ...units.map(([unit, key]) => state(key, inUnit(account.mgdl, unit))),
            state(FEATURES.TREND, account.trend),
            text(FEATURES.TREND_ARROW, TREND_ARROWS[account.trend] ?? '-'),
            age,
          ]
        : [age];
      groups.measurement.push(bundle.filter(Boolean));
    }
    return groups;
  }

  keyOf(created) {
    const prefix = this.gladys.externalId('account:');
    const id = created?.external_id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
    const key = id.slice(prefix.length);
    return key.includes(':') ? null : key;
  }

  /**
   * Publish what changed, every state within the minute budget (POST /state
   * admits 300 per minute; this integration stays under 250), group by group
   * in priority order. A bundle is never split; when a group is cut, its
   * bundles take turns. What is held back goes at a later reading.
   */
  async publishStates() {
    const changed = (bundle) =>
      bundle.filter((s) => this.published.get(s.device_feature_external_id) !== valueOf(s));
    let room = this.budget.remaining();
    const list = [];
    let held = 0;
    for (const [name, bundles] of Object.entries(this.statesOf())) {
      const fresh = bundles.map(changed).filter((b) => b.length > 0);
      const size = fresh.reduce((sum, b) => sum + b.length, 0);
      if (size <= room) {
        for (const b of fresh) list.push(...b);
        room -= size;
        continue;
      }
      const start = fresh.length > 0 ? (this.cursors.get(name) ?? 0) % fresh.length : 0;
      let taken = 0;
      for (let i = 0; i < fresh.length; i += 1) {
        const b = fresh[(start + i) % fresh.length];
        if (b.length > room) break;
        list.push(...b);
        room -= b.length;
        taken += 1;
      }
      this.cursors.set(name, start + taken);
      held += fresh.slice(taken).reduce((sum, b) => sum + b.length, 0);
    }
    if (held > 0) this.logger.debug(`${held} state(s) held back (state budget)`);
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    } catch (err) {
      // Gladys may have counted them anyway: the budget does too.
      this.budget.record(list.length);
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  /** Forget what was published for a device (Gladys forgot it too). */
  forget(externalId) {
    if (typeof externalId !== 'string') return;
    const prefix = `${externalId}:`;
    for (const id of [...this.published.keys()]) {
      if (id === externalId || id.startsWith(prefix)) this.published.delete(id);
    }
  }

  async publishTransports() {
    const entries = createdDevices(this.gladys).map(({ key, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.devices.has(key) ? 'cloud' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  /** Created or updated: the SDK forgot the values of this device, so do we. */
  async deviceCreated(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
    if (this.online) await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
  }

  /** Read only: nothing is ever sent to Dexcom. */
  async setValue() {
    throw new Error(T.errors.readOnly);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * Reconnects, then reports, within 55 s. Never shortens the stop after a
   * refusal (only saving the configuration does) nor a pause.
   */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { immediate: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ state: this.measurementState() });
  }
}
