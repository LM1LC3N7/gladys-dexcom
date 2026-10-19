// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume, for what the integration
// learns and must keep across restarts:
//   - refusals: per account (a salted digest of the region and user name), a
//     JSON `{ k, s, u, p, f, l }`: 4 hex of an HMAC (keyed with `meta.salt`)
//     of the credentials Dexcom stopped (only to see a change), the number
//     of stops in a row, the end of the stop (1 h, 6 h, 24 h), an attempt in
//     flight, the one forced attempt used, whether the account was locked.
//   - meta: `salt`, a random key generated once for the digests above,
//     `pausedUntil|<account digest>`, the end of a pause after HTTP 429 or
//     5xx, and `retryAt|<account digest>`, `<4 hex>|<end>|<next delay>`, the
//     retry wait after a failed reading.
// Never health data (glucose, trend, date of a measurement), a user name, a
// password, an account or session id.
// Writes are atomic (temporary file + rename) and queued. When the file
// cannot be written (no /data during development), values stay in memory.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECTIONS = ['refusals', 'meta'];
const EMPTY = () => Object.fromEntries(SECTIONS.map((section) => [section, {}]));

export class Store {
  #writes = Promise.resolve();

  /** @param {{ filePath: string, logger?: { warn: Function } }} options */
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = EMPTY();
    this.loaded = null;
  }

  /** Reads the file once; later calls share the first read. */
  load() {
    this.loaded ??= readFile(this.filePath, 'utf8')
      .then((content) => {
        const parsed = JSON.parse(content);
        const pick = (value) =>
          Object.fromEntries(
            Object.entries(value && typeof value === 'object' ? value : {}).filter(
              ([, v]) => typeof v === 'string' && v,
            ),
          );
        this.data = Object.fromEntries(
          SECTIONS.map((section) => [section, pick(parsed?.[section])]),
        );
      })
      .catch((err) => {
        if (err.code !== 'ENOENT')
          this.logger?.warn(`Store unreadable, starting empty: ${err.message}`);
        this.data = EMPTY();
      });
    return this.loaded;
  }

  get(section, key) {
    return this.data[section]?.[key] ?? null;
  }

  async set(section, key, value) {
    if (value === null || value === undefined) delete this.data[section][key];
    else this.data[section][key] = value;
    await this.#save();
  }

  /** The random key of this installation (created on first use). */
  async salt() {
    let salt = this.get('meta', 'salt');
    if (!salt) {
      salt = randomBytes(32).toString('hex');
      await this.set('meta', 'salt', salt);
    }
    return salt;
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(`Store not saved, values kept in memory only: ${err.message}`);
    }
  }
}
