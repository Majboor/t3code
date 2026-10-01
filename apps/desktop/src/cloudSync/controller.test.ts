import { describe, expect, it } from "vitest";

import {
  agreedFilesAfterPlan,
  createPassController,
  localActionsForPlan,
  type PassReport,
} from "./controller.ts";
import type { CloudSyncPassPlan, CloudSyncPassResult } from "./passPlan.ts";
import type { CloudSyncTransport } from "./transport.ts";
import type { ScanResult, ScannedFile } from "./scan.ts";
import type { ApplyOptions } from "./apply.ts";
import type { PathAction } from "@t3tools/shared/cloudSync/reconcile";
import { CloudSyncHash, CloudSyncPath, type CloudSyncEntry } from "@t3tools/contracts";

/**
 * `path` and `hash` are branded in the contract, which is the point of them — a hash is a
 * filename a moment later. These fixtures brand short literals so the tests read as the
 * wire does without each one carrying a cast.
 */
/**
 * A promise with its own resolver. Written out rather than assigning into a `let` from
 * inside the executor, because TS's control flow does not follow that and would narrow the
 * handle to `null`.
 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const hashOf = (value: string) => CloudSyncHash.make(value.padEnd(64, "0"));
const pathOf = (value: string) => CloudSyncPath.make(value);
const entry = (path: string, hash: string, sizeBytes = 3): CloudSyncEntry => ({
  path: pathOf(path),
  hash: hashOf(hash),
  sizeBytes: sizeBytes as CloudSyncEntry["sizeBytes"],
});

const file = (hash: string, sizeBytes = 3): ScannedFile =>
  ({ hash: hashOf(hash), sizeBytes, mtimeMs: 1, ctimeMs: 1, inode: 1 }) as ScannedFile;

const scanOf = (
  files: Record<string, ScannedFile>,
  overrides: Partial<ScanResult> = {},
): ScanResult =>
  ({
    root: "/p",
    files: new Map(Object.entries(files)),
    complete: true,
    incompleteReasons: [],
    skipped: [],
    filesHashed: Object.keys(files).length,
    bytesHashed: 0,
    filesReused: 0,
    ...overrides,
  }) as ScanResult;

const planOf = (overrides: Partial<CloudSyncPassPlan> = {}): CloudSyncPassPlan =>
  ({
    outcome: "planned",
    mode: "mirror",
    upload: [],
    download: [],
    deleteRemote: [],
    conflicts: [],
    refused: [],
    sync: {},
    ...overrides,
  }) as CloudSyncPassPlan;

/** Records the order every call arrived in, which is what this controller is for. */
function makeTransport(planned: CloudSyncPassResult, overrides: Partial<CloudSyncTransport> = {}) {
  const calls: string[] = [];
  const transport = {
    missingBlobs: async (hashes: ReadonlyArray<string>) => {
      calls.push(`negotiate:${hashes.join(",")}`);
      return hashes;
    },
    blobReceived: async () => 0,
    uploadBlob: async (hash: string) => {
      calls.push(`upload:${hash}`);
    },
    sendChunk: async () => new Response(),
    finalizeBlob: async () => undefined,
    fetchBlob: async (hash: string) => {
      calls.push(`fetch:${hash}`);
      return new Uint8Array([1]);
    },
    requestPass: async () => {
      calls.push("pass");
      return planned;
    },
    commitPass: async (input: { readonly files: ReadonlyArray<{ readonly path: string }> }) => {
      calls.push(`commit:${input.files.map((entry) => entry.path).join(",")}`);
      return {};
    },
    ...overrides,
  } as unknown as CloudSyncTransport;
  return { transport, calls };
}

describe("localActionsForPlan", () => {
  // `upload` and `deleteRemote` are the transport's business and `apply.ts` answers
  // `noLocalChange` for them, so putting them through it is a loop that does nothing.
  it("produces only the actions that touch this disk", () => {
    const actions = localActionsForPlan(
      planOf({
        upload: [entry("mine.txt", "h1", 3)],
        deleteRemote: ["gone.txt"],
        download: [entry("theirs.txt", "h2", 3)],
      }) as CloudSyncPassPlan,
      scanOf({ "mine.txt": file("h1") }),
    );
    expect(actions.map((action) => `${action.kind}:${action.path}`)).toEqual([
      "download:theirs.txt",
    ]);
  });

  // One action and not two: the local file is moved aside first and the remote written
  // second, and `applyPathAction` is what guarantees that order.
  it("carries a conflict as one action with both sides on it", () => {
    const actions = localActionsForPlan(
      planOf({
        conflicts: [
          {
            path: "both.txt",
            conflictedCopyPath: "both (from this machine).txt",
            remote: entry("both.txt", "remote", 9),
          },
        ],
      }) as CloudSyncPassPlan,
      scanOf({ "both.txt": file("local", 4) }),
    );
    expect(actions).toEqual([
      {
        kind: "conflict",
        path: "both.txt",
        conflictedCopyPath: "both (from this machine).txt",
        local: { hash: hashOf("local"), sizeBytes: 4 },
        remote: { hash: hashOf("remote"), sizeBytes: 9 },
      },
    ]);
  });

  // Dropping to a plain download here would silently take the remote version over a local
  // file whose state we no longer know. The next pass re-scans and decides.
  it("leaves a conflict whose local side vanished for the next pass", () => {
    const actions = localActionsForPlan(
      planOf({
        conflicts: [
          {
            path: "gone.txt",
            conflictedCopyPath: "gone (from this machine).txt",
            remote: entry("gone.txt", "remote", 9),
          },
        ],
      }) as CloudSyncPassPlan,
      scanOf({}),
    );
    expect(actions).toEqual([]);
  });
});

