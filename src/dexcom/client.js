// -----------------------------------------------------------------------------
// The Dexcom Share API, as pydexcom 0.5.1 (MIT, ported to JavaScript:
// pydexcom/dexcom.py, const.py, errors.py) uses it. Read only, three POST:
//   General/AuthenticatePublisherAccount   user name and password -> the
//                                          account id (once per session; not
//                                          sent when the account id is given)
//   General/LoginPublisherAccountById      account id and password -> a
//                                          session id
//   Publisher/ReadPublisherLatestGlucoseValues?sessionId=..&minutes=1440&maxCount=1
//                                          the latest reading of the last day
// The host and the application id are fixed per region (never a host taken
// from an answer). The session lives in memory only (the `session` the app
// keeps across a reconnection to Gladys); a session refused by the reading
// makes one login only (never a loop). The credentials travel in the body of
// the logins only: never in a URL, a log or an error message. Errors come as
// HTTP 500 with a JSON `{ Code, Message }`: the Code is read before the
// status (a wrong password is a refusal, never a "server error").
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import {
  ALLOWED_HOSTS,
  BASE_PATH,
  ENDPOINTS,
  MAX_BYTES,
  READ_MINUTES,
  REGIONS,
  TIMEOUTS,
} from '../constants.js';
import { CODES, DexcomError } from './errors.js';
import { httpRequest } from './http.js';
import { apiError, isDefaultUuid, parseReadings, parseUuid, readJson } from './parse.js';

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) return null;
  return Number(raw) * 1000;
};

/** gladys-dexcom/<version>, from package.json (copied into the image). */
export const USER_AGENT = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    return typeof version === 'string' ? `gladys-dexcom/${version}` : 'gladys-dexcom';
  } catch {
    return 'gladys-dexcom';
  }
})();

/** A new, empty session: what a login gives (memory only). */
export const newSession = () => ({ accountId: null, sessionId: null });

/**
 * The error of an answer that carries the API's `{ Code, Message }`, as
 * pydexcom's `_handle_error_code` reads it, or null for a code it does not
 * know (the HTTP status decides then).
 */
function classify(error, status, login) {
  const { code, message } = error;
  if (code === 'SessionIdNotFound' || code === 'SessionNotValid') {
    return new DexcomError(CODES.SESSION, `Session refused (${code})`, { status, apiCode: code });
  }
  // Loose on purpose: pydexcom 0.2-0.4 matched "SSO_AuthenticateMaxAttemptsExceeed"
  // (sic), 0.5 "...Exceeded"; which one Dexcom sends today is to check
  // (TODO.md). A lock is never taken for a passing error.
  if (/MaxAttempts/i.test(code)) {
    return new DexcomError(CODES.LOCKED, 'Account locked (too many attempts)', {
      status,
      apiCode: code,
    });
  }
  // `AccountPasswordInvalid` (0.5), `SSO_AuthenticatePasswordInvalid`,
  // `SSO_AuthenticateAccountNotFound` (0.2), any other `SSO_Authenticate...`.
  if (/^SSO_Authenticate/.test(code) || /PasswordInvalid|AccountNotFound/.test(code)) {
    return new DexcomError(CODES.REFUSED, 'Credentials refused', { status, apiCode: code });
  }
  if (code === 'SSO_InternalError' && /Cannot Authenticate by Account(Name|Id)/.test(message)) {
    return new DexcomError(CODES.REFUSED, 'Credentials refused', { status, apiCode: code });
  }
  if (code === 'InvalidArgument' && /accountName|password|UUID/.test(message)) {
    // A user name, password or account id the API refuses as such: the
    // configuration must change, never tried again and again.
    return new DexcomError(CODES.REFUSED, 'Credentials refused (invalid argument)', {
      status,
      apiCode: code,
    });
  }
  if (login) {
    // A login answered with a code this client does not know: the password
    // may be the cause, so it takes the stop ladder (1 h, 6 h, 24 h), never
    // the short pause of a server error that would send it again and again.
    return new DexcomError(CODES.LOGIN_ERROR, 'Login refused (unknown code)', {
      status,
      apiCode: code,
    });
  }
  return null;
}

export class DexcomClient {
  /**
   * @param {object} options
   * @param {string} options.username the user name, e-mail address or phone
   *   number of the Dexcom account (or its account id, a UUID)
   * @param {string} options.password its password
   * @param {'ous' | 'us' | 'jp'} options.region
   * @param {Function} [options.request] the HTTP transport (tests inject a fake API)
   * @param {object} [options.session] the account and session ids, kept by the app (memory only)
   * @param {(host: string) => string} [options.urlOf] the base URL of a host (loopback tests)
   */
  #username;
  #password;

