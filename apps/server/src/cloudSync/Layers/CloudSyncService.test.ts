import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, TenantId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CloudSyncServiceLive } from "./CloudSyncService.ts";
import { blobStoreRoot, hashBytes, storeBytes } from "../blobStore.ts";
import { CloudSyncService, type CloudSyncEntry } from "../Services/CloudSyncService.ts";
import { CollaborationServiceLive } from "../../collaboration/Layers/CollaborationService.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import { CloudSyncRepositoryLive } from "../../persistence/Layers/CloudSync.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { CloudSyncRepository } from "../../persistence/Services/CloudSync.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";

const tenantId = TenantId.make("tenant-atlas");
const workspaceId = WorkspaceId.make("workspace-platform");
const projectId = ProjectId.make("project-atlas");
const scope = { tenantId, workspaceId, projectId };

const owner = { userId: UserId.make("user-owner"), displayName: "Owner" };
const stranger = { userId: UserId.make("user-stranger"), displayName: "Stranger" };

const layer = CloudSyncServiceLive.pipe(
  Layer.provideMerge(CloudSyncRepositoryLive),
  Layer.provideMerge(CollaborationServiceLive),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(TenancyRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-sync-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Presence is enough to be on the roster, as the provider-usage suite does it. */
const beVisible = (actor: { userId: UserId; displayName: string }) =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.upsertPresence(actor, {
      tenantId,
      workspaceId,
      threadId: null,
      status: "active",
    });
  });

/**
 * A project on disk that this workspace owns. Everything here reads the cloud
 * copy off that directory, so a sync without one has nothing to reconcile
 * against.
 */
const makeProject = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projects = yield* ProjectionProjectRepository;
  const workspaceRoot = nodePath.join(config.stateDir, "cloud-project");
  yield* Effect.promise(() => fsPromises.mkdir(workspaceRoot, { recursive: true }));
  const at = "2026-08-19T09:00:00.000Z";
  yield* projects.upsert({
    projectId,
    title: "Atlas",
    workspaceRoot,
    ownership: {
      tenantId,
      tenantDisplayName: "Atlas",
      workspaceId,
      workspaceTitle: "Platform",
      organizationId: null,
      organizationDisplayName: null,
      ownerUserId: owner.userId,
      ownerDisplayName: owner.displayName,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  });
  return workspaceRoot;
});

const writeRemote = (workspaceRoot: string, path: string, contents: string) =>
  Effect.promise(async () => {
    const absolutePath = nodePath.join(workspaceRoot, path);
    await fsPromises.mkdir(nodePath.dirname(absolutePath), { recursive: true });
    await fsPromises.writeFile(absolutePath, contents);
    return {
      path,
      hash: hashBytes(new TextEncoder().encode(contents)),
      sizeBytes: contents.length,
    };
  });

const readRemote = (workspaceRoot: string, path: string) =>
  Effect.promise(() =>
    fsPromises.readFile(nodePath.join(workspaceRoot, path), "utf8").catch(() => null),
  );

/** A scan entry turned into a base revision both sides already agreed on. */
const agreedAt = (file: CloudSyncEntry) => ({
  path: file.path,
  hash: file.hash,
  sizeBytes: file.sizeBytes,
  updatedAt: "2026-08-19T09:00:00.000Z",
  deletedAt: null,
});

const entry = (path: string, contents: string): CloudSyncEntry => ({
  path,
  hash: hashBytes(new TextEncoder().encode(contents)),
  sizeBytes: contents.length,
});