describe("agreedFilesAfterPlan", () => {
  // Claiming agreement on a refused path advances the base past content the server does
  // not have, and the next pass reads that as "both sides had it and the laptop deleted it".
  it("never claims agreement on a path the server refused to carry", () => {
    const agreed = agreedFilesAfterPlan(
      planOf({ refused: [{ path: "huge.bin", reason: "too-large" }] }) as CloudSyncPassPlan,
      scanOf({ "ok.txt": file("h1"), "huge.bin": file("h2") }),
    );
    expect(agreed.map((entry) => entry.path)).toEqual(["ok.txt"]);
  });

  it("leaves out what this pass is deleting in the cloud", () => {
    const agreed = agreedFilesAfterPlan(
      planOf({ deleteRemote: ["stale.txt"] }) as CloudSyncPassPlan,
      scanOf({ "stale.txt": file("h1"), "kept.txt": file("h2") }),
    );
    expect(agreed.map((entry) => entry.path)).toEqual(["kept.txt"]);
  });

  // A download replaces local content, so the hash both sides agree on is the remote one
  // and not whatever the scan saw a moment earlier.
  it("agrees on the remote hash for a path it just downloaded", () => {
    const agreed = agreedFilesAfterPlan(
      planOf({ download: [entry("doc.md", "remote", 9)] }) as CloudSyncPassPlan,
      scanOf({ "doc.md": file("stale", 4) }),
    );
    expect(agreed).toEqual([entry("doc.md", "remote", 9)]);
  });
});

