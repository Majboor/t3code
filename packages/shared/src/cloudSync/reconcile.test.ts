import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FilePresence, FileState, PathAction } from "./reconcile.ts";
import {
  conflictedCopyPath,
  isConflictedCopyPath,
  PATH_ACTION_KINDS,
  reconcilePath,
  reconcileTree,
} from "./reconcile.ts";

const PATH = "src/app.ts";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const TODAY = "2026-08-19";

const A: FilePresence = { hash: "hash-a", sizeBytes: 10 };
const B: FilePresence = { hash: "hash-b", sizeBytes: 20 };
const C: FilePresence = { hash: "hash-c", sizeBytes: 30 };
/** An empty file still has a hash, and `sizeBytes: 0` must never read as "absent". */
const EMPTY: FilePresence = { hash: "hash-of-nothing", sizeBytes: 0 };
const GONE = { deleted: true } as const;

function act(local: FileState, remote: FileState, base: FileState): PathAction {
  return reconcilePath({ path: PATH, local, remote, base, now: NOW });
}

describe("reconcilePath — the spec's decision table", () => {
  it("same | same → nothing to do", () => {
    expect(act(A, A, A)).toEqual({ kind: "nothing", path: PATH });
  });

  it("changed | same → upload local", () => {
    expect(act(B, A, A)).toEqual({ kind: "upload", path: PATH, local: B });
  });

  it("same | changed → download remote", () => {
    expect(act(A, B, A)).toEqual({ kind: "download", path: PATH, remote: B });
  });

  it("changed | changed to the same content → advance the base, not a conflict", () => {
    expect(act(B, B, A)).toEqual({
      kind: "advanceBase",
      path: PATH,
      agreed: { hash: B.hash, sizeBytes: B.sizeBytes },
    });
  });

  it("changed | changed to different content → conflict", () => {
    expect(act(B, C, A)).toEqual({
      kind: "conflict",
      path: PATH,
      conflictedCopyPath: `src/app (conflicted copy ${TODAY}).ts`,
      local: B,
      remote: C,
    });
  });

  it("deleted | same → delete remote, keep the local absence", () => {
    expect(act(null, A, A)).toEqual({ kind: "deleteRemote", path: PATH });
  });

  it("same | deleted → keep local, restore remote from it", () => {
    expect(act(A, null, A)).toEqual({ kind: "restoreRemoteFromLocal", path: PATH, local: A });
  });

  it("deleted | changed → keep remote, restore local from it", () => {
    expect(act(null, B, A)).toEqual({ kind: "restoreLocalFromRemote", path: PATH, remote: B });
  });

  it("changed | deleted → keep local, restore remote from it", () => {
    expect(act(B, null, A)).toEqual({ kind: "restoreRemoteFromLocal", path: PATH, local: B });
  });

  it("absent, no base | present → download", () => {
    expect(act(null, A, null)).toEqual({ kind: "download", path: PATH, remote: A });
  });

  it("present, no base | absent → upload", () => {
    expect(act(A, null, null)).toEqual({ kind: "upload", path: PATH, local: A });
  });
});

describe("reconcilePath — the delete-vs-edit asymmetry, stated twice", () => {
  it("an edit on the remote survives a local delete", () => {
    const action = act(null, B, A);
    expect(action.kind).toBe("restoreLocalFromRemote");
  });

  it("an edit on the local side survives a remote delete", () => {
    const action = act(B, null, A);
    expect(action.kind).toBe("restoreRemoteFromLocal");
  });

  it("an unedited local copy still comes back to the remote when the remote drops it", () => {
    // Rule 3 with nothing to lose: the remote deleted an agreed file, the local copy is
    // the only one left, and rule 1 forbids removing it to match.
    expect(act(A, null, A)).toEqual({ kind: "restoreRemoteFromLocal", path: PATH, local: A });
  });

  it("a remote delete of a file the server never agreed on is an upload, not a removal", () => {
    // Rule 4: whatever the server's index says, a path with no base was never agreed.
    expect(act(A, GONE, null)).toEqual({ kind: "upload", path: PATH, local: A });
  });

  it("only ever deletes on the remote, and only when the local side made no edit", () => {
    expect(act(GONE, A, A).kind).toBe("deleteRemote");
    expect(act(GONE, B, A).kind).toBe("restoreLocalFromRemote");
    expect(act(GONE, A, null).kind).toBe("download");
  });
});

