# TODO — Dexcom v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own (Louis's rule: one message per wave in
  /t/10385). Lot 8, wave 3 (reserved in post 275 of the thread).

## Status

- [x] **Milestone 1 — MVP** (2026-10-19): pydexcom 0.5.1 ported to
      JavaScript (account id, session, latest reading; errors read from
      the `{ Code, Message }` body before the status); one device per
      account (glucose in the unit of the configuration, trend 0-9 and its
      arrow, measurement age), read only, no history by default; region
      `ous` (default) / `us` / `jp`; a measurement older than `stale_after`
      (15 min by default) never published as current (age only, status);
      triggers `glucose_low`, `glucose_high`, `measurement_stale`; stop
      ladder 1 h / 6 h / 24 h persisted (refused credentials or region,
      account locked); 429 / 5xx pause bounded and persisted; status and
      Discovery sent again at every `connected`, session kept; never a
      smaller device; 250 states/min budget; no health data, user name,
      password, account or session id in logs or `/data`; docs en/fr with
      the medical warning in bold. Tested with unit tests against the SDK's
      fake Gladys, a fake Dexcom Share API (shapes of pydexcom's recorded
      answers) and loopback http servers. **Never tested with a real
      account or sensor.** No Docker on this PC: no e2e test in a
      container. The store validator
      (`npx github:GladysAssistant/integration-store .`) was not run by the
      development agent (not allowed from its sandbox): the main session
      runs it (`C:\Users\user\devtools\validate.ps1 -Repo gladys-dexcom`).
- [x] **Review corrections** (2026-10-19, xhigh review of `1ad682b`, refused:
      3 blocking, 3 important, 8 minor points; the 18 hostile scenarios of
      the reviewer are in `test/review.test.js`, turned into the behaviour
      asked): see "Decisions" (review corrections).
- [ ] **Milestone 2 — real account** (a tester wearing a Dexcom sensor with
      Share on and one follower): record real answers as fixtures (ids,
      values removed), fix what differs. To check first:
  - whether the honest `user-agent` (`gladys-dexcom/<version>`) and no
    `Accept-Encoding` header are accepted (pydexcom sends
    `Accept-Encoding: application/json` and the requests user agent);
  - how a wrong password, a wrong region, a locked account and an account
    without follower are answered (`AccountPasswordInvalid` with HTTP 500
    is what pydexcom recorded; `SSO_AuthenticateMaxAttemptsExceeded` for
    the lock; after how many attempts, and for how long);
  - the session lifetime (how often `SessionIdNotFound` / `SessionNotValid`
    comes back), and whether a phone number logs in as the user name;
  - how fresh the latest reading of Share is compared to the app (if it
    lags by minutes, the default `stale_after` of 15 min may need a
    change);
  - whether the API gives `Trend` as a name (as today) everywhere, and what
    `None`, `NotComputable` and `RateOutOfRange` look like (pydexcom marks
    them "unconfirmed");
  - whether a `text` feature (the arrow) is shown well by the Gladys front;
  - the real spelling of the lock code: `SSO_AuthenticateMaxAttemptsExceeed`
    (pydexcom 0.2-0.4) or `...Exceeded` (0.5, a linter fix of 2024?), and
    the other `SSO_Authenticate*` codes still sent (`PasswordInvalid`,
    `AccountNotFound` of pydexcom 0.2); every unknown code of a login
    takes the ladder meanwhile;
  - what LOW and HIGH look like in Share (Value 39 / 40 and 401, a flag, a
    `Trend` of their own?), and whether the error codes 0-12 of the old
    receivers can still come (refused as glucose: minimum 13);
  - `DT`, `WT` and `ST`: which one is the date of the measurement (`DT` is
    read first, as pydexcom does), whether they differ (phone and server
    clocks), and whether a measurement can come dated ahead or older than
    the last one (a late replica): both are ignored today;
  - the floor of 5 min between readings against the lag of Share: a reading
    right after a save can miss a measurement by up to 5 min.
- [ ] **Later, if users ask** (not now): the readings of the last 24 hours
      (published with their real dates would need the core), several
      accounts, a "current" binary feature, thresholds of the user's own.
- [ ] **Milestone 3 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published.

## Decisions

- **Duplicate check**: done by the main session before the brief (lot 8,
  post 275); not repeated here.