it.effect("only lets a member of the workspace touch a project's sync", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    yield* makeProject;

    const refused = yield* cloudSync
      .start(stranger, { ...scope, mode: "mirror" })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "forbidden");

    const started = yield* cloudSync.start(owner, { ...scope, mode: "mirror" });
    assert.strictEqual(started.sync.mode, "mirror");
    assert.strictEqual(started.sync.status, "scanning");
    assert.strictEqual(started.sync.lastAgreedAt, null);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses to reinterpret a running sync, and allows the change once it is stopped", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    yield* makeProject;

    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });
    const locked = yield* cloudSync.start(owner, { ...scope, mode: "handoff" }).pipe(Effect.flip);
    assert.strictEqual(locked.code, "mode-locked");

    // Pausing is not stopping: a paused sync still intends to resume its pass,
    // so the mode is still locked.
    yield* cloudSync.pause(owner, scope);
    const stillLocked = yield* cloudSync
      .start(owner, { ...scope, mode: "handoff" })
      .pipe(Effect.flip);
    assert.strictEqual(stillLocked.code, "mode-locked");

    yield* cloudSync.stop(owner, scope);
    const handoff = yield* cloudSync.start(owner, { ...scope, mode: "handoff" });
    assert.strictEqual(handoff.sync.mode, "handoff");
  }).pipe(Effect.provide(layer)),
);

it.effect("a scan reporting 1 of 5,000 files never deletes 4,999 remote paths", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    const repository = yield* CloudSyncRepository;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;

    // Five thousand files that both sides already agree on: on disk in the
    // cloud copy, and in the base table at the same hashes.
    const paths = Array.from({ length: 5_000 }, (_, index) => `src/file-${index}.ts`);
    const agreed = yield* Effect.promise(async () => {
      await fsPromises.mkdir(nodePath.join(workspaceRoot, "src"), { recursive: true });
      const files = [];
      for (const path of paths) {
        const contents = `export const value = "${path}";\n`;
        await fsPromises.writeFile(nodePath.join(workspaceRoot, path), contents);
        files.push({
          path,
          hash: hashBytes(new TextEncoder().encode(contents)),
          sizeBytes: contents.length,
          updatedAt: "2026-08-19T09:00:00.000Z",
          deletedAt: null,
        });
      }
      return files;
    });
    yield* repository.putBaseFiles({ projectId, files: agreed });

    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    // The scan that stopped after one file. Every other path looks deleted, and
    // every one of those has a remote that never moved — 4,999 remote deletes.
    const first = agreed[0];
    assert.ok(first !== undefined);
    const result = yield* cloudSync.planPass(owner, {
      ...scope,
      // Deliberately claiming the scan finished: a scanner that *thinks* it is
      // done is the failure this guard exists for, so the flag must not be the
      // only thing standing between it and the deletions.
      scanComplete: true,
      files: [{ path: first.path, hash: first.hash, sizeBytes: first.sizeBytes }],
    });

    assert.strictEqual(result.outcome, "refused");
    if (result.outcome !== "refused") {
      return;
    }
    assert.strictEqual(result.reason, "implausible-deletion");
    assert.strictEqual(result.deletions, 4_999);
    assert.strictEqual(result.knownPaths, 5_000);
    assert.strictEqual(result.reportedPaths, 1);
    assert.strictEqual(result.allowedDeletions, 1_666);
    // A state a person can act on, not a generic failure.
    assert.strictEqual(result.sync.status, "error");
    assert.ok(result.sync.lastError?.includes("5000"));

    // And nothing moved: every file is still on disk and still agreed.
    const survivor = yield* readRemote(workspaceRoot, "src/file-4999.ts");
    assert.ok(survivor !== null);
    const base = yield* repository.listBaseFiles({ projectId, afterPath: null, limit: 6_000 });
    assert.strictEqual(base.length, 5_000);
    assert.ok(base.every((record) => record.deletedAt === null));
  }).pipe(Effect.provide(layer)),
);

