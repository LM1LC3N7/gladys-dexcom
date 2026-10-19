# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested with a real Dexcom account or sensor: the
  latest measurement of a Dexcom G6, G7 or ONE+ sensor shared with Dexcom
  Share, read through the cloud of Dexcom (the Dexcom Share API, as
  pydexcom uses it). Read only. Not a medical device: never use it for a
  treatment decision; the alerts may be late or missing.
- One Gladys device per account: glucose (mg/dL or mmol/L, chosen in the
  configuration), trend (0 to 9 and its arrow), measurement age. No history
  by default.
- Region of the account: outside the United States (Europe: France,
  Belgium, Switzerland...), United States or Japan.
- A measurement older than the chosen delay (15 minutes by default) is
  never published as current: only its age, and the status says so.
- Scene triggers "Glucose low" and "Glucose high" (fixed thresholds,
  current measurements only, once per crossing) and "Measurement too old"
  (15 minutes to 4 hours).
- Refresh every 5 minutes (the default), 10 or 15 minutes.
- The password kept by Gladys and never shown again, never logged; refused
  credentials (or a wrong region) and an account locked by Dexcom stop for
  1 h, then 6 h, then 24 h, kept in `/data`; HTTP 429 and 5xx pause every
  request, bounded and kept in `/data`.
- Button "Test the connection".

### Changed (review before the first release)

- Never more than one reading every 5 minutes per account, whatever starts
  it (test button, saved configuration, Discovery, reconnection, restart):
  the last reading is published again instead, and the test button says
  when it was read and when the next reading comes.
- More error codes of Dexcom taken as a refusal or a lock (both spellings
  of "MaxAttempts"); an unknown error code of a login takes the stop
  ladder, never a short pause.
- The age and currency of a measurement are computed again whenever states
  are sent: a device updated between two readings never gets a value that
  got old.
- A login that works ends a stop even if the reading fails after it; an
  attempt cut by a reconnection is no longer counted as a refusal.
- Values 0 to 12 (sensor error codes) are not glucose values; a measurement
  older than the last one, or in the future, is ignored (no age from it).
- A lock is about the account: another password makes one attempt, then
  waits for the next step.
- The same glucose at a new measurement is sent again (dated right).