describe("reconcilePath — absences, tombstones and paths only the base remembers", () => {
  it("a path present in base but absent from both sides now just advances the base", () => {
    expect(act(null, null, A)).toEqual({
      kind: "advanceBase",
      path: PATH,
      agreed: { deleted: true },
    });
  });

  it("treats an explicit tombstone exactly like an unseen path", () => {
    for (const base of [A, null, GONE] as const) {
      expect(act(GONE, GONE, base)).toEqual(act(null, null, base));
      expect(act(GONE, A, base)).toEqual(act(null, A, base));
      expect(act(A, GONE, base)).toEqual(act(A, null, base));
    }
  });

  it("a base tombstone means no agreement, so nothing can be deleted against it", () => {
    // Both sides agreed it was gone; a file that reappears on one side is new, not edited.
    expect(act(null, A, GONE)).toEqual({ kind: "download", path: PATH, remote: A });
    expect(act(A, null, GONE)).toEqual({ kind: "upload", path: PATH, local: A });
    expect(act(null, null, GONE)).toEqual({ kind: "nothing", path: PATH });
  });

  it("does nothing for a path no side has ever seen", () => {
    expect(act(null, null, null)).toEqual({ kind: "nothing", path: PATH });
  });

  it("two sides that independently created the same content agree rather than conflict", () => {
    expect(act(A, A, null)).toEqual({
      kind: "advanceBase",
      path: PATH,
      agreed: { hash: A.hash, sizeBytes: A.sizeBytes },
    });
  });

  it("two sides that independently created different content conflict", () => {
    expect(act(A, B, null).kind).toBe("conflict");
  });
});

describe("reconcilePath — an empty file is a file", () => {
  it("uploads an empty file rather than reading zero bytes as an absence", () => {
    expect(act(EMPTY, null, null)).toEqual({ kind: "upload", path: PATH, local: EMPTY });
  });

  it("restores an emptied local file to the remote instead of deleting it there", () => {
    expect(act(EMPTY, null, A)).toEqual({
      kind: "restoreRemoteFromLocal",
      path: PATH,
      local: EMPTY,
    });
  });

  it("treats emptying a file as an edit, so it conflicts with a remote edit", () => {
    expect(act(EMPTY, B, A).kind).toBe("conflict");
  });

  it("sees no work to do when both sides hold the same empty file", () => {
    expect(act(EMPTY, EMPTY, EMPTY)).toEqual({ kind: "nothing", path: PATH });
  });

  it("counts zero bytes without dropping the path from the plan", () => {
    const { actions, summary } = reconcileTree({
      local: new Map([[PATH, EMPTY]]),
      remote: new Map(),
      base: new Map(),
      now: NOW,
    });
    expect(actions).toHaveLength(1);
    expect(summary.counts.upload).toBe(1);
    expect(summary.bytesToUpload).toBe(0);
  });
});