it.effect("a modest deletion is planned rather than refused", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    const repository = yield* CloudSyncRepository;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;

    const kept = yield* writeRemote(workspaceRoot, "kept.ts", "kept\n");
    const removed = yield* writeRemote(workspaceRoot, "removed.ts", "removed\n");
    yield* repository.putBaseFiles({
      projectId,
      files: [kept, removed].map((file) => agreedAt(file)),
    });
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    const planned = yield* cloudSync.planPass(owner, {
      ...scope,
      scanComplete: true,
      files: [kept],
    });
    assert.strictEqual(planned.outcome, "planned");
    if (planned.outcome !== "planned") {
      return;
    }
    assert.deepStrictEqual([...planned.deleteRemote], ["removed.ts"]);

    // An interrupted scan reporting the same thing keeps the rest of the pass
    // and drops the deletions, because the one thing it is authoritative about
    // is that it did not finish.
    const partial = yield* cloudSync.planPass(owner, {
      ...scope,
      scanComplete: false,
      files: [kept],
    });
    assert.strictEqual(partial.outcome, "planned");
    if (partial.outcome !== "planned") {
      return;
    }
    assert.deepStrictEqual([...partial.deleteRemote], []);
  }).pipe(Effect.provide(layer)),
);

it.effect("handoff never plans a remote delete, a download or a conflict", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    const repository = yield* CloudSyncRepository;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;

    // Exactly the shape a mirror would read as "the user deleted it locally":
    // agreed at the base, present and unchanged in the cloud, absent from the
    // scan. A one-shot upload has no opinion about it at all.
    const gone = yield* writeRemote(workspaceRoot, "gone.ts", "gone\n");
    // And a path the two sides disagree about, which a mirror would call a
    // conflict and a handoff simply overwrites.
    const diverged = yield* writeRemote(workspaceRoot, "diverged.ts", "remote\n");
    yield* repository.putBaseFiles({
      projectId,
      files: [gone, diverged].map((file) => agreedAt(file)),
    });

    yield* cloudSync.start(owner, { ...scope, mode: "handoff" });
    const planned = yield* cloudSync.planPass(owner, {
      ...scope,
      scanComplete: true,
      files: [entry("diverged.ts", "local\n")],
    });

    assert.strictEqual(planned.outcome, "planned");
    if (planned.outcome !== "planned") {
      return;
    }
    assert.strictEqual(planned.mode, "handoff");
    assert.deepStrictEqual([...planned.deleteRemote], []);
    assert.deepStrictEqual([...planned.download], []);
    assert.deepStrictEqual([...planned.conflicts], []);
    assert.deepStrictEqual(
      planned.upload.map((file) => file.path),
      ["diverged.ts"],
    );

    // And the file the scan did not mention is still there.
    assert.strictEqual(yield* readRemote(workspaceRoot, "gone.ts"), "gone\n");
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses the pass when the cloud copy cannot be read in full", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });
    yield* Effect.promise(() => fsPromises.rm(workspaceRoot, { recursive: true, force: true }));

    const result = yield* cloudSync.planPass(owner, {
      ...scope,
      scanComplete: true,
      files: [entry("a.ts", "a\n")],
    });
    assert.strictEqual(result.outcome, "refused");
    if (result.outcome !== "refused") {
      return;
    }
    assert.strictEqual(result.reason, "remote-unreadable");
  }).pipe(Effect.provide(layer)),
);

