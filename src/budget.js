// -----------------------------------------------------------------------------
// A sliding one-minute window of what was sent: POST /state admits 300 states
// per minute per integration. The states that matter (the measurement) go
// first; the others only within what is left.
// -----------------------------------------------------------------------------

const WINDOW_MS = 60_000;

export class Budget {
  /**
   * @param {{ perMinute: number, now?: () => number }} options `now`: a
   *   monotonic clock (a jump of the wall clock must not empty the window)
   */
  constructor({ perMinute, now = () => performance.now() }) {
    this.perMinute = perMinute;
    this.now = now;
    this.entries = []; // [at, count]
  }

  #prune() {
    const since = this.now() - WINDOW_MS;
    while (this.entries.length > 0 && this.entries[0][0] <= since) this.entries.shift();
  }

  used() {
    this.#prune();
    return this.entries.reduce((sum, [, count]) => sum + count, 0);
  }

  remaining() {
    return Math.max(0, this.perMinute - this.used());
  }

  record(count) {
    if (count > 0) this.entries.push([this.now(), count]);
  }
}
