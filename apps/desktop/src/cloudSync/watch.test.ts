import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ChangeBatch,
  ChangeCoalescer,
  createTreeWatcher,
  DEFAULT_WATCH_TIMING,
  type WatchSubscribe,
} from "./watch.ts";

const TIMING = { debounceMs: 100, maxDebounceMs: 500, activelyChangingMs: 3000 } as const;

describe("ChangeCoalescer", () => {
  it("turns one save that rewrote ten files into one batch", () => {
    const coalescer = new ChangeCoalescer(TIMING);

    for (let index = 0; index < 10; index += 1) {
      coalescer.record(`src/file-${index}.ts`, 1000 + index);
    }

    expect(coalescer.takeDue(1050)).toBeNull();
    const batch = coalescer.takeDue(1200);
    expect(batch?.paths).toHaveLength(10);
    expect(batch?.firstEventAtMs).toBe(1000);
    expect(batch?.lastEventAtMs).toBe(1009);
    expect(coalescer.hasPending()).toBe(false);
  });

  it("reports a path once however many events it produced", () => {
    const coalescer = new ChangeCoalescer(TIMING);
    coalescer.record("a.ts", 0);
    coalescer.record("a.ts", 10);
    coalescer.record("a.ts", 20);

    expect(coalescer.takeDue(200)?.paths).toEqual(["a.ts"]);
  });

  it("extends the wait while writes keep arriving", () => {
    const coalescer = new ChangeCoalescer(TIMING);
    coalescer.record("a.ts", 0);
    expect(coalescer.dueAtMs()).toBe(100);

    coalescer.record("b.ts", 90);
    expect(coalescer.dueAtMs()).toBe(190);
    expect(coalescer.takeDue(150)).toBeNull();
  });

  it("stops extending at the ceiling, so a continuous writer still gets a pass", () => {
    const coalescer = new ChangeCoalescer(TIMING);
    for (let at = 0; at <= 600; at += 50) {
      coalescer.record(`file-${at}.ts`, at);
    }

    // Every write moved the debounce, but the batch is due 500ms after the first one.
    expect(coalescer.dueAtMs()).toBe(500);
    expect(coalescer.takeDue(600)).not.toBeNull();
  });

  it("keeps activelyChanging true for a few seconds after the batch has been taken", () => {
    const coalescer = new ChangeCoalescer(TIMING);
    coalescer.record("a.ts", 1000);
    coalescer.takeDue(1200);

    expect(coalescer.isActivelyChanging(1200)).toBe(true);
    expect(coalescer.isActivelyChanging(3999)).toBe(true);
    expect(coalescer.isActivelyChanging(4000)).toBe(false);
  });

  it("is not actively changing before anything has happened", () => {
    expect(new ChangeCoalescer(TIMING).isActivelyChanging(0)).toBe(false);
    expect(new ChangeCoalescer(TIMING).dueAtMs()).toBeNull();
    expect(new ChangeCoalescer(TIMING).take()).toBeNull();
  });

  it("carries the platform's 'something changed, no idea what' through to the batch", () => {
    const coalescer = new ChangeCoalescer(TIMING);
    coalescer.record("a.ts", 0);
    coalescer.record(null, 10);

    const batch = coalescer.takeDue(200);
    expect(batch?.unknownChanges).toBe(true);
    expect(batch?.paths).toEqual(["a.ts"]);
  });

  it("defaults to a window a person would call 'a few seconds'", () => {
    expect(DEFAULT_WATCH_TIMING.activelyChangingMs).toBeGreaterThanOrEqual(2000);
    expect(DEFAULT_WATCH_TIMING.activelyChangingMs).toBeLessThanOrEqual(10_000);
    expect(DEFAULT_WATCH_TIMING.debounceMs).toBeLessThan(DEFAULT_WATCH_TIMING.maxDebounceMs);
  });
});

