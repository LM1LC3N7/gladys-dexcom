// -----------------------------------------------------------------------------
// The texts read by Gladys, the store and people are clean UTF-8: no BOM, no
// mojibake (a file written through a wrong code page). The source files too:
// the runtime messages live in src/i18n.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sources = (dir) =>
  readdirSync(new URL(dir, root), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${dir}${name.replaceAll('\\', '/')}`);

const FILES = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'index.js',
  ...sources('src/'),
];

// The patterns asked for by the project rules: "Ã", "Â", the "â€" family and
// "Å’" / "Å“" (Œ / œ read as Windows-1252). Uppercase accents decode to "Ã"
// followed by a Windows-1252 symbol (Ã‰ for É, Ã€ for À, Ã‡ for Ç).
const MOJIBAKE = /Ã|Â|â€|Å[’“]/;

test('the mojibake check catches lowercase and uppercase accents', () => {
  for (const word of ['Ã©tÃ©', 'Ã‰tÃ©', 'Ã€ jour', 'FranÃ‡ais', 'â€™', 'â€”', 'Å“uvre', 'Â«']) {
    assert.ok(MOJIBAKE.test(word), word);
  }
  for (const word of ['été', 'Été', 'À jour', 'Ça', 'l’heure', 'œuvre', 'Œuvre', '« — »', '…']) {
    assert.ok(!MOJIBAKE.test(word), word);
  }
});

test('the source files are part of the check', () => {
  assert.ok(FILES.includes('src/i18n.js'));
  assert.ok(FILES.includes('src/dexcom/client.js'));
});

for (const file of FILES) {
  test(`${file} is clean UTF-8`, () => {
    const bytes = readFileSync(new URL(file, root));
    assert.ok(
      !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), `${file} has invalid UTF-8`);
    const match = MOJIBAKE.exec(text);
    assert.equal(
      match,
      null,
      `${file} has mojibake near "${match?.input.slice(match.index, match.index + 20)}"`,
    );
  });
}