describe("createPassController", () => {
  const applied: PathAction[] = [];
  const apply = async (action: PathAction, _options: ApplyOptions) => {
    applied.push(action);
    return {};
  };

  // The base advances on commit, so content has to be in the cloud before it; a base ahead
  // of the bytes is a path the next pass thinks both sides agreed on while one has nothing.
  it("uploads before it commits, and commits last", async () => {
    const { transport, calls } = makeTransport(
      planOf({
        upload: [entry("mine.txt", "h1", 3)],
        download: [entry("theirs.txt", "h2", 3)],
      }) as CloudSyncPassPlan,
    );
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "mine.txt": file("h1") }),
      readLocalFile: async () => new Uint8Array([1, 2, 3]),
    });

    const result = await controller.runPass();

    expect(result.kind).toBe("completed");
    expect(calls).toEqual([
      "pass",
      `negotiate:${hashOf("h1")}`,
      `upload:${hashOf("h1")}`,
      "commit:mine.txt",
    ]);
    expect(calls.indexOf(`upload:${hashOf("h1")}`)).toBeLessThan(calls.indexOf("commit:mine.txt"));
  });

  // A refusal is a state and not an error: it means a person has to look, and the numbers
  // behind it have to survive the trip.
  it("reports a server refusal with its numbers instead of throwing", async () => {
    const { transport, calls } = makeTransport({
      outcome: "refused",
      reason: "implausible-deletion",
      message: "That scan would have removed most of this project.",
      deletions: 900,
      knownPaths: 1000,
      reportedPaths: 100,
      allowedDeletions: 100,
      sync: {},
    } as CloudSyncPassResult);
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "one.txt": file("h1") }),
    });

    const result = await controller.runPass();

    expect(result).toMatchObject({
      kind: "refused",
      reason: "implausible-deletion",
      deletions: 900,
      knownPaths: 1000,
      allowedDeletions: 100,
    });
    // Nothing was carried out and nothing was committed.
    expect(calls).toEqual(["pass"]);
  });

  // The laptop is the only side that knows its own walk was cut short, and a pass built on
  // a partial scan sees every unreported path as deleted. So it never leaves the machine.
  it("will not even ask when its own scan did not finish", async () => {
    const { transport, calls } = makeTransport(planOf() as CloudSyncPassPlan);
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () =>
        scanOf(
          { "one.txt": file("h1") },
          { complete: false, incompleteReasons: ["EACCES on /p/x"] },
        ),
    });

    const result = await controller.runPass();

    expect(result).toMatchObject({ kind: "notAttempted", reason: "incomplete-scan" });
    expect((result as Extract<PassReport, { kind: "notAttempted" }>).details).toEqual([
      "EACCES on /p/x",
    ]);
    expect(calls).toEqual([]);
  });

  it("declines a handoff, which has no base to advance", async () => {
    const { transport, calls } = makeTransport(planOf() as CloudSyncPassPlan);
    const controller = createPassController({
      root: "/p",
      mode: "handoff",
      transport,
      apply,
      scan: async () => scanOf({ "one.txt": file("h1") }),
    });

    expect(await controller.runPass()).toMatchObject({
      kind: "notAttempted",
      reason: "not-a-mirror",
    });
    expect(calls).toEqual([]);
  });

  // Two passes over one tree can interleave a download with a scan and commit a base for
  // content that was replaced underneath them, so a pass runs alone.
  it("runs one pass at a time and follows up once for everything that arrived during it", async () => {
    const gate = deferred();
    let passes = 0;
    const { transport } = makeTransport(planOf() as CloudSyncPassPlan, {
      requestPass: (async () => {
        passes += 1;
        if (passes === 1) await gate.promise;
        return planOf() as CloudSyncPassPlan;
      }) as CloudSyncTransport["requestPass"],
    });
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "one.txt": file("h1") }),
    });

    const first = controller.runPass();
    expect(controller.isRunning()).toBe(true);
    // Three changes while the first pass is in flight.
    const rejected = await Promise.all([
      controller.runPass(),
      controller.runPass(),
      controller.runPass(),
    ]);
    for (const result of rejected) {
      expect(result).toMatchObject({ kind: "notAttempted", reason: "already-running" });
    }

    gate.resolve();
    expect((await first).kind).toBe("completed");
    // One follow-up, not three: the next pass re-scans, so it covers all of them.
    expect(passes).toBe(2);
    expect(controller.isRunning()).toBe(false);
  });

  // Re-running after a refusal would spin against a condition only a person can clear.
  it("does not follow up a refusal, however much changed during it", async () => {
    const gate = deferred();
    let passes = 0;
    const refusal = {
      outcome: "refused",
      reason: "implausible-deletion",
      message: "no",
      deletions: 9,
      knownPaths: 10,
      reportedPaths: 1,
      allowedDeletions: 1,
      sync: {},
    } as CloudSyncPassResult;
    const { transport } = makeTransport(refusal, {
      requestPass: (async () => {
        passes += 1;
        if (passes === 1) await gate.promise;
        return refusal;
      }) as CloudSyncTransport["requestPass"],
    });
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "one.txt": file("h1") }),
    });

    const first = controller.runPass();
    await controller.runPass();
    gate.resolve();
    expect((await first).kind).toBe("refused");
    expect(passes).toBe(1);
  });

  // A pass that dies part-way leaves the base where it was, so the honest report is "did
  // not finish" and the next pass starts from the same place.
  it("reports a failed pass without committing anything", async () => {
    const { transport, calls } = makeTransport(
      planOf({ upload: [entry("mine.txt", "h1", 3)] }) as CloudSyncPassPlan,
      {
        uploadBlob: (async () => {
          throw new Error("the connection dropped");
        }) as CloudSyncTransport["uploadBlob"],
      },
    );
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "mine.txt": file("h1") }),
      readLocalFile: async () => new Uint8Array([1]),
    });

    expect(await controller.runPass()).toMatchObject({
      kind: "failed",
      message: "the connection dropped",
    });
    expect(calls.some((call) => call.startsWith("commit"))).toBe(false);
  });

  // The watcher already coalesces, so the controller only has to run a pass per settled
  // batch — this is what makes a local edit sync in about as long as it takes to hash it,
  // rather than waiting for a timer nothing had written yet.
  it("runs a pass per settled watcher batch", async () => {
    const { transport, calls } = makeTransport(planOf() as CloudSyncPassPlan);
    let emitBatch: (() => void) | undefined;
    const controller = createPassController({
      root: "/p",
      mode: "mirror",
      transport,
      apply,
      scan: async () => scanOf({ "one.txt": file("h1") }),
      watch: (watchOptions) => {
        emitBatch = () =>
          watchOptions.onBatch({
            paths: ["one.txt"],
            unknownChanges: false,
            firstEventAtMs: 0,
            lastEventAtMs: 1,
          });
        return { activelyChanging: false, flush: () => {}, close: () => {} };
      },
    });

    controller.start();
    expect(calls).toEqual([]);
    emitBatch?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((call) => call === "pass")).toHaveLength(1);
    controller.stop();
  });
});
