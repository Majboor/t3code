/**
 * Noticing that the project changed, and knowing whether it is still changing.
 *
 * This module never decides what a file contains — `scan.ts` does, by hashing. A watcher
 * that reported content would be reporting the state of a file at the moment an event was
 * queued, which is not the state of the file when the sync gets to it. So everything here
 * is a hint with two jobs:
 *
 * - **coalescing**, so one save that rewrites ten files causes one pass and not ten. A
 *   pass over a large tree costs real time, and firing one per event turns a formatter run
 *   into a minute of thrash.
 * - **`activelyChanging`**, the flag the spec asks for so that "this sync never finishes"
 *   can be answered with "because you are still typing" rather than looking like a bug.
 *
 * The timing policy is a pure state machine ({@link ChangeCoalescer}) that takes the
 * current time as an argument and owns no timer, so every rule below is testable without a
 * disk, a clock or a sleep. {@link createTreeWatcher} is the thin part that owns the timer
 * and the `fs.watch` handle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isAlwaysIgnoredName } from "./scan.ts";

export type WatchTiming = {
  /** Quiet period after the last write before a batch is released. */
  readonly debounceMs: number;
  /**
   * Ceiling on how long a batch may be extended by more writes. Without it, a process that
   * writes continuously — a dev server, a long build — postpones every sync forever, and
   * the person never finds out their work is not leaving the laptop.
   */
  readonly maxDebounceMs: number;
  /** How long after a write the tree still counts as actively changing. */
  readonly activelyChangingMs: number;
};

export const DEFAULT_WATCH_TIMING: WatchTiming = {
  debounceMs: 750,
  maxDebounceMs: 10_000,
  activelyChangingMs: 3_000,
};

export type ChangeBatch = {
  /** Project-relative, `/`-separated. A hint about where to look, never a claim about content. */
  readonly paths: readonly string[];
  /**
   * True when the platform told us something changed without saying what — an overflowed
   * event queue, mainly. The batch's paths are then incomplete and only a full scan can
   * say what moved.
   */
  readonly unknownChanges: boolean;
  readonly firstEventAtMs: number;
  readonly lastEventAtMs: number;
};

type PendingBatch = {
  readonly paths: Set<string>;
  unknownChanges: boolean;
  readonly firstEventAtMs: number;
  lastEventAtMs: number;
};

/**
 * The debounce and the actively-changing window, as data. No timers, no clock: every
 * method that needs the time is given it.
 */
export class ChangeCoalescer {
  readonly #timing: WatchTiming;
  #pending: PendingBatch | null = null;
  /**
   * Deliberately outlives the batch. `activelyChanging` answers "did anything write
   * recently", which stays true for a few seconds after the batch has been handed on and
   * the pass it triggered is already running.
   */
  #lastEventAtMs: number | null = null;

  constructor(timing: WatchTiming = DEFAULT_WATCH_TIMING) {
    this.#timing = timing;
  }

  /** `null` for "something changed, we do not know what". */
  record(relativePath: string | null, atMs: number): void {
    this.#lastEventAtMs = atMs;

    if (this.#pending === null) {
      this.#pending = {
        paths: new Set(relativePath === null ? [] : [relativePath]),
        unknownChanges: relativePath === null,
        firstEventAtMs: atMs,
        lastEventAtMs: atMs,
      };
      return;
    }

    if (relativePath === null) {
      this.#pending.unknownChanges = true;
    } else {
      this.#pending.paths.add(relativePath);
    }
    this.#pending.lastEventAtMs = atMs;
  }

  get lastEventAtMs(): number | null {
    return this.#lastEventAtMs;
  }

  hasPending(): boolean {
    return this.#pending !== null;
  }

  /** The spec's flag: a write seen in the last few seconds. */
  isActivelyChanging(atMs: number): boolean {
    return (
      this.#lastEventAtMs !== null && atMs - this.#lastEventAtMs < this.#timing.activelyChangingMs
    );
  }

  /**
   * When the pending batch should be released, or `null` if there is nothing waiting.
   * Whichever comes first: the tree going quiet, or the ceiling on holding a batch back.
   */
  dueAtMs(): number | null {
    if (this.#pending === null) {
      return null;
    }
    return Math.min(
      this.#pending.lastEventAtMs + this.#timing.debounceMs,
      this.#pending.firstEventAtMs + this.#timing.maxDebounceMs,
    );
  }

  /** The batch if it is ready at `atMs`, otherwise `null` and the batch keeps waiting. */
  takeDue(atMs: number): ChangeBatch | null {
    const dueAtMs = this.dueAtMs();
    if (dueAtMs === null || atMs < dueAtMs) {
      return null;
    }
    return this.take();
  }

  /** Releases whatever is pending regardless of timing. For shutdown, and for tests. */
  take(): ChangeBatch | null {
    const pending = this.#pending;
    if (pending === null) {
      return null;
    }
    this.#pending = null;
    return {
      paths: [...pending.paths].toSorted(),
      unknownChanges: pending.unknownChanges,
      firstEventAtMs: pending.firstEventAtMs,
      lastEventAtMs: pending.lastEventAtMs,
    };
  }
}

