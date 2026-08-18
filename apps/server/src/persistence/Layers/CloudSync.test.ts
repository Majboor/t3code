import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { CloudSyncRepositoryLive } from "./CloudSync.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { CloudSyncRepository } from "../Services/CloudSync.ts";

const layer = it.layer(
  Layer.mergeAll(
    CloudSyncRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const scope = { tenantId: "tenant-acme", workspaceId: "workspace-platform" };

const startedSync = {
  ...scope,
  projectId: "project-atlas",
  mode: "mirror",
  status: "scanning",
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T09:00:00.000Z",
};

const noProgress = {
  status: null,
  filesTotal: null,
  filesDone: null,
  bytesTotal: null,
  bytesDone: null,
  activelyChanging: null,
  lastAgreedAt: null,
  lastError: null,
};

layer("CloudSyncRepository", (it) => {
  it.effect("starts a sync with a clean pass and no agreement yet", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;

      const created = yield* repository.upsertProjectSync(startedSync);
      assert.equal(created.mode, "mirror");
      assert.equal(created.status, "scanning");
      assert.equal(created.lastAgreedAt, null);
      assert.equal(created.filesTotal, 0);
      assert.equal(created.bytesDone, 0);
      assert.equal(created.activelyChanging, false);
      assert.equal(created.conflictCount, 0);

      const found = yield* repository.getProjectSync({
        ...scope,
        projectId: "project-atlas",
      });
      assert.equal(Option.getOrUndefined(found)?.mode, "mirror");

      // Another workspace cannot read it, whatever it knows about the id.
      const foreign = yield* repository.getProjectSync({
        tenantId: "tenant-acme",
        workspaceId: "workspace-someone-else",
        projectId: "project-atlas",
      });
      assert.equal(Option.isNone(foreign), true);
    }),
  );

  it.effect("resets the pass counters on a restart and keeps what outlives a pass", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-restart";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      yield* repository.updateProgress({
        ...scope,
        projectId,
        ...noProgress,
        status: "transferring",
        filesTotal: 900,
        filesDone: 900,
        bytesTotal: 4_000_000,
        bytesDone: 4_000_000,
        lastAgreedAt: "2026-08-16T09:30:00.000Z",
        updatedAt: "2026-08-16T09:30:00.000Z",
      });
      yield* repository.recordConflict({
        conflictId: "conflict-restart",
        projectId,
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T09:31:00.000Z",
      });

      const restarted = yield* repository.upsertProjectSync({
        ...startedSync,
        projectId,
        status: "scanning",
        // A restart supplies a created_at it must not be allowed to install.
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2026-08-16T10:00:00.000Z",
      });

      // The progress bar starts empty, or it can never fill.
      assert.equal(restarted.filesTotal, 0);
      assert.equal(restarted.filesDone, 0);
      assert.equal(restarted.bytesTotal, 0);
      assert.equal(restarted.bytesDone, 0);
      // And everything that outlives a pass is still here.
      assert.equal(restarted.lastAgreedAt, "2026-08-16T09:30:00.000Z");
      assert.equal(restarted.conflictCount, 1);
      assert.equal(restarted.createdAt, "2026-08-16T09:00:00.000Z");
    }),
  );

  it.effect("never lets a progress tick forget that the two sides once agreed", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-agreed";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      yield* repository.updateProgress({
        ...scope,
        projectId,
        ...noProgress,
        status: "idle",
        lastAgreedAt: "2026-08-16T09:30:00.000Z",
        updatedAt: "2026-08-16T09:30:00.000Z",
      });

      // A routine tick with no new agreement to report.
      const ticked = yield* repository.updateProgress({
        ...scope,
        projectId,
        ...noProgress,
        status: "transferring",
        filesDone: 3,
        activelyChanging: true,
        updatedAt: "2026-08-16T09:31:00.000Z",
      });
      const row = Option.getOrUndefined(ticked);
      assert.equal(row?.lastAgreedAt, "2026-08-16T09:30:00.000Z");
      assert.equal(row?.activelyChanging, true);
      assert.equal(row?.filesDone, 3);
      // Untouched fields stay untouched: a pause must not zero a pass.
      assert.equal(row?.filesTotal, 0);
    }),
  );

  it.effect("clears a stale error once a pass gets past it", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-error";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      const failed = yield* repository.updateProgress({
        ...scope,
        projectId,
        ...noProgress,
        status: "error",
        lastError: "connection reset while uploading src/index.ts",
        updatedAt: "2026-08-16T09:10:00.000Z",
      });
      assert.equal(Option.getOrUndefined(failed)?.status, "error");

      const recovered = yield* repository.updateProgress({
        ...scope,
        projectId,
        ...noProgress,
        status: "transferring",
        updatedAt: "2026-08-16T09:11:00.000Z",
      });
      // A message that outlives its failure is how a working sync stays red.
      assert.equal(Option.getOrUndefined(recovered)?.lastError, null);
    }),
  );

  it.effect("refuses to invent a sync for a project nobody started", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;

      const updated = yield* repository.updateProgress({
        ...scope,
        projectId: "project-never-shared",
        ...noProgress,
        status: "transferring",
        updatedAt: "2026-08-16T09:00:00.000Z",
      });
      assert.equal(Option.isNone(updated), true);
    }),
  );

  it.effect("lists a workspace's syncs and nobody else's", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const other = { tenantId: "tenant-list", workspaceId: "workspace-list" };

      yield* repository.upsertProjectSync({ ...startedSync, ...other, projectId: "list-b" });
      yield* repository.upsertProjectSync({ ...startedSync, ...other, projectId: "list-a" });
      yield* repository.upsertProjectSync({
        ...startedSync,
        tenantId: "tenant-list",
        workspaceId: "workspace-other",
        projectId: "list-outsider",
      });

      const syncs = yield* repository.listProjectSyncsForWorkspace(other);
      assert.deepStrictEqual(
        syncs.map((sync) => sync.projectId),
        ["list-a", "list-b"],
      );
    }),
  );

  it.effect("tells an agreed deletion apart from a path it has never seen", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-tombstone";

      yield* repository.putBaseFiles({
        projectId,
        files: [
          {
            path: "src/gone.ts",
            hash: "hash-gone",
            sizeBytes: 10,
            updatedAt: "2026-08-16T09:00:00.000Z",
            deletedAt: "2026-08-16T09:05:00.000Z",
          },
          {
            path: "src/kept.ts",
            hash: "hash-kept",
            sizeBytes: 20,
            updatedAt: "2026-08-16T09:00:00.000Z",
            deletedAt: null,
          },
        ],
      });

      const listed = yield* repository.listBaseFiles({ projectId, afterPath: null, limit: 100 });
      assert.deepStrictEqual(
        listed.map((file) => [file.path, file.deletedAt]),
        [
          ["src/gone.ts", "2026-08-16T09:05:00.000Z"],
          ["src/kept.ts", null],
        ],
      );
      // The tombstone keeps its hash, so an edit that beats a delete can still
      // be restored from the base.
      assert.equal(listed[0]?.hash, "hash-gone");

      // A path never seen is the absence of a row, and reads as nothing at all —
      // which is what stops it from being removed on the next pass.
      const absent = listed.find((file) => file.path === "src/unseen.ts");
      assert.equal(absent, undefined);

      // Forgetting a base row is not the same call as agreeing a deletion.
      yield* repository.deleteBaseFile({ projectId, path: "src/gone.ts" });
      const afterForget = yield* repository.listBaseFiles({
        projectId,
        afterPath: null,
        limit: 100,
      });
      assert.deepStrictEqual(
        afterForget.map((file) => file.path),
        ["src/kept.ts"],
      );
    }),
  );

  it.effect("lets a tombstoned path come back", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-resurrected";

      yield* repository.putBaseFiles({
        projectId,
        files: [
          {
            path: "src/back.ts",
            hash: "hash-old",
            sizeBytes: 10,
            updatedAt: "2026-08-16T09:00:00.000Z",
            deletedAt: "2026-08-16T09:05:00.000Z",
          },
        ],
      });
      yield* repository.putBaseFiles({
        projectId,
        files: [
          {
            path: "src/back.ts",
            hash: "hash-new",
            sizeBytes: 40,
            updatedAt: "2026-08-16T09:10:00.000Z",
            deletedAt: null,
          },
        ],
      });

      const listed = yield* repository.listBaseFiles({ projectId, afterPath: null, limit: 10 });
      assert.equal(listed.length, 1);
      // A file that came back must stop reading as deleted, or the next pass
      // removes it again.
      assert.equal(listed[0]?.deletedAt, null);
      assert.equal(listed[0]?.hash, "hash-new");
      assert.equal(listed[0]?.sizeBytes, 40);
    }),
  );

  it.effect("writes a whole tree in one call and pages it back by path", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-large";

      // More than one insert chunk, so the batching is actually exercised
      // rather than described.
      const files = Array.from({ length: 512 }, (_unused, index) => ({
        path: `src/file-${String(index).padStart(4, "0")}.ts`,
        hash: `hash-${index}`,
        sizeBytes: index,
        updatedAt: "2026-08-16T09:00:00.000Z",
        deletedAt: null,
      }));

      const written = yield* repository.putBaseFiles({ projectId, files });
      assert.equal(written, 512);

      const firstPage = yield* repository.listBaseFiles({
        projectId,
        afterPath: null,
        limit: 200,
      });
      assert.equal(firstPage.length, 200);
      assert.equal(firstPage[0]?.path, "src/file-0000.ts");

      const secondPage = yield* repository.listBaseFiles({
        projectId,
        afterPath: firstPage[firstPage.length - 1]?.path ?? null,
        limit: 200,
      });
      assert.equal(secondPage.length, 200);
      // Keyset, so the page after the cursor starts at the next row and never
      // repeats the one it was given.
      assert.equal(secondPage[0]?.path, "src/file-0200.ts");

      const lastPage = yield* repository.listBaseFiles({
        projectId,
        afterPath: secondPage[secondPage.length - 1]?.path ?? null,
        limit: 200,
      });
      assert.equal(lastPage.length, 112);
      assert.equal(lastPage[lastPage.length - 1]?.path, "src/file-0511.ts");
    }),
  );

  it.effect("keeps one project's base revisions out of another's", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;

      const file = {
        path: "src/shared-name.ts",
        hash: "hash-one",
        sizeBytes: 1,
        updatedAt: "2026-08-16T09:00:00.000Z",
        deletedAt: null,
      };
      yield* repository.putBaseFiles({ projectId: "project-one", files: [file] });
      yield* repository.putBaseFiles({
        projectId: "project-two",
        files: [{ ...file, hash: "hash-two" }],
      });

      const one = yield* repository.listBaseFiles({
        projectId: "project-one",
        afterPath: null,
        limit: 10,
      });
      assert.deepStrictEqual(
        one.map((f) => f.hash),
        ["hash-one"],
      );
    }),
  );

  it.effect("counts a conflict on the sync and keeps the collision in the list", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-conflicts";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });

      yield* repository.recordConflict({
        conflictId: "conflict-1",
        projectId,
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:00:00.000Z",
      });
      const second = yield* repository.recordConflict({
        conflictId: "conflict-2",
        projectId,
        path: "src/b.ts",
        conflictedCopyPath: "src/b (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:01:00.000Z",
      });
      assert.equal(Option.getOrUndefined(second)?.resolvedAt, null);

      const sync = yield* repository.getProjectSync({ ...scope, projectId });
      assert.equal(Option.getOrUndefined(sync)?.conflictCount, 2);

      const open = yield* repository.listConflicts({
        projectId,
        includeResolved: false,
        afterId: null,
        limit: 10,
      });
      assert.deepStrictEqual(
        open.map((conflict) => conflict.conflictId),
        ["conflict-1", "conflict-2"],
      );
      // Both versions have a home; neither path is the other.
      assert.notEqual(open[0]?.path, open[0]?.conflictedCopyPath);
    }),
  );

  it.effect("counts nothing for a project that has no sync", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;

      const recorded = yield* repository.recordConflict({
        conflictId: "conflict-orphan",
        projectId: "project-that-was-never-started",
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:00:00.000Z",
      });
      assert.equal(Option.isNone(recorded), true);

      const conflicts = yield* repository.listConflicts({
        projectId: "project-that-was-never-started",
        includeResolved: false,
        afterId: null,
        limit: 10,
      });
      assert.equal(conflicts.length, 0);
    }),
  );

  it.effect("refuses two conflicts that would claim the same rescued copy", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-copy-collision";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      const conflict = {
        projectId,
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:00:00.000Z",
      };
      yield* repository.recordConflict({ ...conflict, conflictId: "collide-1" });

      // The second copy would have overwritten the first person's rescued file.
      const collision = yield* Effect.result(
        repository.recordConflict({ ...conflict, conflictId: "collide-2" }),
      );
      assert.equal(collision._tag, "Failure");

      // And the failed attempt took its counter bump down with it.
      const sync = yield* repository.getProjectSync({ ...scope, projectId });
      assert.equal(Option.getOrUndefined(sync)?.conflictCount, 1);
    }),
  );

  it.effect("decrements the badge once however many times resolve is clicked", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-resolve";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      yield* repository.recordConflict({
        conflictId: "conflict-resolve",
        projectId,
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:00:00.000Z",
      });

      const first = yield* repository.resolveConflict({
        conflictId: "conflict-resolve",
        projectId,
        resolvedAt: "2026-08-16T11:00:00.000Z",
      });
      assert.equal(Option.getOrUndefined(first)?.alreadyResolved, false);
      assert.equal(Option.getOrUndefined(first)?.sync?.conflictCount, 0);

      const second = yield* repository.resolveConflict({
        conflictId: "conflict-resolve",
        projectId,
        resolvedAt: "2026-08-16T12:00:00.000Z",
      });
      assert.equal(Option.getOrUndefined(second)?.alreadyResolved, true);
      // The first resolution time is when the person actually dealt with it.
      assert.equal(Option.getOrUndefined(second)?.record.resolvedAt, "2026-08-16T11:00:00.000Z");
      // And the count did not go down twice, nor below zero.
      assert.equal(Option.getOrUndefined(second)?.sync?.conflictCount, 0);

      const missing = yield* repository.resolveConflict({
        conflictId: "conflict-that-never-existed",
        projectId,
        resolvedAt: "2026-08-16T12:00:00.000Z",
      });
      assert.equal(Option.isNone(missing), true);
    }),
  );

  it.effect("hides resolved conflicts by default and keeps them for anyone asking", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-history";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      yield* repository.recordConflict({
        conflictId: "history-1",
        projectId,
        path: "src/a.ts",
        conflictedCopyPath: "src/a (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:00:00.000Z",
      });
      yield* repository.recordConflict({
        conflictId: "history-2",
        projectId,
        path: "src/b.ts",
        conflictedCopyPath: "src/b (conflicted copy 2026-08-16).ts",
        detectedAt: "2026-08-16T10:01:00.000Z",
      });
      yield* repository.resolveConflict({
        conflictId: "history-1",
        projectId,
        resolvedAt: "2026-08-16T11:00:00.000Z",
      });

      const open = yield* repository.listConflicts({
        projectId,
        includeResolved: false,
        afterId: null,
        limit: 10,
      });
      assert.deepStrictEqual(
        open.map((conflict) => conflict.conflictId),
        ["history-2"],
      );

      // The row outlives the badge: somebody asking later what happened to
      // their file still gets an answer.
      const all = yield* repository.listConflicts({
        projectId,
        includeResolved: true,
        afterId: null,
        limit: 10,
      });
      assert.deepStrictEqual(
        all.map((conflict) => conflict.conflictId),
        ["history-1", "history-2"],
      );
    }),
  );

  it.effect("pages conflicts in detection order even when the ids do not agree", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-conflict-paging";

      yield* repository.upsertProjectSync({ ...startedSync, projectId });
      // Ids deliberately out of chronological order, which is the normal case:
      // ids come from a generator, detection times come from a tree walk.
      const rows = [
        ["zzz-first", "2026-08-16T10:00:00.000Z"],
        ["aaa-second", "2026-08-16T10:01:00.000Z"],
        ["mmm-third", "2026-08-16T10:02:00.000Z"],
      ] as const;
      for (const [conflictId, detectedAt] of rows) {
        yield* repository.recordConflict({
          conflictId,
          projectId,
          path: `src/${conflictId}.ts`,
          conflictedCopyPath: `src/${conflictId} (conflicted copy 2026-08-16).ts`,
          detectedAt,
        });
      }

      const page = yield* repository.listConflicts({
        projectId,
        includeResolved: false,
        afterId: null,
        limit: 2,
      });
      assert.deepStrictEqual(
        page.map((conflict) => conflict.conflictId),
        ["zzz-first", "aaa-second"],
      );

      const next = yield* repository.listConflicts({
        projectId,
        includeResolved: false,
        afterId: page[page.length - 1]?.conflictId ?? null,
        limit: 2,
      });
      // A cursor compared as an id alone would have skipped this row entirely.
      assert.deepStrictEqual(
        next.map((conflict) => conflict.conflictId),
        ["mmm-third"],
      );
    }),
  );

  it.effect("stores a path exactly as it arrived, spaces and all", () =>
    Effect.gen(function* () {
      const repository = yield* CloudSyncRepository;
      const projectId = "project-odd-paths";

      yield* repository.putBaseFiles({
        projectId,
        files: [
          {
            path: "notes/draft.md ",
            hash: "hash-trailing",
            sizeBytes: 1,
            updatedAt: "2026-08-16T09:00:00.000Z",
            deletedAt: null,
          },
        ],
      });

      const listed = yield* repository.listBaseFiles({ projectId, afterPath: null, limit: 10 });
      // Trimming here would restore the file to a different name than it has.
      assert.equal(listed[0]?.path, "notes/draft.md ");
    }),
  );
});
