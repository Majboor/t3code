import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CloudSyncConflict,
  CloudSyncConflictId,
  CloudSyncConflictListInput,
  CloudSyncConflictResolveInput,
  CloudSyncFile,
  CloudSyncHash,
  CloudSyncMode,
  CloudSyncStartInput,
  CloudSyncStatus,
  ProjectCloudSync,
  ProjectId,
  TenantId,
  WorkspaceId,
  WS_METHODS,
} from "./index.ts";

const decodeSync = Schema.decodeUnknownSync(ProjectCloudSync);
const decodeFile = Schema.decodeUnknownSync(CloudSyncFile);
const decodeConflict = Schema.decodeUnknownSync(CloudSyncConflict);
const decodeStart = Schema.decodeUnknownSync(CloudSyncStartInput);
const decodeConflictList = Schema.decodeUnknownSync(CloudSyncConflictListInput);
const decodeResolve = Schema.decodeUnknownSync(CloudSyncConflictResolveInput);

const tenantId = TenantId.make("tenant-acme");
const workspaceId = WorkspaceId.make("workspace-platform");
const projectId = ProjectId.make("project-atlas");
const scope = { tenantId, workspaceId, projectId };

const baseSync = {
  ...scope,
  mode: "mirror",
  status: "transferring",
  lastAgreedAt: null,
  lastError: null,
  filesTotal: 120,
  filesDone: 40,
  bytesTotal: 8_400_000,
  bytesDone: 2_100_000,
  activelyChanging: false,
  conflictCount: 0,
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T09:04:00.000Z",
};

const baseFile = {
  projectId,
  path: "src/index.ts",
  hash: CloudSyncHash.make("b1946ac92492d2347c6235b4d2611184"),
  sizeBytes: 2048,
  updatedAt: "2026-08-16T09:00:00.000Z",
  deletedAt: null,
};