  constructor({
    username,
    password,
    region,
    request = httpRequest,
    session = newSession(),
    urlOf = (host) => `https://${host}`,
  }) {
    this.#username = username;
    this.#password = password;
    /** The user typed the account id itself (pydexcom's `account_id`). */
    this.givenAccountId = parseUuid(username);
    this.region = Object.hasOwn(REGIONS, region) ? REGIONS[region] : null;
    this.request = request;
    this.session = session;
    this.urlOf = urlOf;
    this.closed = false;
    /** A login of the current latest() call worked. */
    this.authenticated = false;
  }

  close() {
    this.closed = true;
  }

  /** One POST to the host of the region; the API's error body read on any status. */
  async call(endpoint, { body = {}, query = null, login = false } = {}) {
    if (this.closed) throw new DexcomError(CODES.CLOSED, 'Client closed');
    const host = this.region?.host;
    // Never a host outside the fixed list.
    if (!host || !ALLOWED_HOSTS.includes(host)) {
      throw new DexcomError(CODES.REGION, 'Host not in the list');
    }
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const response = await this.request(`${this.urlOf(host)}${BASE_PATH}${endpoint}${search}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(body),
      timeout: TIMEOUTS.API,
      maxBytes: MAX_BYTES,
    });
    const value = readJson(response.body ?? Buffer.alloc(0));
    const error = apiError(value);
    if (error) {
      const known = classify(error, response.status, login);
      if (known) throw known;
    }
    if (login && response.status === 401) {
      // Not seen in pydexcom's recorded answers (a refusal comes as a 500
      // with its Code), but a 401 to a login can only mean the credentials:
      // never tried again and again.
      throw new DexcomError(CODES.REFUSED, 'Credentials refused (HTTP 401)', { status: 401 });
    }
    if (response.status < 200 || response.status > 299) {
      throw new DexcomError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
        ...(error ? { apiCode: error.code } : {}),
      });
    }
    if (value === undefined || error) {
      throw new DexcomError(CODES.BAD_ANSWER, 'Not the JSON of the API');
    }
    return value;
  }

  /** A UUID answered by a login, or a refusal (all zeros), or a bad answer. */
  static #idOf(value) {
    const id = parseUuid(value);
    if (id === null) throw new DexcomError(CODES.BAD_ANSWER, 'Not an id');
    if (isDefaultUuid(id)) throw new DexcomError(CODES.REFUSED, 'Credentials refused (empty id)');
    return id;
  }

  /** A new session (the account id first when unknown). Rejects a DexcomError. */
  async login() {
    const session = this.session;
    session.sessionId = null;
    const applicationId = this.region?.applicationId;
    if (!session.accountId) {
      if (this.givenAccountId) {
        if (isDefaultUuid(this.givenAccountId)) {
          throw new DexcomError(CODES.REFUSED, 'Credentials refused (empty id)');
        }
        session.accountId = this.givenAccountId;
      } else {
        const value = await this.call(ENDPOINTS.AUTHENTICATE, {
          body: { accountName: this.#username, password: this.#password, applicationId },
          login: true,
        });
        session.accountId = DexcomClient.#idOf(value);
        this.authenticated = true;
      }
    }
    const value = await this.call(ENDPOINTS.LOGIN_BY_ID, {
      body: { accountId: session.accountId, password: this.#password, applicationId },
      login: true,
    });
    session.sessionId = DexcomClient.#idOf(value);
    this.authenticated = true;
  }

  /**
   * The latest reading, see #latest. A failure is marked `authenticated`
   * when a login of this call worked: the credentials are fine, whatever
   * failed after (the app then forgets a stop).
   */
  async latest() {
    this.authenticated = false;
    try {
      return await this.#latest();
    } catch (err) {
      if (this.authenticated && err && typeof err === 'object') err.authenticated = true;
      throw err;
    }
  }

  /**
   * The latest reading of the last day: { accountId, measurement } (the
   * measurement null when there is none). Logs in when needed; a session
   * refused makes one login and one more try (refused again: a failure,
   * never a loop). Rejects a DexcomError.
   */
  async #latest() {
    let fresh = false;
    if (!this.session.sessionId || !this.session.accountId) {
      await this.login();
      fresh = true;
    }
    const read = () =>
      this.call(ENDPOINTS.READINGS, {
        query: { sessionId: this.session.sessionId, minutes: READ_MINUTES, maxCount: 1 },
      });
    let value;
    try {
      value = await read();
    } catch (err) {
      if (err?.code === CODES.SESSION) this.session.sessionId = null;
      if (fresh || err?.code !== CODES.SESSION) throw err;
      await this.login();
      try {
        value = await read();
      } catch (again) {
        if (again?.code === CODES.SESSION) this.session.sessionId = null;
        throw again;
      }
    }
    const readings = parseReadings(value);
    if (!readings) throw new DexcomError(CODES.BAD_ANSWER, 'Not a list of readings');
    return { accountId: this.session.accountId, measurement: readings.measurement };
  }
}
