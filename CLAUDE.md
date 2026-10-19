# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Dexcom Share (the sharing of
the Dexcom G6, G7 and ONE+ sensors): a Node.js service (Node 22+, ESM, no
build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the latest measurement of one Dexcom
account (the person wearing the sensor) through the Dexcom Share API (user
name and password, then a session id), as the pydexcom library (MIT) does;
that library is ported, not installed. Read only, pull only. **Health data,
and not a medical device.** See `TODO.md` for the status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every SDK handler, registered before connect()
src/app.js                        DexcomApp: start queue, loop, failures, states, triggers
src/dexcom/client.js              the two logins (region, fixed host), the latest reading
src/dexcom/http.js                the only network access (node:https, no redirect)
src/dexcom/parse.js               answers -> plain values (dates, trends, error body)
src/dexcom/errors.js              error codes; what a stop is
src/devices.js                    the device (pure), external ids, never fewer features
src/config.js                     DEFAULTS (mirror the manifest) + normalization
src/store.js                      /data: stops, pauses, salt (digests only)
src/budget.js                     sliding window of the states sent per minute
src/i18n.js                       statuses and messages (en / fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys (SDK) + fake Dexcom Share
```

## Rules

- **External ids are forever**: `account:<16 hex of SHA-256 of the account
id>` and the feature keys of `src/constants.js` (the unit is part of the
  glucose key). Changing the digest recipe creates a new device and orphans
  the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, the scene trigger keys, their fields and
  their option values.
- **Read only**: no request other than the two logins and the latest
  reading, no command.
- **Hosts**: only those of `REGIONS` (`src/constants.js`), chosen by the
  region setting; never a host taken from an answer.
- **Health and privacy**: never log a URL (the session id is in the query
  of the reading), and never put a glucose value, a trend, the date of a
  measurement, the user name, the password, the account or session id in a
  log, an error message or `/data`. Every feature keeps no history by
  default. The docs keep the bold warning: not a medical device, never for
  a treatment decision, alerts may be late or missing.
- **Current or not**: a measurement older than `stale_after` (or in the
  future) is never published as current: only its age. Currency is
  computed when states are published (`derive()`), never kept from the
  reading.
- **One reading per 5 min per account**, whatever the path (test button,
  saved configuration, Discovery, reconnection, restart): see
  `INTERVALS.READ_FLOOR_MS` and `publishFromLast()`; only other
  credentials after a refusal or a lock may read within it.
- **Refusals** (wrong credentials or region, account locked): the stop
  ladder (1 h, 6 h, 24 h) must never become a loop (a wrong password tried
  again and again locks the account); a session refused makes one login
  only. The error body `{ Code, Message }` is read before the HTTP status
  (Dexcom answers a wrong password with a 500).
- **Units**: only those of the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`;
  it has no glucose unit (the unit goes in the feature name).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, before the first release).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects; the catalog
  `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **Encoding.** Files are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake in the manifest, docs, README, CHANGELOG, TODO, CLAUDE.md, the
  notices and `src/**/*.js`. Write files with an editor, never through a
  shell that guesses a code page.
- **pydexcom is MIT**: its notice stays in `THIRD_PARTY_NOTICES.md`, copied
  into the image.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
