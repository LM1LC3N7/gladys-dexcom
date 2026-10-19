// -----------------------------------------------------------------------------
// A fake Dexcom Share API (in memory): the two logins and the latest
// readings, per region. The shapes come from pydexcom 0.5.1 (MIT, its
// recorded test answers); never checked against a real account (TODO.md).
// Every id and value is made up.
// -----------------------------------------------------------------------------

import { CODES, DexcomError } from '../../src/dexcom/errors.js';

export const USERNAME = 'someone@example.org';
export const PASSWORD = 's3cr3t-Pa55';
export const ACCOUNT_ID = '99999999-9999-4999-8999-999999999999';
export const HOSTS = {
  us: 'share2.dexcom.com',
  ous: 'shareous1.dexcom.com',
  jp: 'share.dexcom.jp',
};
const BASE = '/ShareWebServices/Services/';

/** One reading as the API gives it (`DT` with the offset of the phone). */
export function reading(ms, mgdl, trend = 'Flat', extra = {}) {
  return {
    WT: `Date(${ms})`,
    ST: `Date(${ms})`,
    DT: `Date(${ms}+0200)`,
    Value: mgdl,
    Trend: trend,
    ...extra,
  };
}

export function createFakeDexcom({ now }) {
  const fake = {
    requests: [],
    /** The region the account lives in. */
    region: 'ous',
    /** The readings answered (newest first), or a value to answer as is. */
    readings: [reading(now() - 60_000, 110, 'Flat')],
    /** Session ids given so far; the last one is valid. */
    sessions: [],
    /** The account locked (after too many attempts). */
    locked: false,
    /** { status, headers, body, path } answered once each (FIFO). */
    failures: [],
    unreachable: false,
    gate: null,
    inFlight: 0,
    maxInFlight: 0,
  };

  const json = (status, value, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  });
  const error = (code, message) =>
    json(500, { Code: code, Message: message, TypeName: 'FaultException' });
  const refused = () => error('AccountPasswordInvalid', 'Publisher account password failed');

  function answer(url, options, headers) {
    const index = fake.failures.findIndex((f) => !f.path || url.pathname.endsWith(f.path));
    if (index >= 0) {
      const [f] = fake.failures.splice(index, 1);
      const body = typeof f.body === 'string' ? f.body : JSON.stringify(f.body ?? {});
      return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(body) };
    }
    if (options.method !== 'POST' || headers['content-type'] !== 'application/json') {
      return { status: 405, headers: {}, body: Buffer.from('') };
    }
    const body = JSON.parse(String(options.body ?? '{}'));
    const inRegion = url.host === HOSTS[fake.region];
    const appId =
      fake.region === 'jp'
        ? 'd8665ade-9673-4e27-9ff6-92db4ce13d13'
        : 'd89443d2-327c-4a6f-89e5-496bbb0317db';
    if (url.pathname === `${BASE}General/AuthenticatePublisherAccount`) {
      if (fake.locked) return error('SSO_AuthenticateMaxAttemptsExceeded', 'Locked');
      if (!inRegion || body.applicationId !== appId) return refused();
      if (body.accountName !== USERNAME || body.password !== PASSWORD) return refused();
      return json(200, ACCOUNT_ID);
    }
    if (url.pathname === `${BASE}General/LoginPublisherAccountById`) {
      if (fake.locked) return error('SSO_AuthenticateMaxAttemptsExceeded', 'Locked');
      if (!inRegion || body.applicationId !== appId) return refused();
      if (body.accountId !== ACCOUNT_ID || body.password !== PASSWORD) return refused();
      const id = `55555555-5555-4555-8555-${String(fake.sessions.length + 1).padStart(12, '0')}`;
      fake.sessions.push(id);
      return json(200, id);
    }
    if (url.pathname === `${BASE}Publisher/ReadPublisherLatestGlucoseValues`) {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || sessionId !== fake.sessions.at(-1)) {
        return error(
          'SessionIdNotFound',
          `Failed to find session object. [SessionId = ${sessionId}]`,
        );
      }
      if (url.searchParams.get('minutes') !== '1440' || url.searchParams.get('maxCount') !== '1') {
        return error('InvalidArgument', 'minutes / maxCount');
      }
      return json(200, fake.readings);
    }
    return { status: 404, headers: {}, body: Buffer.from('<html>Not found</html>') };
  }

  /** The transport of src/dexcom/http.js, in memory. */
  fake.request = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    fake.requests.push({
      url: rawUrl,
      host: url.host,
      path: url.pathname.slice(BASE.length),
      query: Object.fromEntries(url.searchParams),
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : String(options.body),
    });
    fake.inFlight += 1;
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
    try {
      if (fake.gate) await fake.gate;
      if (fake.unreachable) throw new DexcomError(CODES.UNREACHABLE, 'ECONNREFUSED');
      return answer(url, { method: options.method ?? 'GET', body: options.body }, headers);
    } finally {
      fake.inFlight -= 1;
    }
  };

  fake.authentications = () =>
    fake.requests.filter((r) => r.path === 'General/AuthenticatePublisherAccount');
  fake.logins = () => fake.requests.filter((r) => r.path === 'General/LoginPublisherAccountById');
  fake.reads = () =>
    fake.requests.filter((r) => r.path === 'Publisher/ReadPublisherLatestGlucoseValues');
  /** Requests that carried the password. */
  fake.passwordsSent = () => fake.requests.filter((r) => r.body?.includes(PASSWORD)).length;
  fake.glucose = (ms, mgdl, trend = 'Flat') => {
    fake.readings = [reading(ms, mgdl, trend)];
  };

  return fake;
}
