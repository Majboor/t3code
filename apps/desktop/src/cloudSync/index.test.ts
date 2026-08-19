import type { FileState } from "@t3tools/shared/cloudSync/reconcile";
import { describe, expect, it } from "vitest";

import { assessRemoteDeletions, planLocalPass } from "./index.ts";
import { hashBytes, type ScanResult, type ScanSkip } from "./scan.ts";

function presence(contents: string) {
  const bytes = Buffer.from(contents);
  return { hash: hashBytes(bytes), sizeBytes: bytes.byteLength };
}

function scanOf(input: {
  readonly files: Record<string, string>;
  readonly complete?: boolean;
  readonly skipped?: readonly ScanSkip[];
}): ScanResult {
  const files = new Map(
    Object.entries(input.files).map(([relativePath, contents]) => [
      relativePath,
      { ...presence(contents), mtimeMs: 0, ctimeMs: 0, inode: 0 },
    ]),
  );
  const complete = input.complete ?? true;
  return {
    root: "/project",
    files,
    complete,
    incompleteReasons: complete ? [] : ["Could not read src: EACCES"],
    skipped: input.skipped ?? [],
    filesHashed: files.size,
    bytesHashed: 0,
    filesReused: 0,
  };
}

function statesOf(entries: Record<string, string>): Map<string, FileState> {
  return new Map(Object.entries(entries).map(([path, contents]) => [path, presence(contents)]));
}

describe("planLocalPass", () => {
  it("plans an ordinary mirror pass", () => {
    const outcome = planLocalPass({
      mode: "mirror",
      scan: scanOf({ files: { "a.ts": "local edit", "b.ts": "same" } }),
      remote: statesOf({ "a.ts": "base", "b.ts": "same" }),
      base: statesOf({ "a.ts": "base", "b.ts": "same" }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.summary.counts.upload).toBe(1);
      expect(outcome.plan.summary.counts.deleteRemote).toBe(0);
    }
  });

  it("refuses an incomplete scan rather than reading it as deletions", () => {
    const outcome = planLocalPass({
      mode: "mirror",
      // The scan found one file and could not read the rest of the tree.
      scan: scanOf({ files: { "a.ts": "a" }, complete: false }),
      remote: statesOf({ "a.ts": "a", "b.ts": "b", "c.ts": "c" }),
      base: statesOf({ "a.ts": "a", "b.ts": "b", "c.ts": "c" }),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: { reason: "incomplete-scan" } });
    if (!outcome.ok) {
      expect(outcome.refusal.details).not.toEqual([]);
    }
  });

  it("refuses when a pass would delete an implausible share of the cloud copy", () => {
    const remote: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      remote[`src/file-${index}.ts`] = `contents ${index}`;
    }

    const outcome = planLocalPass({
      mode: "mirror",
      // A complete scan of a directory that is suddenly almost empty — a moved project, an
      // unmounted drive, a checkout of an empty branch. All three are recoverable; a cloud
      // copy deleted to match is not.
      scan: scanOf({ files: { "src/file-0.ts": "contents 0" } }),
      remote: statesOf(remote),
      base: statesOf(remote),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: { reason: "implausible-deletions" } });
    if (!outcome.ok) {
      expect(outcome.refusal.details.length).toBeGreaterThan(0);
      expect(outcome.refusal.message).toContain("199");
    }
  });

  it("lets an ordinary handful of deletions through", () => {
    const outcome = planLocalPass({
      mode: "mirror",
      scan: scanOf({ files: { "keep.ts": "keep" } }),
      remote: statesOf({ "keep.ts": "keep", "gone-a.ts": "a", "gone-b.ts": "b" }),
      base: statesOf({ "keep.ts": "keep", "gone-a.ts": "a", "gone-b.ts": "b" }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.summary.counts.deleteRemote).toBe(2);
    }
  });

  it("holds skipped paths out of the pass entirely, so an exclusion is never a delete", () => {
    const outcome = planLocalPass({
      mode: "mirror",
      scan: scanOf({
        files: { "app.ts": "app" },
        skipped: [
          { path: "vendor", reason: "ignored", isDirectory: true },
          { path: "huge.bin", reason: "tooLarge", isDirectory: false },
          { path: "deleted.ts", reason: "vanished", isDirectory: false },
        ],
      }),
      // All four were synced before the exclusion rules changed underneath them.
      remote: statesOf({
        "app.ts": "app",
        "vendor/lib.js": "lib",
        "huge.bin": "big",
        "deleted.ts": "gone",
      }),
      base: statesOf({
        "app.ts": "app",
        "vendor/lib.js": "lib",
        "huge.bin": "big",
        "deleted.ts": "gone",
      }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.excludedPaths).toEqual(["huge.bin", "vendor/lib.js"]);
      // The one path that really is gone is the only one that gets deleted.
      const deletions = outcome.plan.actions.filter((action) => action.kind === "deleteRemote");
      expect(deletions.map((action) => action.path)).toEqual(["deleted.ts"]);
    }
  });

  it("refuses to reconcile a handoff at all", () => {
    const outcome = planLocalPass({
      mode: "handoff",
      scan: scanOf({ files: {} }),
      remote: statesOf({ "a.ts": "a" }),
      base: statesOf({ "a.ts": "a" }),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: { reason: "not-a-mirror" } });
  });
});

describe("assessRemoteDeletions", () => {
  it("allows a small tree to lose most of itself, and a large one not to", () => {
    expect(assessRemoteDeletions({ deletions: 4, localFileCount: 1 })).toEqual({ plausible: true });
    expect(assessRemoteDeletions({ deletions: 10, localFileCount: 0 })).toEqual({
      plausible: true,
    });
    expect(assessRemoteDeletions({ deletions: 250, localFileCount: 750 })).toEqual({
      plausible: true,
    });
    expect(assessRemoteDeletions({ deletions: 400, localFileCount: 600 })).toMatchObject({
      plausible: false,
      allowed: 250,
    });
  });
});
