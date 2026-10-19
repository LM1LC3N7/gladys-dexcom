// -----------------------------------------------------------------------------
// The integration in other time zones: test/app.test.js runs again in a child
// process west (Lisbon) and east (Helsinki) of the reference zone. Dates are
// UTC everywhere: nothing may depend on the zone of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const zone of ['Europe/Lisbon', 'Europe/Helsinki']) {
  test(`test/app.test.js passes with TZ=${zone}`, () => {
    // A runner of its own (not a sub-test of this one).
    const env = { ...process.env, TZ: zone };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', 'test/app.test.js'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(child.status, 0, `${zone}:\n${child.stdout}\n${child.stderr}`);
  });
}