it.effect("a path appears in the cloud copy only when its bytes are in the store", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    const repository = yield* CloudSyncRepository;
    const config = yield* ServerConfig;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    const uploaded = entry("src/new.ts", "uploaded\n");
    const neverSent = entry("src/missing.ts", "never sent\n");
    const root = blobStoreRoot(config.stateDir, projectId);
    yield* Effect.promise(() => storeBytes(root, new TextEncoder().encode("uploaded\n")));

    const committed = yield* cloudSync.commitPass(owner, {
      ...scope,
      files: [uploaded, neverSent],
      deletions: [],
      conflicts: [],
      final: true,
    });

    assert.strictEqual(committed.applied, 1);
    assert.deepStrictEqual(
      committed.refused.map((refusal) => refusal.reason),
      ["missing-blob"],
    );
    assert.strictEqual(yield* readRemote(workspaceRoot, "src/new.ts"), "uploaded\n");
    // The path with no bytes behind it never appeared, and was never agreed.
    assert.strictEqual(yield* readRemote(workspaceRoot, "src/missing.ts"), null);
    const base = yield* repository.listBaseFiles({ projectId, afterPath: null, limit: 100 });
    assert.deepStrictEqual(
      base.map((record) => record.path),
      ["src/new.ts"],
    );
    // Something was refused, so the pass cannot claim the two sides agree.
    assert.strictEqual(committed.sync.lastAgreedAt, null);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses to sync an excluded path, and says which", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    const config = yield* ServerConfig;
    const root = blobStoreRoot(config.stateDir, projectId);
    yield* Effect.promise(() => storeBytes(root, new TextEncoder().encode("token\n")));

    const committed = yield* cloudSync.commitPass(owner, {
      ...scope,
      files: [entry(".git/config", "token\n"), entry("../escape.ts", "token\n")],
      deletions: [],
      conflicts: [],
      final: false,
    });

    assert.deepStrictEqual(
      committed.refused.map((refusal) => refusal.reason),
      ["excluded", "unsafe-path"],
    );
    assert.strictEqual(yield* readRemote(workspaceRoot, ".git/config"), null);
  }).pipe(Effect.provide(layer)),
);

it.effect("never removes a path it never agreed existed", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    const workspaceRoot = yield* makeProject;
    yield* writeRemote(workspaceRoot, "untracked.ts", "someone else's\n");
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    const committed = yield* cloudSync.commitPass(owner, {
      ...scope,
      files: [],
      deletions: ["untracked.ts"],
      conflicts: [],
      final: false,
    });

    assert.strictEqual(committed.deleted, 0);
    assert.deepStrictEqual(
      committed.refused.map((refusal) => refusal.reason),
      ["not-agreed"],
    );
    assert.strictEqual(yield* readRemote(workspaceRoot, "untracked.ts"), "someone else's\n");
  }).pipe(Effect.provide(layer)),
);

it.effect("lists conflicts until a person deals with them", () =>
  Effect.gen(function* () {
    const cloudSync = yield* CloudSyncService;
    yield* beVisible(owner);
    yield* makeProject;
    yield* cloudSync.start(owner, { ...scope, mode: "mirror" });

    yield* cloudSync.commitPass(owner, {
      ...scope,
      files: [],
      deletions: [],
      conflicts: [
        {
          path: "src/app.ts",
          conflictedCopyPath: "src/app (conflicted copy 2026-08-19).ts",
          remote: entry("src/app.ts", "remote\n"),
        },
      ],
      final: false,
    });

    const open = yield* cloudSync.listConflicts(owner, scope);
    assert.strictEqual(open.conflicts.length, 1);
    assert.strictEqual(open.nextCursor, null);
    const conflict = open.conflicts[0];
    assert.ok(conflict !== undefined);

    const resolved = yield* cloudSync.resolveConflict(owner, {
      ...scope,
      conflictId: conflict.id,
    });
    assert.ok(resolved.conflict.resolvedAt !== null);
    assert.strictEqual(resolved.sync.conflictCount, 0);

    const remaining = yield* cloudSync.listConflicts(owner, scope);
    assert.deepStrictEqual([...remaining.conflicts], []);

    // A second click from a stale list is already true, and the count must not
    // move twice for it.
    const again = yield* cloudSync.resolveConflict(owner, { ...scope, conflictId: conflict.id });
    assert.strictEqual(again.sync.conflictCount, 0);

    const unknown = yield* cloudSync
      .resolveConflict(owner, { ...scope, conflictId: conflict.id.replace("-", "x") as never })
      .pipe(Effect.flip);
    assert.strictEqual(unknown.code, "conflict-not-found");
  }).pipe(Effect.provide(layer)),
);
