# gladys-dexcom

[Gladys Assistant](https://gladysassistant.com) external integration for
**Dexcom Share**: the glucose of a Dexcom G6, G7 or ONE+ sensor shared with
Dexcom Share. The account becomes a Gladys device (glucose, trend as a
number and an arrow, age of the measurement), with three scene triggers
(glucose low, glucose high, measurement too old). A measurement older than
the chosen delay (15 min by default) is never published as current. Read
only, through the cloud of Dexcom (the API of Dexcom Share, as the pydexcom
library uses it).

**Not a medical device: never use it for a treatment decision; the alerts may be late or missing.**
**Unofficial integration, not affiliated with Dexcom. Never tested with a
real account or sensor yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (DexcomApp)
                 ├─ src/dexcom/client.js   the two logins, the latest reading
                 ├─ src/dexcom/http.js     the only network access (node:https, no redirect)
                 ├─ src/dexcom/parse.js    answers -> plain values (dates, trends)
                 ├─ src/dexcom/errors.js   error codes, what a stop is
                 ├─ src/budget.js          states per minute
                 ├─ src/store.js           /data: stops, pauses (digests only)
                 └─ src/devices.js         devices (pure), never fewer features
```

- **Access**: `General/AuthenticatePublisherAccount` (user name, password,
  application id of the region) gives the account id, then
  `General/LoginPublisherAccountById` gives a session id, kept in memory;
  a session refused makes one login only. The region (`ous`, `us`, `jp`)
  is chosen in the configuration: one fixed host per region
  (`shareous1.dexcom.com`, `share2.dexcom.com`, `share.dexcom.jp`), never
  a host from an answer.
- **Reading** (every 5 min by default, 5 to 15 min): one
  `Publisher/ReadPublisherLatestGlucoseValues?minutes=1440&maxCount=1`.
  Never two readings of an account within 5 min, whatever the path (test
  button, saved configuration, Discovery, reconnection): the start of the
  last one is kept (monotonic in memory, wall clock in `/data`); within the
  floor, the last reading is published again. The error body
  (`{ Code, Message }`, sent with HTTP 500) is read before the status: a
  wrong password is a refusal, never a server error; an unknown code of a
  login takes the stop ladder.
- **Current or not**: a measurement older than `stale_after` (15 min by
  default) or dated in the future publishes only its age; the status says
  so; "low" / "high" never fire from it.
- **Stops** (refused credentials or region, account locked by Dexcom): 1 h,
  then 6 h, then 24 h (persisted in `/data` with 4 hex of a salted HMAC of
  the credentials, only to see a change; an attempt in flight at a stop
  counts as a refusal); saving the same credentials makes one attempt per
  series. HTTP 429 and 5xx pause every request (Retry-After, 1 min to 6 h,
  never under the poll interval, kept in `/data`); other failures retry
  from the poll interval, doubling to 1 h (the wait kept in `/data`).
- **Device**: `account:<non-secret digest of the account id>`; glucose
  `unknown`/`decimal` without unit (the core has no glucose unit: the unit
  is in the name and in the feature key, `glucose_mgdl` / `glucose_mmol`),
  trend `unknown`/`integer` (0-9, pydexcom's scale), arrow `text`/`text`,
  age `duration`/`integer` minutes. No history by default.
- **Triggers**: `glucose_low` / `glucose_high` (fixed thresholds; current
  measurements only; once per crossing, hysteresis 5 mg/dL; told at the
  first reading too), `measurement_stale` (15 min to 4 h; once per
  threshold; never at the first reading).
- **Privacy**: no glucose value, trend, date of measurement, user name,
  password, account or session id in the logs or `/data`; no URL logged
  (the session id is in the query of the reading, as pydexcom sends it).

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake Dexcom Share API
(`test/helpers/fakeDexcom.js`), plus loopback http servers for the
transport. No test touches the real Dexcom Share API or the Internet.

## Credits

- [pydexcom](https://github.com/gagebenne/pydexcom) (MIT, 0.5.1): the API,
  its regions, logins, errors and the shapes of its answers, ported to
  JavaScript (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- [gladys-librelinkup](https://github.com/LM1LC3N7/gladys-librelinkup): the
  structure of the app, the retry policy and the triggers.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
