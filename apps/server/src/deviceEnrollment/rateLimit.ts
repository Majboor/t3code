/**
 * A fixed-window counter, small enough to read in one sitting.
 *
 * There is no HTTP rate limiter in this server to reuse — the only one that
 * exists lives inside the WebSocket RPC loop and is keyed by session, which is
 * exactly what these routes do not have. So this is a new one, and it is
 * deliberately the least machinery that does the job: a map from key to a
 * window start and a count, in this process's memory.
 *
 * What that buys and what it does not:
 * - It is per-process. A second server instance has its own map. That is fine
 *   here because the thing being protected is a row in a SQLite file that only
 *   this process serves; a shared limiter would need a shared store, and this
 *   server does not have one.
 * - It does not survive a restart. A patient attacker can wait for a deploy.
 *   They can also just wait ten minutes for the code to expire, which is the
 *   real bound on this whole flow.
 * - Fixed windows, not sliding: a caller can spend a full window's budget at the
 *   end of one window and again at the start of the next. Twice the nominal rate
 *   at the boundary is irrelevant against a 256-bit code and buys a great deal of
 *   simplicity.
 *
 * @module DeviceEnrollment
 */

export interface FixedWindowLimiter {
  /**
   * Records an attempt and says whether it may proceed.
   *
   * Attempts are counted whether or not they are allowed, so a caller that keeps
   * hammering a blocked key keeps it blocked rather than sliding back under the
   * limit by being refused.
   */
  readonly check: (key: string, nowMs: number) => boolean;
  /** For tests, which should not have to reach into a module-level map. */
  readonly reset: () => void;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/**
 * Entries are dropped once their window has lapsed, but only when the map has
 * grown enough to be worth walking. Without this the map is a slow leak keyed by
 * attacker-controlled strings, which is its own denial of service.
 */
const PRUNE_ABOVE_ENTRIES = 1024;

export function makeFixedWindowLimiter(options: {
  readonly windowMs: number;
  readonly maxAttempts: number;
}): FixedWindowLimiter {
  const windows = new Map<string, Window>();

  const prune = (nowMs: number) => {
    for (const [key, window] of windows) {
      if (nowMs - window.startedAtMs >= options.windowMs) {
        windows.delete(key);
      }
    }
  };

  return {
    check: (key, nowMs) => {
      if (windows.size > PRUNE_ABOVE_ENTRIES) {
        prune(nowMs);
      }
      const existing = windows.get(key);
      const window =
        existing === undefined || nowMs - existing.startedAtMs >= options.windowMs
          ? { startedAtMs: nowMs, count: 0 }
          : existing;
      window.count += 1;
      windows.set(key, window);
      return window.count <= options.maxAttempts;
    },
    reset: () => {
      windows.clear();
    },
  };
}