describe("cloud sync contracts", () => {
  it("names exactly the two modes, since each decides which copy is canonical", () => {
    expect(Schema.decodeUnknownSync(CloudSyncMode)("handoff")).toBe("handoff");
    expect(Schema.decodeUnknownSync(CloudSyncMode)("mirror")).toBe("mirror");
    // "backup" is the mode people assume they are getting. It is not offered,
    // because a mirror propagates deletes and a backup must not.
    expect(() => Schema.decodeUnknownSync(CloudSyncMode)("backup")).toThrow();
    expect(() => Schema.decodeUnknownSync(CloudSyncMode)("one-way")).toThrow();
  });

  it("keeps scanning and transferring apart, and paused as a state of its own", () => {
    for (const status of ["idle", "scanning", "transferring", "paused", "error"]) {
      expect(Schema.decodeUnknownSync(CloudSyncStatus)(status)).toBe(status);
    }
    expect(() => Schema.decodeUnknownSync(CloudSyncStatus)("syncing")).toThrow();
    expect(() => Schema.decodeUnknownSync(CloudSyncStatus)("done")).toThrow();
  });

  it("lets a pass be less far along than the one before it", () => {
    // The per-pass counters are allowed to go backwards between passes: a
    // second pass over a mostly-unchanged tree has a smaller total than the
    // first. Nothing in the schema may treat that as invalid, or the progress
    // bar can only ever be right once.
    const first = decodeSync({ ...baseSync, filesTotal: 900, filesDone: 900 });
    const second = decodeSync({ ...baseSync, filesTotal: 3, filesDone: 1 });

    expect(first.filesDone).toBe(900);
    expect(second.filesTotal).toBe(3);
  });

  it("refuses negative progress, which could only come from a bad decrement", () => {
    expect(() => decodeSync({ ...baseSync, filesDone: -1 })).toThrow();
    expect(() => decodeSync({ ...baseSync, bytesDone: -1 })).toThrow();
    expect(() => decodeSync({ ...baseSync, conflictCount: -1 })).toThrow();
  });

  it("carries an error message only alongside the state that explains it", () => {
    const failed = decodeSync({
      ...baseSync,
      status: "error",
      lastError: "connection reset while uploading src/index.ts",
    });
    expect(failed.status).toBe("error");
    expect(failed.lastError).toContain("connection reset");

    // And a healthy sync says so with no stale message left behind.
    expect(decodeSync({ ...baseSync, status: "idle" }).lastError).toBeNull();
  });

  it("separates a sync that has never agreed from one that has", () => {
    expect(decodeSync(baseSync).lastAgreedAt).toBeNull();
    expect(decodeSync({ ...baseSync, lastAgreedAt: "2026-08-16T09:03:00.000Z" }).lastAgreedAt).toBe(
      "2026-08-16T09:03:00.000Z",
    );
  });

  it("distinguishes an agreed deletion from a path never seen", () => {
    const agreed = decodeFile(baseFile);
    expect(agreed.deletedAt).toBeNull();

    // A tombstone keeps its hash. "We agreed this is gone, and here is what it
    // was" is recoverable; "we agreed this is gone" alone is not.
    const tombstone = decodeFile({ ...baseFile, deletedAt: "2026-08-16T10:00:00.000Z" });
    expect(tombstone.deletedAt).toBe("2026-08-16T10:00:00.000Z");
    expect(tombstone.hash).toBe(baseFile.hash);

    // The third state — never seen — is the absence of the record entirely, so
    // there is no way to spell it here. A nulled hash must not become a
    // sideways route to it.
    expect(() => decodeFile({ ...baseFile, hash: null })).toThrow();
    expect(() => decodeFile({ ...baseFile, hash: "" })).toThrow();
  });

  it("does not rewrite a path that legitimately ends in a space", () => {
    // Trimming would sync the file to a different name than it has on disk.
    const odd = decodeFile({ ...baseFile, path: "notes/draft .md" });
    expect(odd.path).toBe("notes/draft .md");

    const trailing = decodeFile({ ...baseFile, path: "notes/draft.md " });
    expect(trailing.path).toBe("notes/draft.md ");

    expect(() => decodeFile({ ...baseFile, path: "" })).toThrow();
  });

  it("keeps both versions of a conflicted file at two different paths", () => {
    const conflict = decodeConflict({
      id: CloudSyncConflictId.make("conflict-1"),
      projectId,
      path: "src/index.ts",
      conflictedCopyPath: "src/index (conflicted copy 2026-08-16).ts",
      detectedAt: "2026-08-16T10:00:00.000Z",
      resolvedAt: null,
    });

    expect(conflict.path).not.toBe(conflict.conflictedCopyPath);
    expect(conflict.resolvedAt).toBeNull();
  });

  it("offers no way to resolve a conflict by choosing a side", () => {
    const parsed = decodeResolve({
      ...scope,
      conflictId: CloudSyncConflictId.make("conflict-1"),
      keep: "remote",
    });

    // A `keep` that reached the server would be a delete of the losing copy.
    expect("keep" in parsed).toBe(false);
  });

  it("makes the mode an explicit answer with no default", () => {
    expect(decodeStart({ ...scope, mode: "handoff" }).mode).toBe("handoff");
    expect(() => decodeStart(scope)).toThrow();
  });

  it("bounds the conflict listing and pages it by cursor, not offset", () => {
    const paged = decodeConflictList({
      ...scope,
      afterId: CloudSyncConflictId.make("conflict-40"),
      limit: 50,
    });
    expect(paged.afterId).toBe("conflict-40");
    expect(paged.limit).toBe(50);

    // Unbounded is not on offer: conflicted copies pile up and never expire.
    expect(() => decodeConflictList({ ...scope, limit: 5000 })).toThrow();
    expect(() => decodeConflictList({ ...scope, limit: 0 })).toThrow();

    // Open-only is the default, so the badge and the list agree by default.
    expect("includeResolved" in decodeConflictList(scope)).toBe(false);
  });

  it("exposes the six cloud sync methods under the spec's names", () => {
    expect(WS_METHODS.cloudSyncStatusGet).toBe("cloudSync.status.get");
    expect(WS_METHODS.cloudSyncStart).toBe("cloudSync.start");
    expect(WS_METHODS.cloudSyncPause).toBe("cloudSync.pause");
    expect(WS_METHODS.cloudSyncStop).toBe("cloudSync.stop");
    expect(WS_METHODS.cloudSyncConflictsList).toBe("cloudSync.conflicts.list");
    expect(WS_METHODS.cloudSyncConflictsResolve).toBe("cloudSync.conflicts.resolve");
  });
});
