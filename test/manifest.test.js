// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  FEATURES,
  HIGH_THRESHOLDS,
  LOW_THRESHOLDS,
  POLL_INTERVALS,
  REGION_KEYS,
  REGIONS,
  SCENE_TRIGGERS,
  STALE_AFTER,
  STALE_MINUTES,
  UNITS,
} from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const triggers = Object.fromEntries(manifest.scene_triggers.map((t) => [t.key, t]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/, 'scene triggers need 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-dexcom:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-dexcom');
  assert.equal(lock.name, 'gladys-dexcom');
  assert.equal(lock.packages[''].name, 'gladys-dexcom');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.location, undefined, 'the houses of Gladys are never read');
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Not a medical device/);
  assert.match(manifest.description.fr, /Pas un dispositif médical/);
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated with Dexcom/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec Dexcom/);
  assert.match(fields.intro.description.en, /Never tested with a real account or sensor/);
  assert.match(fields.intro.description.fr, /Jamais testée avec un vrai compte ou capteur/);
});

test('the docs: never tested, and the medical warning in bold', () => {
  const en = read('docs/en.md');
  const fr = read('docs/fr.md');
  assert.match(en, /never been tested with a real Dexcom account or sensor/i);
  assert.match(fr, /jamais été testée avec un vrai compte ou capteur Dexcom/i);
  assert.match(
    en,
    /\*\*Not a medical device: never use it for a treatment decision; the alerts may be late or missing\.\*\*/,
  );
  assert.match(
    fr,
    /\*\*Pas un dispositif médical : ne jamais s’en servir pour une décision de traitement ; les alertes peuvent être en retard ou manquer\.\*\*/,
  );
  assert.match(read('README.md'), /\*\*Not a medical device/);
  assert.match(fields.intro.description.en, /^NOT A MEDICAL DEVICE/);
  assert.match(fields.intro.description.fr, /^PAS UN DISPOSITIF MÉDICAL/);
});

test('the license (no personal name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.doesNotMatch(license, /Gage Benne|lmilcent|LM1LC3N7|Louis/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pydexcom/);
  assert.match(notices, /0\.5\.1/);
  assert.match(notices, /Copyright \(c\) 2023 Gage Benne/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; the secret is never said encrypted', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.poll_interval.options.map((o) => o.value),
    POLL_INTERVALS,
  );
  assert.ok(
    POLL_INTERVALS.every((s) => Number(s) >= 300),
    'never more than one reading per 5 min',
  );
  assert.deepEqual(
    fields.stale_after.options.map((o) => o.value),
    STALE_AFTER,
  );
  assert.deepEqual(
    fields.region.options.map((o) => o.value),
    REGION_KEYS,
  );
  assert.deepEqual(Object.keys(REGIONS).sort(), [...REGION_KEYS].sort());
  assert.deepEqual(
    fields.glucose_unit.options.map((o) => o.value),
    UNITS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'username',
    'password',
    'region',
    'poll_interval',
    'stale_after',
    'glucose_unit',
  ]);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.username.type, 'string');
  assert.match(fields.password.description.en, /never shown again, never logged, sent only to/);
  assert.match(fields.password.description.fr, /jamais réaffiché, jamais journalisé/);
  for (const [name, text] of [
    ['manifest', JSON.stringify(manifest)],
    ['docs/en.md', read('docs/en.md')],
    ['docs/fr.md', read('docs/fr.md')],
    ['README.md', read('README.md')],
    ['TODO.md', read('TODO.md')],
  ]) {
    assert.doesNotMatch(text, /chiffr|encrypt/i, `${name}: a secret is not encrypted`);
  }
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined, 'read only: no scene action');
  assert.equal(manifest.widgets, undefined);
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.ok(app.includes(`SCENE_TRIGGERS.${name}`), `${name} is never fired`);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('the triggers: filters and variables are keys of the event; thresholds of the code', () => {
  const glucoseData = [
    'device',
    'threshold',
    'device_name',
    'glucose',
    'unit',
    'trend',
    'trend_arrow',
    'measured_at',
  ];
  const staleData = ['device', 'minutes', 'device_name', 'stale_for', 'measured_at'];
  for (const [key, data, field, values] of [
    [SCENE_TRIGGERS.GLUCOSE_LOW, glucoseData, 'threshold', LOW_THRESHOLDS],
    [SCENE_TRIGGERS.GLUCOSE_HIGH, glucoseData, 'threshold', HIGH_THRESHOLDS],
    [SCENE_TRIGGERS.MEASUREMENT_STALE, staleData, 'minutes', STALE_MINUTES],
  ]) {
    const trigger = triggers[key];
    for (const k of keys([...trigger.fields, ...trigger.variables])) {
      assert.ok(data.includes(k), `${key}: ${k} is not in the event`);
    }
    const device = trigger.fields.find((f) => f.key === 'device');
    assert.equal(device.source, 'devices');
    assert.equal(device.required, false);
    const choice = trigger.fields.find((f) => f.key === field);
    assert.equal(choice.required, true, 'no wildcard: one event per threshold');
    assert.deepEqual(
      choice.options.map((o) => o.value),
      values,
    );
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('features: read only, no switch, pairs and units of the core, no history; keys fixed', () => {
  const gladys = createFakeGladys({ selector: 'dexcom' });
  // Pairs drawn by the front, units of DEVICE_FEATURE_UNITS_BY_CATEGORY
  // (server/utils/constants.js of the core): no glucose unit there.
  const allowed = {
    unknown: { types: ['decimal', 'integer'], units: [] },
    text: { types: ['text'], units: [] },
    duration: { types: ['integer'], units: ['minutes'] },
  };
  const all = new Set();
  for (const unit of UNITS) {
    const { features } = buildDevice(gladys, { key: '0123456789abcdef', name: 'x' }, unit);
    for (const feature of features) {
      all.add(feature.external_id.split(':').at(-1));
      assert.equal(feature.read_only, true, feature.name);
      assert.equal(feature.keep_history, false, `${feature.name}: health data, no history`);
      const rule = allowed[feature.category];
      assert.ok(
        rule?.types.includes(feature.type),
        `${feature.name}: ${feature.category}/${feature.type}`,
      );
      if (rule.units.length === 0)
        assert.equal(feature.unit, undefined, `${feature.name}: no unit`);
      else assert.ok(rule.units.includes(feature.unit), `${feature.name}: ${feature.unit}`);
    }
  }
  assert.deepEqual([...all].sort(), Object.values(FEATURES).sort());
});