- **Reuse**: pydexcom 0.5.1 (MIT, Python, read at tag `0.5.1`, commit
  `696cc9c`, cloned read-only in `_ref/pydexcom`) cannot run in this Node
  image: its client is ported to JavaScript (`src/dexcom/`), the MIT
  notice in `THIRD_PARTY_NOTICES.md`, copied into the image. Structure and
  protections from LM1LC3N7/gladys-librelinkup (same author, Apache-2.0,
  same health framework, read only). The standard Apache-2.0 `LICENSE` (no
  personal name).
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-dexcom:0.1.0`);
  the first patch release gives 0.1.1.
- **Not a medical device**: the docs say it in bold (en/fr), the manifest
  catalog description and intro say it, the trigger descriptions say "may
  be late or missing, never a medical alarm". The docs say that nothing is
  told when Dexcom Share itself cannot be read.
- **Endpoints** (pydexcom's `dexcom.py`, `const.py`):
  `POST General/AuthenticatePublisherAccount` (`{ accountName, password,
applicationId }` -> the account id, a JSON string), `POST
General/LoginPublisherAccountById` (`{ accountId, password,
applicationId }` -> the session id), `POST
Publisher/ReadPublisherLatestGlucoseValues?sessionId=..&minutes=1440&maxCount=1`
  (body `{}`, the latest reading of the last day). No other route, no
  command. The session id goes in the query as pydexcom sends it: no URL
  is ever logged nor put in an error message (`src/dexcom/http.js`).
- **Account id typed as user name**: a UUID in the user name field is used
  as the account id (pydexcom's `account_id`), skipping the first login.
- **Region**: a setting (`ous` by default, for France, Belgium,
  Switzerland; `us`; `jp`), each with its fixed host and application id
  (pydexcom's `DEXCOM_BASE_URLS`, `DEXCOM_APPLICATION_IDS`); the client
  refuses any host outside `ALLOWED_HOSTS`. A wrong region is answered
  `AccountPasswordInvalid` (pydexcom's tests): it takes the stop ladder,
  the status asks to check the region, and another region is tried at once
  (the region is part of the credential digest).
- **Errors**: the `{ Code, Message }` body is read before the HTTP status,
  as pydexcom's `_handle_error_code`: `AccountPasswordInvalid`,
  `SSO_InternalError` "Cannot Authenticate by AccountName/AccountId",
  `InvalidArgument` (accountName / password / UUID), an all-zero id, or a
  401 to a login: refused; `SSO_AuthenticateMaxAttemptsExceeded`: locked;
  `SessionIdNotFound` / `SessionNotValid`: one new session (account id
  kept) and one more reading, refused again: a passing failure (retried
  after the poll interval, doubling), never a refusal nor a pause. Any
  other 5xx (an unknown Code included) or 429: a pause.
- **Refusals and lock**: ladder 1 h, 6 h, then 24 h, persisted as JSON `{ k:
4 hex of the HMAC of [user name, password, region], s: step, u: end, p:
pending, f: forced, l: locked }` under a salted digest of the region and
  user name; same rules as gladys-librelinkup (context captured with the
  request, written as soon as the answer arrives whatever the generation,
  pending attempt counted, one forced attempt per step when the
  configuration is saved, read-back end capped by its step, any other
  failure within a series waits for the end of the step). The lock takes
  the ladder too (never a 429-like short pause): the lock lasts an unknown
  time and each attempt may extend it.
- **Pauses**: HTTP 429 (Retry-After) pauses every path, bounded max(1 min,
  poll interval) to 6 h; 5xx for the back-off delay (or a longer
  Retry-After, up to 6 h). Persisted, capped when read back, removed after
  a reading that works. Saving the configuration does not lift a pause.
  Other failures retry from max(1 min, poll interval), doubling up to 1 h,
  the wait kept in `/data`.
- **Poll interval**: 300 (default), 600, 900 s: the sensor gives a value
  every 5 minutes, so never more than one reading per 5 minutes.
- **Current measurement** (`stale_after`: 10, 15 by default, 20, 30, 60
  min): a measurement of this answer, at most that old and not more than
  5 min in the future. Otherwise glucose, trend and arrow are not
  published (Gladys keeps the last value with its own date), only the age;
  the connection status (still "connected") says "more than N min old",
  "no measurement for the last 24 hours" or "dated in the future: check
  the clock of Gladys". A measurement more than a day ahead is dropped. A
  "current" binary feature was not added (the age and the trigger cover
  it; noted for later).
- **Glucose unit**: the core has neither mg/dL nor mmol/L
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY`, checked in `server/utils/constants.js`
  at `52dcb652` in `_ref/gladys-core`, and in the SDK 0.15 constants): the
  glucose is `unknown`/`decimal` without unit, the unit in the feature name
  and key (`glucose_mgdl` / `glucose_mmol`), as gladys-librelinkup. A
  setting `glucose_unit` (mg/dL by default, mmol/L) chooses the feature
  Discovery offers; every glucose feature a created device has gets its
  value in the unit of its key. mmol/L = mg/dL ÷ 18.0156, one decimal
  (pydexcom multiplies by 0.0555: same result to one decimal in the
  plausible range, one rule shared with gladys-librelinkup). To ask the
  core for glucose units if users want them.
- **Features** (all read only, `keep_history: false`, health data):
  glucose; trend `unknown`/`integer` 0-9 (pydexcom's
  `DEXCOM_TREND_DIRECTIONS`; a name or number it does not know: 0); trend
  arrow `text`/`text` (pydexcom's `TREND_ARROWS`, "-" for 0 instead of an
  empty text); measurement age `duration`/`integer` `minutes` (from the
  epoch ms of `DT`, else `WT` / `ST`: UTC, the offset only tells the zone
  of the phone). Glucose outside 10-1000 mg/dL or a date that does not
  parse: no measurement.