/** A watch source a test drives by hand, standing in for the platform's event stream. */
function controllableSubscribe(): {
  subscribe: WatchSubscribe;
  emit: (relativePath: string | null) => void;
  fail: (error: unknown) => void;
  closed: () => boolean;
} {
  const handlers: {
    onChange: (relativePath: string | null) => void;
    onError: (error: unknown) => void;
  } = { onChange: () => {}, onError: () => {} };
  let closed = false;

  return {
    subscribe: (given) => {
      handlers.onChange = given.onChange;
      handlers.onError = given.onError;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    emit: (relativePath) => {
      handlers.onChange(relativePath);
    },
    fail: (error) => {
      handlers.onError(error);
    },
    closed: () => closed,
  };
}

describe("createTreeWatcher", () => {
  it("ignores build noise entirely, including for activelyChanging", () => {
    const source = controllableSubscribe();
    const batches: ChangeBatch[] = [];
    let clock = 0;

    const watcher = createTreeWatcher({
      root: "/unused",
      timing: TIMING,
      now: () => clock,
      subscribe: source.subscribe,
      onBatch: (batch) => batches.push(batch),
    });

    source.emit("node_modules/left-pad/index.js");
    source.emit(".git/index");
    source.emit("src/.DS_Store");
    source.emit("src/.tmp.abc123.t3sync-tmp");

    // A dependency install is not the person typing, and a sync that reported it as such
    // would show "actively changing" through every build.
    expect(watcher.activelyChanging).toBe(false);
    watcher.flush();
    expect(batches).toEqual([]);

    clock = 10;
    source.emit("src/app.ts");
    expect(watcher.activelyChanging).toBe(true);
    watcher.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.paths).toEqual(["src/app.ts"]);

    watcher.close();
    expect(source.closed()).toBe(true);
  });

  it("surfaces a watch error instead of going quietly deaf", () => {
    const source = controllableSubscribe();
    const errors: unknown[] = [];
    const watcher = createTreeWatcher({
      root: "/unused",
      subscribe: source.subscribe,
      onBatch: () => {},
      onError: (error) => errors.push(error),
    });

    source.fail(new Error("watch limit reached"));

    expect(errors).toHaveLength(1);
    watcher.close();
  });

  it("drops events that arrive after close", () => {
    const source = controllableSubscribe();
    const batches: ChangeBatch[] = [];
    const watcher = createTreeWatcher({
      root: "/unused",
      timing: TIMING,
      subscribe: source.subscribe,
      onBatch: (batch) => batches.push(batch),
    });

    watcher.close();
    source.emit("src/app.ts");
    watcher.flush();

    expect(batches).toEqual([]);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// The only test here that needs a real filesystem. Recursive `fs.watch` is supported on
// macOS and Windows; elsewhere Node's support has varied by version, and a flaky test is
// worse than an honestly skipped one.
const supportsRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

describe.skipIf(!supportsRecursiveWatch)("createTreeWatcher over a real directory", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sees real writes, groups them, and stays deaf to build output", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-cloud-sync-watch-")));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, "src"));

    const batches: ChangeBatch[] = [];
    const watcher = createTreeWatcher({
      root,
      timing: { debounceMs: 400, maxDebounceMs: 5000, activelyChangingMs: 3000 },
      onBatch: (batch) => batches.push(batch),
    });

    try {
      // A recursive watch does not deliver from the instant `fs.watch` returns — on macOS
      // it is an FSEvents stream that takes a moment to start — so writes that raced the
      // subscription would make this test flaky rather than wrong. Warm up until the
      // watcher has demonstrably seen something, then measure.
      const warmUpDeadline = Date.now() + 10_000;
      while (!watcher.activelyChanging && Date.now() < warmUpDeadline) {
        fs.writeFileSync(path.join(root, "warm-up.txt"), String(Date.now()));
        await sleep(50);
      }
      expect(watcher.activelyChanging).toBe(true);
      watcher.flush();
      batches.length = 0;

      for (let index = 0; index < 5; index += 1) {
        fs.writeFileSync(
          path.join(root, "src", `file-${index}.ts`),
          `export const x = ${index};\n`,
        );
      }
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", "noise.js"), "noise");

      const deadline = Date.now() + 10_000;
      while (batches.length === 0 && Date.now() < deadline) {
        await sleep(25);
      }
      // Everything above happened inside one debounce window, so five files must not have
      // produced five passes. The exact grouping is the platform's business; the pure
      // ChangeCoalescer tests are where the rule itself is pinned down.
      await sleep(600);

      const paths = batches.flatMap((batch) => batch.paths);
      expect(batches.length).toBeLessThanOrEqual(2);
      expect(paths.filter((entry) => entry.startsWith("src/file-")).length).toBeGreaterThan(0);
      expect(paths.some((entry) => entry.startsWith("node_modules"))).toBe(false);
    } finally {
      watcher.close();
    }
  });
});