describe("reconcilePath — hashes decide, never timestamps or sizes", () => {
  it("ignores a size that disagrees with the hash", () => {
    const sameHashOtherSize: FilePresence = { hash: A.hash, sizeBytes: A.sizeBytes + 999 };
    expect(act(sameHashOtherSize, A, A)).toEqual({ kind: "nothing", path: PATH });
  });

  it("does not accept a modification time anywhere in its input", () => {
    reconcilePath({
      path: PATH,
      // @ts-expect-error mtimes are a pre-filter for the caller, never a tiebreak here.
      local: { hash: A.hash, sizeBytes: A.sizeBytes, mtimeMs: 1 },
      remote: A,
      base: A,
    });
  });

  it("names a conflicted copy from the clock but never decides with it", () => {
    const earlier = reconcilePath({
      path: PATH,
      local: B,
      remote: C,
      base: A,
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    const later = reconcilePath({ path: PATH, local: B, remote: C, base: A, now: NOW });
    expect(earlier.kind).toBe("conflict");
    expect(later.kind).toBe("conflict");
    expect(earlier).not.toEqual(later);
  });
});

describe("conflictedCopyPath", () => {
  it("keeps the extension last so the copy opens the way the original did", () => {
    expect(conflictedCopyPath("src/app.ts", NOW)).toBe(`src/app (conflicted copy ${TODAY}).ts`);
  });

  it("handles a name with no extension", () => {
    expect(conflictedCopyPath("README", NOW)).toBe(`README (conflicted copy ${TODAY})`);
  });

  it("splits multiple dots at the last one", () => {
    expect(conflictedCopyPath("archive.tar.gz", NOW)).toBe(
      `archive.tar (conflicted copy ${TODAY}).gz`,
    );
  });

  it("treats a dotfile's leading dot as part of the name", () => {
    expect(conflictedCopyPath(".env", NOW)).toBe(`.env (conflicted copy ${TODAY})`);
    expect(conflictedCopyPath(".env.local", NOW)).toBe(`.env (conflicted copy ${TODAY}).local`);
  });

  it("does not nest a conflicted copy inside a conflicted copy", () => {
    const once = conflictedCopyPath("src/app.ts", NOW);
    const twice = conflictedCopyPath(once, new Date("2026-09-01T00:00:00.000Z"));
    expect(twice).toBe("src/app (conflicted copy 2026-09-01).ts");
    expect(twice).not.toContain("conflicted copy 2026-08-19");
    expect(conflictedCopyPath(twice, NOW)).toBe(once);
  });

  it("recognises a marker written with a different date format", () => {
    const oddlyDated = "src/app (conflicted copy 2026-08-19T12-00-00Z).ts";
    expect(isConflictedCopyPath(oddlyDated)).toBe(true);
    expect(conflictedCopyPath(oddlyDated, NOW)).toBe(`src/app (conflicted copy ${TODAY}).ts`);
  });

  it("keeps the copy in the same directory as the original", () => {
    expect(conflictedCopyPath("a/b/c/notes", NOW)).toBe(`a/b/c/notes (conflicted copy ${TODAY})`);
  });

  it("leaves parentheses that are not a marker alone", () => {
    expect(isConflictedCopyPath("src/app (1).ts")).toBe(false);
    expect(conflictedCopyPath("src/app (1).ts", NOW)).toBe(
      `src/app (1) (conflicted copy ${TODAY}).ts`,
    );
  });

  it("agrees with isConflictedCopyPath about everything it produces", () => {
    for (const path of ["src/app.ts", "README", "archive.tar.gz", ".env", "a/b/notes.md"]) {
      expect(isConflictedCopyPath(path)).toBe(false);
      expect(isConflictedCopyPath(conflictedCopyPath(path, NOW))).toBe(true);
    }
  });
});

describe("reconcileTree", () => {
  const local = new Map<string, FileState>([
    ["both-same.ts", A],
    ["local-edit.ts", B],
    ["conflicted.ts", B],
    ["local-only.ts", A],
    ["locally-deleted.ts", null],
  ]);
  const remote = new Map<string, FileState>([
    ["both-same.ts", A],
    ["local-edit.ts", A],
    ["conflicted.ts", C],
    ["remote-only.ts", B],
    ["locally-deleted.ts", A],
  ]);
  const base = new Map<string, FileState>([
    ["both-same.ts", A],
    ["local-edit.ts", A],
    ["conflicted.ts", A],
    ["locally-deleted.ts", A],
    ["forgotten.ts", A],
  ]);

  const result = reconcileTree({ local, remote, base, now: NOW });

  it("covers the union of all three sides, sorted by path", () => {
    expect(result.actions.map((action) => action.path)).toEqual([
      "both-same.ts",
      "conflicted.ts",
      "forgotten.ts",
      "local-edit.ts",
      "local-only.ts",
      "locally-deleted.ts",
      "remote-only.ts",
    ]);
  });

  it("decides each path the same way reconcilePath does", () => {
    expect(result.actions.map((action) => action.kind)).toEqual([
      "nothing",
      "conflict",
      "advanceBase",
      "upload",
      "upload",
      "deleteRemote",
      "download",
    ]);
  });

  it("summarises counts, bytes and conflicts in one pass", () => {
    expect(result.summary.paths).toBe(7);
    expect(result.summary.counts).toEqual({
      nothing: 1,
      upload: 2,
      download: 1,
      deleteRemote: 1,
      restoreRemoteFromLocal: 0,
      restoreLocalFromRemote: 0,
      advanceBase: 1,
      conflict: 1,
    });
    // Two uploads: the local edit and the local-only file.
    expect(result.summary.bytesToUpload).toBe(B.sizeBytes + A.sizeBytes);
    // The remote-only download plus the remote half of the conflict, which still has to
    // come down to take the path.
    expect(result.summary.bytesToDownload).toBe(B.sizeBytes + C.sizeBytes);
    expect(result.summary.conflicts).toBe(1);
    expect(result.summary.conflicts).toBe(result.summary.counts.conflict);
  });

  it("counts a restore in both directions as bytes on the wire", () => {
    const restores = reconcileTree({
      local: new Map<string, FileState>([
        ["up.ts", A],
        ["down.ts", null],
      ]),
      remote: new Map<string, FileState>([
        ["up.ts", null],
        ["down.ts", C],
      ]),
      base: new Map<string, FileState>([
        ["up.ts", A],
        ["down.ts", B],
      ]),
      now: NOW,
    });
    expect(restores.summary.counts.restoreRemoteFromLocal).toBe(1);
    expect(restores.summary.counts.restoreLocalFromRemote).toBe(1);
    expect(restores.summary.bytesToUpload).toBe(A.sizeBytes);
    expect(restores.summary.bytesToDownload).toBe(C.sizeBytes);
  });

  it("dates every conflict in one pass identically", () => {
    const conflicts = reconcileTree({
      local: new Map<string, FileState>([
        ["one.ts", B],
        ["two.ts", B],
      ]),
      remote: new Map<string, FileState>([
        ["one.ts", C],
        ["two.ts", C],
      ]),
      base: new Map<string, FileState>([
        ["one.ts", A],
        ["two.ts", A],
      ]),
      now: NOW,
    });
    const copies = conflicts.actions.flatMap((action) =>
      action.kind === "conflict" ? [action.conflictedCopyPath] : [],
    );
    expect(copies).toEqual([
      `one (conflicted copy ${TODAY}).ts`,
      `two (conflicted copy ${TODAY}).ts`,
    ]);
  });

  it("is total on empty input", () => {
    const empty = reconcileTree({ local: new Map(), remote: new Map(), base: new Map() });
    expect(empty.actions).toEqual([]);
    expect(empty.summary.paths).toBe(0);
    expect(empty.summary.bytesToUpload).toBe(0);
    expect(empty.summary.bytesToDownload).toBe(0);
    expect(empty.summary.conflicts).toBe(0);
    for (const kind of PATH_ACTION_KINDS) {
      expect(empty.summary.counts[kind]).toBe(0);
    }
  });
});

const STATES: readonly (readonly [string, FileState])[] = [
  ["absent", null],
  ["tombstone", GONE],
  ["empty", EMPTY],
  ["a", A],
  ["b", B],
];

function everyCombination(): readonly {
  readonly label: string;
  readonly local: FileState;
  readonly remote: FileState;
  readonly base: FileState;
}[] {
  const cases = [];
  for (const [localLabel, local] of STATES) {
    for (const [remoteLabel, remote] of STATES) {
      for (const [baseLabel, base] of STATES) {
        cases.push({
          label: `local=${localLabel} remote=${remoteLabel} base=${baseLabel}`,
          local,
          remote,
          base,
        });
      }
    }
  }
  return cases;
}

function content(state: FileState): FilePresence | null {
  if (state === null) return null;
  return "hash" in state ? state : null;
}

describe("no sync ever deletes local content", () => {
  const combinations = everyCombination();

  it("covers every combination of local, remote and base", () => {
    expect(combinations).toHaveLength(STATES.length ** 3);
  });

  it("has no action kind that could name a local removal", () => {
    expect(PATH_ACTION_KINDS.toSorted()).toEqual([
      "advanceBase",
      "conflict",
      "deleteRemote",
      "download",
      "nothing",
      "restoreLocalFromRemote",
      "restoreRemoteFromLocal",
      "upload",
    ]);
    for (const kind of PATH_ACTION_KINDS) {
      expect(/local/i.test(kind) && /delet|remov|unlink|prune|clear/i.test(kind)).toBe(false);
    }
  });

  it("never emits a kind outside the declared set", () => {
    for (const { label, ...input } of combinations) {
      const action = reconcilePath({ path: PATH, ...input, now: NOW });
      expect(PATH_ACTION_KINDS, label).toContain(action.kind);
    }
  });

  it("preserves local content that differs from the base, in every combination", () => {
    // "Work" is local content that is not the base content: the edits made since the two
    // sides last agreed. Every case that has any must end somewhere it still exists.
    const preserving = new Set(["upload", "restoreRemoteFromLocal", "conflict", "advanceBase"]);

    for (const { label, ...input } of combinations) {
      const local = content(input.local);
      const base = content(input.base);
      if (local === null || (base !== null && base.hash === local.hash)) {
        continue;
      }

      const action = reconcilePath({ path: PATH, ...input, now: NOW });
      expect(preserving.has(action.kind), `${label} → ${action.kind}`).toBe(true);
      if (action.kind === "conflict") {
        // The remote takes the path, so the local bytes only survive if they land beside it.
        expect(action.conflictedCopyPath, label).not.toBe(PATH);
        expect(action.local.hash, label).toBe(local.hash);
      }
    }
  });

  it("only overwrites the local path when the local copy holds no unsaved work", () => {
    for (const { label, ...input } of combinations) {
      const action = reconcilePath({ path: PATH, ...input, now: NOW });
      if (action.kind !== "download" && action.kind !== "restoreLocalFromRemote") {
        continue;
      }
      const local = content(input.local);
      const base = content(input.base);
      expect(local === null || (base !== null && base.hash === local.hash), label).toBe(true);
    }
  });

  it("only deletes on the remote when the local side is absent and the remote is unchanged", () => {
    for (const { label, ...input } of combinations) {
      const action = reconcilePath({ path: PATH, ...input, now: NOW });
      if (action.kind !== "deleteRemote") {
        continue;
      }
      const remote = content(input.remote);
      const base = content(input.base);
      expect(content(input.local), label).toBeNull();
      expect(remote, label).not.toBeNull();
      expect(base?.hash, label).toBe(remote?.hash);
    }
  });

  it("says nothing to do only when the three sides genuinely agree", () => {
    for (const { label, ...input } of combinations) {
      const action = reconcilePath({ path: PATH, ...input, now: NOW });
      if (action.kind !== "nothing") {
        continue;
      }
      const local = content(input.local);
      const remote = content(input.remote);
      const base = content(input.base);
      const allAbsent = local === null && remote === null && base === null;
      const allAgree =
        local !== null &&
        remote !== null &&
        base !== null &&
        local.hash === remote.hash &&
        remote.hash === base.hash;
      expect(allAbsent || allAgree, label).toBe(true);
    }
  });

  it("orders no local removal anywhere in its own source", () => {
    // Rule 1 is structural, not a convention, so it is checked against the text as well as
    // the behaviour: a future kind called `deleteLocal` fails here before it ships.
    const source = readFileSync(new URL("./reconcile.ts", import.meta.url), "utf8");
    for (const forbidden of [/deleteLocal/i, /removeLocal/i, /unlinkLocal/i, /localDelete/i]) {
      expect(forbidden.test(source), `${forbidden.source} appears in reconcile.ts`).toBe(false);
    }
  });

  it("never plans a local write and a local deletion for the same path in a tree", () => {
    const { actions } = reconcileTree({
      local: new Map(combinations.map(({ label, local }) => [label, local])),
      remote: new Map(combinations.map(({ label, remote }) => [label, remote])),
      base: new Map(combinations.map(({ label, base }) => [label, base])),
      now: NOW,
    });
    expect(actions).toHaveLength(combinations.length);
    for (const action of actions) {
      expect(action.kind).not.toBe("deleteLocal");
      expect(Object.keys(action)).not.toContain("deleteLocal");
    }
  });
});