- **External ids**: `account:<16 hex of SHA-256("gladys-dexcom:account:<account id>")>`
  (the Dexcom id never appears in Gladys). Device name "Dexcom" (the API
  gives no name; the events use the name of the created device).
- **Low / high triggers**: fixed thresholds 54, 70, 80 / 180, 250, 300
  mg/dL (labels with mmol/L; Dexcom Share gives no target range); one event
  per threshold crossed (required field). Only a current measurement, first
  seen within `stale_after`, of the created device fires; strict
  comparison. Marked fired once the event left; armed again at threshold +
  5 mg/dL (low) or - 5 mg/dL (high), or after a gap of max(`stale_after`,
  poll + 2 min) (account unread, or between two measurements). Told at the
  first reading (a missing alert is worse than a repeated one); memory in
  RAM only, kept across a reconnection to Gladys. No event after a clock
  jump.
- **Stale trigger**: the rules of gladys-librelinkup (thresholds 15, 30,
  60, 120, 240 min; never at the first reading, nor for a device not
  created, nor after a clock jump).
- **Event data**: low / high: `device`, `threshold`, `device_name`,
  `glucose` (unit of the configuration), `unit`, `trend`, `trend_arrow`,
  `measured_at` (UTC text); stale: `device`, `minutes`, `device_name`,
  `stale_for`, `measured_at`. Health data in scene variables is on purpose
  (a notification needs it): the docs say so.
- **Timeout 30 s per request, test button 60 s** (budget 55 s; a reading
  can take up to five requests: account id, session, reading, session
  again, reading again).
- **Caps**: answers of 256 KB at most, 250 states/min, badges in calls of
  100, 30 events per reading. One reading at a time.
- **Privacy**: no glucose value, trend, date of measurement, user name,
  password, account or session id in a log, an error message or `/data`;
  no URL logged; an error of the integration itself is logged by its name
  only (its message could quote an answer). The Dexcom `Message` of an
  error is matched, never shown nor logged (it quotes the session id).
- **Transport badge**: `cloud` when Dexcom Share answers, `unreachable`
  otherwise. `transports: ["cloud"]`.
- `gladys_version >=5.1.0` (scene triggers). Category `services`. No
  `location: true`.
- **Dates**: every date shown is UTC; `test/timezone.test.js` runs
  `test/app.test.js` and `test/review.test.js` (around midnight UTC) again
  with TZ=Europe/Lisbon and TZ=Europe/Helsinki.
- **Review corrections of `1ad682b`** (they override the items above where
  they differ):
  - (B1) a floor of 5 min (`INTERVALS.READ_FLOOR_MS`) between two readings
    of an account (its `/data` key), whatever the path: the start of the
    last reading is kept before its first request (monotonic in memory,
    wall clock in `/data` as `lastRead|<account digest>`, read back capped
    at now). Within it, no request: Discovery, states (age and currency
    computed again) and status from the last reading (or its failure
    message), the next reading at its start + the poll interval; the test
    button answers "read N min ago... next reading in M min"; the scan
    button and the loop never read within it. Only exception: other
    credentials after a refusal or a lock, within the ladder. A forced
    attempt with the same credentials waits for the end of the floor;
  - (B2) `/MaxAttempts/i` is a lock; `/^SSO_Authenticate/` and
    `/PasswordInvalid|AccountNotFound/` a refusal; any other code (but a
    session code) answered to a login is `LOGIN_ERROR`, a stop of the
    ladder, never the pause of a server error;
  - (B3) states are computed again when published (`derive()`): a value
    that got old or is in the future is never sent again as current
    (device created or updated, reconnection, start within the floor);
  - (I1) the client marks `err.authenticated` when a login of the call
    worked: the stop is forgotten and the failure takes the usual path;
  - (I2) an attempt closed by a new start (`CLOSED`) is rewritten with
    `pending: false` (or the stop forgotten when a login worked): never
    one more step for it;
  - (I3) values below 13 mg/dL are not glucose (sensor error codes 0-12);
  - (M1) a measurement older than the last one accepted is ignored (the
    last one stands);
  - (M2) a lock is about the account: any password of it stays in the
    series (one attempt at once per step, then the next step; the forced
    attempt of a step stays used when it is refused, an automatic attempt
    at the end of a step opens a new one);
  - (M3) the date of the measurement is part of what tells a glucose,
    trend or arrow changed: the same value at a new measurement is sent
    again (`publishStates`, not `publishChangedStates`, which would drop
    it);
  - (M4) a measurement more than 5 min ahead is not accepted: no value, no
    age from it (the age of the last one accepted), the clock warning;
  - (M5) the review tests run around midnight UTC in Lisbon and Helsinki;
  - (M6) docs aligned; (M7) `npm audit fix` (brace-expansion, dev only);
    (M8) milestone 2 completed above.