export type WatchSubscription = { readonly close: () => void };

export type WatchSubscribe = (handlers: {
  readonly onChange: (relativePath: string | null) => void;
  readonly onError: (error: unknown) => void;
}) => WatchSubscription;

export type TreeWatcherOptions = {
  readonly root: string;
  readonly onBatch: (batch: ChangeBatch) => void;
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * Same question `scan.ts` answers, asked about a single path. Defaults to the rules that
   * need no disk access — `.git`, `node_modules`, OS droppings, our own temp files — which
   * is enough to stop a build from waking the sync. Pass
   * `loadProjectIgnoreFilter(root)`'s result to honour `.gitignore` as well.
   */
  readonly isIgnored?: ((relativePath: string) => boolean) | undefined;
  readonly timing?: WatchTiming | undefined;
  readonly now?: (() => number) | undefined;
  /** Injected so the timing rules can be exercised without a filesystem. */
  readonly subscribe?: WatchSubscribe | undefined;
};

export type TreeWatcher = {
  /** A write seen in the last few seconds. Reads the clock every time it is asked. */
  readonly activelyChanging: boolean;
  /** Releases any pending batch immediately. */
  readonly flush: () => void;
  readonly close: () => void;
};

function normaliseWatchFilename(filename: string | Buffer | null): string | null {
  if (filename === null) {
    return null;
  }
  const asString = typeof filename === "string" ? filename : filename.toString("utf8");
  if (asString === "") {
    return null;
  }
  return asString.split(path.sep).join("/");
}

/**
 * The default source of events: one recursive `fs.watch` on the project root.
 *
 * `persistent: false` because keeping the process alive is the app's decision, not a
 * watcher's. A watch error is surfaced rather than swallowed: a mirror whose watcher died
 * looks identical to a mirror over a tree nobody is touching, and the difference matters.
 */
function watchWithFsWatch(root: string): WatchSubscribe {
  return ({ onChange, onError }) => {
    const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      onChange(normaliseWatchFilename(filename));
    });
    watcher.on("error", onError);
    return {
      close: () => {
        watcher.close();
      },
    };
  };
}

export function createTreeWatcher(options: TreeWatcherOptions): TreeWatcher {
  const timing = options.timing ?? DEFAULT_WATCH_TIMING;
  const now = options.now ?? (() => Date.now());
  const isIgnored =
    options.isIgnored ??
    ((relativePath: string) =>
      // An event names a path without saying whether it is a file or a directory — and for
      // a delete there is nothing left to ask. Both readings are tested: over-ignoring here
      // costs a scan that the next event triggers anyway, and the scan is what decides.
      relativePath
        .split("/")
        .some(
          (segment) => isAlwaysIgnoredName(segment, true) || isAlwaysIgnoredName(segment, false),
        ));

  const coalescer = new ChangeCoalescer(timing);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function release(): void {
    clearTimer();
    const batch = coalescer.take();
    if (batch !== null) {
      options.onBatch(batch);
    }
  }

  function arm(): void {
    const dueAtMs = coalescer.dueAtMs();
    if (dueAtMs === null || closed) {
      return;
    }
    clearTimer();
    timer = setTimeout(
      () => {
        timer = null;
        // Re-checked against the clock rather than trusted: more events may have arrived
        // since this timer was set, and the batch is only due when the rules say so.
        const batch = coalescer.takeDue(now());
        if (batch === null) {
          arm();
          return;
        }
        options.onBatch(batch);
      },
      Math.max(0, dueAtMs - now()),
    );
    timer.unref?.();
  }

  const subscription = (options.subscribe ?? watchWithFsWatch(options.root))({
    onChange: (relativePath) => {
      if (closed) {
        return;
      }
      if (relativePath !== null && isIgnored(relativePath)) {
        // Not even recorded as activity: a `node_modules` install writing for a minute is
        // not the user typing, and reporting it as such makes `activelyChanging` useless.
        return;
      }
      coalescer.record(relativePath, now());
      arm();
    },
    onError: (error) => {
      options.onError?.(error);
    },
  });

  return {
    get activelyChanging() {
      return coalescer.isActivelyChanging(now());
    },
    flush: release,
    close: () => {
      closed = true;
      clearTimer();
      subscription.close();
    },
  };
}
