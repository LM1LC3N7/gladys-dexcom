// -----------------------------------------------------------------------------
// The transport (src/dexcom/http.js) and the client against loopback http
// servers: deadline, size cap, no redirect, POST body, no URL in an error,
// only the hosts of the fixed list, the error body read before the status.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DexcomClient, newSession } from '../src/dexcom/client.js';
import { CODES, DexcomError, isStop } from '../src/dexcom/errors.js';
import { httpRequest } from '../src/dexcom/http.js';

let server;
let base;
const seen = [];
/** What the next readings answer: [status, body]. */
let readings = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      const json = (status, value, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      const path = req.url.split('?')[0];
      if (path === '/slow') return; // never answers
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.alloc(4096, 0x20));
        return;
      }
      if (path === '/redirect') {
        res.writeHead(302, { location: 'https://elsewhere.example.org/' });
        res.end();
        return;
      }
      if (path.endsWith('/General/AuthenticatePublisherAccount')) {
        json(200, '99999999-9999-4999-8999-999999999999');
        return;
      }
      if (path.endsWith('/General/LoginPublisherAccountById')) {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (body.password === 'wrong') {
          json(500, {
            Code: 'AccountPasswordInvalid',
            Message: 'Publisher account password failed',
          });
          return;
        }
        json(200, '55555555-5555-4555-8555-555555555555');
        return;
      }
      if (path.endsWith('/Publisher/ReadPublisherLatestGlucoseValues')) {
        const [status, value, headers] = readings.shift() ?? [200, []];
        json(status, value, headers);
        return;
      }
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>Forbidden</html>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const loopback = (url, options) => httpRequest(url, { ...options, allowHttp: true });
const client = (options = {}) =>
  new DexcomClient({
    username: 'user@example.org',
    password: 'pässword',
    region: 'ous',
    request: loopback,
    urlOf: () => base,
    ...options,
  });

test('plain http is refused unless the loopback tests allow it', async () => {
  await assert.rejects(httpRequest(`${base}/x`, { timeout: 1000, maxBytes: 100 }), (err) => {
    assert.equal(err.code, CODES.BAD_ANSWER);
    assert.ok(!err.message.includes('127.0.0.1'));
    return true;
  });
});

test('a deadline, a size cap, no redirect followed; no URL in the errors', async () => {
  await assert.rejects(
    loopback(`${base}/slow?sessionId=secret-id`, { timeout: 200, maxBytes: 100 }),
    (err) => {
      assert.equal(err.code, CODES.TIMEOUT);
      assert.ok(!err.message.includes('slow') && !err.message.includes('secret-id'));
      return true;
    },
  );
  await assert.rejects(loopback(`${base}/big`, { timeout: 2000, maxBytes: 1000 }), {
    code: CODES.TOO_LARGE,
  });
  const redirect = await loopback(`${base}/redirect`, { timeout: 2000, maxBytes: 1000 });
  assert.equal(redirect.status, 302, 'given back, not followed');
  await assert.rejects(
    loopback('http://127.0.0.1:1/x', { timeout: 2000, maxBytes: 100 }),
    (err) => err instanceof DexcomError && err.code === CODES.UNREACHABLE,
  );
});

test('the client: the two logins, then the reading with the session id in the query', async () => {
  seen.length = 0;
  const session = newSession();
  readings = [
    [
      200,
      [{ WT: 'Date(1745081013817)', DT: 'Date(1745081013817-0400)', Value: 224, Trend: 'Flat' }],
    ],
  ];
  const result = await client({ session }).latest();
  assert.deepEqual(result, {
    accountId: '99999999-9999-4999-8999-999999999999',
    measurement: { mgdl: 224, timestampMs: 1745081013817, trend: 4 },
  });
  const [auth, login, read] = seen;
  assert.equal(auth.method, 'POST');
  assert.equal(auth.url, '/ShareWebServices/Services/General/AuthenticatePublisherAccount');
  assert.deepEqual(JSON.parse(auth.body), {
    accountName: 'user@example.org',
    password: 'pässword',
    applicationId: 'd89443d2-327c-4a6f-89e5-496bbb0317db',
  });
  assert.equal(Number(auth.headers['content-length']), Buffer.byteLength(auth.body));
  assert.equal(auth.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(login.body).accountId, '99999999-9999-4999-8999-999999999999');
  assert.equal(
    read.url,
    '/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=55555555-5555-4555-8555-555555555555&minutes=1440&maxCount=1',
  );
  assert.equal(read.body, '{}');
  assert.equal(session.sessionId, '55555555-5555-4555-8555-555555555555', 'kept in memory');
});

test('the error body is read before the status: a wrong password is a refusal, not a 500', async () => {
  await assert.rejects(client({ password: 'wrong' }).latest(), (err) => {
    assert.equal(err.code, CODES.REFUSED);
    assert.equal(err.status, 500);
    assert.equal(isStop(err), true);
    assert.ok(!err.message.includes('wrong'));
    return true;
  });
});

test('429 with Retry-After; a session refused right after a login is not retried', async () => {
  readings = [[429, { message: 'slow down' }, { 'retry-after': '120' }]];
  await assert.rejects(client().latest(), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 120_000);
    assert.equal(isStop(err), false);
    return true;
  });
  seen.length = 0;
  readings = [[500, { Code: 'SessionIdNotFound', Message: 'Failed to find session object.' }]];
  const session = newSession();
  await assert.rejects(client({ session }).latest(), { code: CODES.SESSION });
  assert.equal(seen.length, 3, 'one login, one reading: never a loop');
  assert.equal(session.sessionId, null, 'dropped');
});

test('never a host outside the list; the client closed sends nothing', async () => {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    return { status: 200, headers: {}, body: Buffer.from('[]') };
  };
  for (const region of ['eu', 'constructor', '__proto__']) {
    await assert.rejects(
      new DexcomClient({ username: 'a', password: 'p', region, request }).latest(),
      { code: CODES.REGION },
    );
  }
  const closed = client({ request });
  closed.close();
  await assert.rejects(closed.latest(), { code: CODES.CLOSED });
  assert.deepEqual(urls, []);
});

test('what a stop is', () => {
  assert.equal(isStop(new DexcomError(CODES.REFUSED, 'x')), true);
  assert.equal(isStop(new DexcomError(CODES.LOCKED, 'x')), true);
  assert.equal(isStop(new DexcomError(CODES.SESSION, 'x', { status: 500 })), false);
  assert.equal(isStop(new DexcomError(CODES.HTTP, 'HTTP 401', { status: 401 })), false);
});
