import * as Crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import {
  CloudSyncError,
  type CloudSyncConflict,
  type CloudSyncConflictId,
  type CloudSyncMode,
  type CloudSyncStatus,
  type ProjectCloudSync,
  type ProjectId,
  type TenantId,
  type WorkspaceId,
} from "@t3tools/contracts";
import {
  conflictedCopyPath,
  reconcileTree,
  type FilePresence,
  type FileState,
} from "@t3tools/shared/cloudSync/reconcile";
import { Effect, Layer, Option } from "effect";

import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import {
  CloudSyncRepository,
  type CloudSyncBaseFileInput,
  type CloudSyncConflictRecord,
  type CloudSyncFileRecord,
  type ProjectCloudSyncRecord,
} from "../../persistence/Services/CloudSync.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  blobStoreRoot,
  hashBytes,
  readBlob,
  storeBytes,
  type BlobStoreRoot,
} from "../blobStore.ts";
import {
  CloudSyncService,
  type CloudSyncActor,
  type CloudSyncEntry,
  type CloudSyncPassResult,
  type CloudSyncPlannedConflict,
  type CloudSyncProjectScope,
  type CloudSyncRefusedPath,
  type CloudSyncServiceShape,
} from "../Services/CloudSyncService.ts";

/**
 * The floor under the deletion guard: a pass may remove up to this many remote
 * paths without having to be plausible about it.
 *
 * A ratio alone is useless on a small tree — a third of six files is two, so
 * tidying up after an afternoon would be treated as an incident. Below this
 * count a mistaken delete is also cheap to notice and cheap to undo, which is
 * not true of the case this guard exists for.
 */
const MAX_UNQUESTIONED_DELETIONS = 20;

/**
 * And the ratio above that floor: at most a third of what the server believed
 * this project contained.
 *
 * A third rather than something tighter because deleting a directory is an
 * ordinary thing to do and a mirror is explicitly not a backup — the spec says
 * so where the mode is chosen. And a third rather than something looser because
 * the failure being guarded against is not "the user deleted a lot", it is "the
 * scan stopped early and every unreported file looks deleted", which lands well
 * past any of these numbers: an interrupted walk reports a handful of paths out
 * of thousands.
 */
const DELETION_RATIO = 1 / 3;

/**
 * Ceilings on what one pass will carry. A tree arrives from a machine this
 * server does not control, so every bound has to be stated before the walk
 * starts rather than trusted to be small.
 */
const MAX_SYNCED_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SYNCED_FILES = 50_000;
const MAX_WALK_DEPTH = 24;

/** One page of base revisions. Large enough that a big tree is tens of reads, not thousands. */
const BASE_FILE_PAGE_SIZE = 1_000;

/** Conflicts come back paged; this is the bound the contract already caps at. */
const DEFAULT_CONFLICT_PAGE_SIZE = 50;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A failed read or write of storage, in this error's vocabulary.
 *
 * `storage` and never a completed sync — the contract says as much. A pass that
 * could not read the base must not fall back to "no base", because no base
 * means nothing was ever agreed, and nothing agreed means a tree full of paths
 * that look brand new.
 */
function storageFailure(message: string) {
  return (cause: unknown) => new CloudSyncError({ code: "storage", message, cause });
}

function notFound(message: string): CloudSyncError {
  return new CloudSyncError({ code: "not-found", message });
}

/**
 * Path segments a sync never carries, whoever asked.
 *
 * Straight out of the spec's exclusions. `.git` is the one worth restating: a
 * repository half-replicated between two machines is worse than no repository,
 * and worse still, `.git/config` carries push credentials. Everything beginning
 * with a dot is refused for the same reason `ShareLinkService` refuses it —
 * `.env` is the rest of the secrets — which also takes `.DS_Store` with it.
 */
function isExcludedSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === "node_modules" || segment === "Thumbs.db";
}

/**
 * Splits a project-relative path into segments this service is willing to
 * touch, or refuses it.
 *
 * No decoding happens here. Whatever arrived has already been decoded once by
 * whoever parsed the request, and a second pass would turn a filename that
 * genuinely contains `%2e%2e` into a traversal.
 */
function safeSegments(requested: string): ReadonlyArray<string> | null {
  if (
    requested.length === 0 ||
    requested.includes("\0") ||
    requested.length > 1024 ||
    nodePath.isAbsolute(requested)
  ) {
    return null;
  }
  // Backslashes separate too. On Windows they are the separator, and on POSIX
  // treating `..\..` as one opaque filename would let a path written on one
  // platform escape when it is read on the other.
  const segments = requested.split(/[\\/]+/);
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return null;
  }
  return segments.every((segment) => segment !== ".." && segment !== ".") ? segments : null;
}

type PathVerdict = "ok" | CloudSyncRefusedPath["reason"];

function judgePath(path: string): PathVerdict {
  const segments = safeSegments(path);
  if (segments === null) {
    return "unsafe-path";
  }
  return segments.some(isExcludedSegment) ? "excluded" : "ok";
}

/**
 * The most a pass may remove from the cloud before it has to stop and ask.
 *
 * `knownPaths` is what the base says currently exists — the server's own idea
 * of how big this tree is — and never the number of paths the scan reported,
 * which is precisely the number a truncated scan makes small.
 */
export function allowedDeletions(knownPaths: number): number {
  return Math.max(MAX_UNQUESTIONED_DELETIONS, Math.floor(knownPaths * DELETION_RATIO));
}

/**
 * Storage keeps primitives, so the two narrow fields have to be re-narrowed on
 * the way out — and both fall to the safe side rather than failing the read.
 *
 * A row that will not decode is worse than a row that reads oddly: the field it
 * would take with it is `lastAgreedAt`, the only evidence a person's work ever
 * reached the server. An unknown status therefore reads as `error`, which is
 * true (this build does not know what the sync is doing) and visible. An
 * unknown mode reads as `handoff`, because `handoff` is the mode that cannot
 * delete anything — under "a sync never destroys work" the unknown case has to
 * resolve to the harmless one.
 */
function toMode(value: string): CloudSyncMode {
  return value === "mirror" ? "mirror" : "handoff";
}

function toStatus(value: string): CloudSyncStatus {
  switch (value) {
    case "idle":
    case "scanning":
    case "transferring":
    case "paused":
    case "error": {
      return value;
    }
    default: {
      return "error";
    }
  }
}

/**
 * Ids are cast rather than re-parsed, the same trade `ShareLinkService` makes:
 * they were branded when they were written, and re-validating a stored id would
 * turn one malformed row into a failed read of the whole panel.
 */
function toProjectCloudSync(record: ProjectCloudSyncRecord): ProjectCloudSync {
  return {
    projectId: record.projectId as ProjectId,
    tenantId: record.tenantId as TenantId,
    workspaceId: record.workspaceId as WorkspaceId,
    mode: toMode(record.mode),
    status: toStatus(record.status),
    lastAgreedAt: record.lastAgreedAt,
    // The contract wants a non-empty string or null, and an empty column is
    // "no error" rather than an error with nothing to say.
    lastError: record.lastError !== null && record.lastError.length > 0 ? record.lastError : null,
    filesTotal: record.filesTotal,
    filesDone: record.filesDone,
    bytesTotal: record.bytesTotal,
    bytesDone: record.bytesDone,
    activelyChanging: record.activelyChanging,
    conflictCount: record.conflictCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toCloudSyncConflict(record: CloudSyncConflictRecord): CloudSyncConflict {
  return {
    id: record.conflictId as CloudSyncConflictId,
    projectId: record.projectId as ProjectId,
    path: record.path,
    conflictedCopyPath: record.conflictedCopyPath,
    detectedAt: record.detectedAt,
    resolvedAt: record.resolvedAt,
  };
}

function toBaseState(record: CloudSyncFileRecord): FileState {
  // A tombstone stays a tombstone rather than being flattened to "no row". The
  // reconciler reads the two oppositely, and the spec is explicit that a base
  // tombstone counts as "nothing was agreed" — which it can only do if it can
  // still tell the difference.
  return record.deletedAt !== null
    ? { deleted: true }
    : { hash: record.hash, sizeBytes: record.sizeBytes };
}

function presenceOf(state: FileState | undefined): FilePresence | null {
  return state !== undefined && state !== null && "hash" in state ? state : null;
}

const makeCloudSyncService = Effect.gen(function* () {
  const repository = yield* CloudSyncRepository;
  const collaboration = yield* CollaborationService;
  const projects = yield* ProjectionProjectRepository;
  const config = yield* ServerConfig;

  /**
   * Membership, from the collaboration roster and nowhere else — the same
   * source `ShareLinkService` reads. A second definition of "who is in this
   * workspace" would eventually disagree with the panel the person is looking
   * at, and this one decides who may replicate a tree off somebody's laptop.
   */
  const requireMember = (actor: CloudSyncActor, scope: CloudSyncProjectScope) =>
    collaboration
      .listMembers(actor, { tenantId: scope.tenantId, workspaceId: scope.workspaceId })
      .pipe(
        Effect.mapError(storageFailure("Could not read who belongs to this workspace.")),
        Effect.flatMap((members) =>
          members.members.some((member) => member.userId === actor.userId)
            ? Effect.void
            : Effect.fail(
                new CloudSyncError({
                  code: "forbidden",
                  message: "Only a member of this workspace can sync its projects.",
                }),
              ),
        ),
      );

  /**
   * The cloud copy's directory, and proof it is this workspace's.
   *
   * Project ids are global, so without this being a member of *some* workspace
   * would be enough to replicate any project on the server. A project with no
   * ownership at all is a purely local one, created before any tenancy existed;
   * it is allowed, because refusing it would break sync on every single-user
   * install for a check with nothing to compare against.
   */
  const readProjectRoot = (scope: CloudSyncProjectScope) =>
    projects.getById({ projectId: scope.projectId }).pipe(
      Effect.mapError(storageFailure("Could not read the project this sync belongs to.")),
      Effect.flatMap((project) => {
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return Effect.fail(notFound("There is no such project in this workspace."));
        }
        const ownership = project.value.ownership;
        return ownership !== null &&
          (ownership.tenantId !== scope.tenantId || ownership.workspaceId !== scope.workspaceId)
          ? Effect.fail(notFound("There is no such project in this workspace."))
          : Effect.succeed(nodePath.resolve(project.value.workspaceRoot));
      }),
    );

  const requireProjectAccess: CloudSyncServiceShape["requireProjectAccess"] = (actor, scope) =>
    requireMember(actor, scope).pipe(
      Effect.flatMap(() => readProjectRoot(scope)),
      Effect.asVoid,
    );

  const requireSync = (scope: CloudSyncProjectScope) =>
    repository.getProjectSync(scope).pipe(
      Effect.mapError(storageFailure("Could not read this project's sync.")),
      Effect.flatMap((record) =>
        Option.isNone(record)
          ? Effect.fail(notFound("This project is not being synced."))
          : Effect.succeed(record.value),
      ),
    );

  /**
   * Every base revision for a project, tombstones included, read by keyset
   * cursor. A page smaller than the limit is the end; nothing counts rows first
   * because the count would be a second full read of the same table.
   */
  const readBase = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const base = new Map<string, FileState>();
      let afterPath: string | null = null;
      for (;;) {
        const page: ReadonlyArray<CloudSyncFileRecord> = yield* repository
          .listBaseFiles({ projectId, afterPath, limit: BASE_FILE_PAGE_SIZE })
          .pipe(Effect.mapError(storageFailure("Could not read this project's agreed revisions.")));
        for (const record of page) {
          base.set(record.path, toBaseState(record));
        }
        const last = page.at(-1);
        if (page.length < BASE_FILE_PAGE_SIZE || last === undefined) {
          return base;
        }
        afterPath = last.path;
      }
    });

  /**
   * The cloud copy as it actually is on disk, hashed.
   *
   * Modification times are not consulted. They are a legitimate "might have
   * changed" pre-filter for a scanner that keeps its own cache, and this walk
   * keeps none, so using one here would only mean trusting a clock to decide
   * whether to look — which is how a file that changed gets reported as
   * unchanged.
   *
   * `truncated` matters as much as the map. A walk that stopped early makes
   * every unwalked path look absent from the cloud, and an absent remote under
   * an agreed base is a deletion; the caller refuses the pass rather than
   * planning against half a tree.
   */
  const walkRemote = (workspaceRoot: string) =>
    Effect.tryPromise({
      try: async () => {
        const remote = new Map<string, FileState>();
        const refused: CloudSyncRefusedPath[] = [];
        const queue: Array<{ readonly absolutePath: string; readonly depth: number }> = [
          { absolutePath: workspaceRoot, depth: 0 },
        ];
        let truncated = false;

        while (queue.length > 0 && !truncated) {
          const next = queue.shift();
          if (next === undefined) {
            break;
          }
          const children = await fsPromises
            .readdir(next.absolutePath, { withFileTypes: true })
            .catch(() => null);
          if (children === null) {
            // An unreadable directory is not an empty one. Treating it as empty
            // would report every file under it as deleted from the cloud.
            truncated = true;
            break;
          }
          for (const child of children) {
            if (isExcludedSegment(child.name)) {
              continue;
            }
            const absolutePath = nodePath.join(next.absolutePath, child.name);
            const relativePath = nodePath
              .relative(workspaceRoot, absolutePath)
              .split(nodePath.sep)
              .join("/");
            // Symlinks are never followed, in either direction. A link pointing
            // outside the project is a way to pull a home directory into a
            // shared workspace, and a link the sync wrote back would be a way
            // to put one there.
            if (child.isSymbolicLink()) {
              refused.push({ path: relativePath, reason: "unsafe-path" });
              continue;
            }
            if (child.isDirectory()) {
              if (next.depth + 1 <= MAX_WALK_DEPTH) {
                queue.push({ absolutePath, depth: next.depth + 1 });
              } else {
                truncated = true;
                break;
              }
              continue;
            }
            if (!child.isFile()) {
              continue;
            }
            if (remote.size >= MAX_SYNCED_FILES) {
              truncated = true;
              break;
            }
            const stats = await fsPromises.stat(absolutePath).catch(() => null);
            if (stats === null) {
              truncated = true;
              break;
            }
            if (stats.size > MAX_SYNCED_FILE_BYTES) {
              refused.push({ path: relativePath, reason: "too-large" });
              continue;
            }
            const contents = await fsPromises.readFile(absolutePath).catch(() => null);
            if (contents === null) {
              truncated = true;
              break;
            }
            remote.set(relativePath, {
              hash: hashBytes(Uint8Array.from(contents)),
              sizeBytes: contents.length,
            });
          }
        }

        return { remote, refused: refused as ReadonlyArray<CloudSyncRefusedPath>, truncated };
      },
      catch: storageFailure("Could not read the cloud copy of this project."),
    });

  const writeProgress = (
    scope: CloudSyncProjectScope,
    fields: {
      readonly status: CloudSyncStatus | null;
      readonly filesTotal?: number | null;
      readonly filesDone?: number | null;
      readonly bytesTotal?: number | null;
      readonly bytesDone?: number | null;
      readonly lastAgreedAt?: string | null;
      readonly lastError: string | null;
    },
  ) =>
    repository
      .updateProgress({
        ...scope,
        status: fields.status,
        filesTotal: fields.filesTotal ?? null,
        filesDone: fields.filesDone ?? null,
        bytesTotal: fields.bytesTotal ?? null,
        bytesDone: fields.bytesDone ?? null,
        activelyChanging: null,
        lastAgreedAt: fields.lastAgreedAt ?? null,
        lastError: fields.lastError,
        updatedAt: nowIso(),
      })
      .pipe(
        Effect.mapError(storageFailure("Could not record the state of this sync.")),
        Effect.flatMap((record) =>
          Option.isNone(record)
            ? Effect.fail(notFound("This project is not being synced."))
            : Effect.succeed(toProjectCloudSync(record.value)),
        ),
      );

  const getStatus: CloudSyncServiceShape["getStatus"] = (actor, input) =>
    requireMember(actor, input).pipe(
      Effect.flatMap(() =>
        repository
          .getProjectSync(input)
          .pipe(Effect.mapError(storageFailure("Could not read this project's sync."))),
      ),
      Effect.map((record) => ({
        sync: Option.isNone(record) ? null : toProjectCloudSync(record.value),
      })),
    );

  const start: CloudSyncServiceShape["start"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireMember(actor, input);
      // Before the row is touched: a sync started against a project this
      // workspace does not own would be a row nothing can ever open.
      yield* readProjectRoot(input);

      const existing = yield* repository
        .getProjectSync(input)
        .pipe(Effect.mapError(storageFailure("Could not read this project's sync.")));

      if (Option.isSome(existing)) {
        const current = toProjectCloudSync(existing.value);
        // `idle` is the only state a mode may change in, and `paused` is
        // deliberately not one of them: a paused sync is a sync, with a pass
        // it intends to resume, and resuming it under the other mode would
        // reinterpret which copy is canonical halfway through.
        if (current.mode !== input.mode && current.status !== "idle") {
          return yield* new CloudSyncError({
            code: "mode-locked",
            message:
              current.mode === "mirror"
                ? "Stop the mirror before handing this project over to the cloud."
                : "Stop the handoff before mirroring this project.",
          });
        }
      }

      const startedAt = nowIso();
      const record = yield* repository
        .upsertProjectSync({
          ...input,
          mode: input.mode,
          // A pass begins by scanning, and saying so is what lets the UI
          // explain a first pass over a large tree that has not moved a byte
          // yet.
          status: "scanning",
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .pipe(Effect.mapError(storageFailure("Could not start syncing this project.")));

      return { sync: toProjectCloudSync(record) };
    });

  const pause: CloudSyncServiceShape["pause"] = (actor, input) =>
    requireMember(actor, input).pipe(
      Effect.flatMap(() => requireSync(input)),
      // Every counter left alone. A pause is not the end of a pass, and zeroing
      // a half-finished one would make resuming look like starting over.
      Effect.flatMap(() => writeProgress(input, { status: "paused", lastError: null })),
      Effect.map((sync) => ({ sync })),
    );

  const stop: CloudSyncServiceShape["stop"] = (actor, input) =>
    requireMember(actor, input).pipe(
      Effect.flatMap(() => requireSync(input)),
      // Back to `idle`, which is also what unlocks a change of mode. Both
      // copies survive and start diverging from this timestamp, and the row is
      // returned so the UI can say when they parted company.
      Effect.flatMap(() => writeProgress(input, { status: "idle", lastError: null })),
      Effect.map((sync) => ({ sync })),
    );

  const listConflicts: CloudSyncServiceShape["listConflicts"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireMember(actor, input);
      const limit = input.limit ?? DEFAULT_CONFLICT_PAGE_SIZE;
      const records = yield* repository
        .listConflicts({
          projectId: input.projectId,
          includeResolved: input.includeResolved ?? false,
          afterId: input.afterId ?? null,
          // One more than asked for, so "is there another page" is answered by
          // the read rather than by counting the whole table.
          limit: limit + 1,
        })
        .pipe(Effect.mapError(storageFailure("Could not read this project's conflicts.")));

      const page = records.slice(0, limit).map(toCloudSyncConflict);
      return {
        conflicts: page,
        nextCursor: records.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });

  const resolveConflict: CloudSyncServiceShape["resolveConflict"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireMember(actor, input);
      const resolvedAt = nowIso();
      const resolved = yield* repository
        .resolveConflict({
          conflictId: input.conflictId,
          projectId: input.projectId,
          resolvedAt,
        })
        .pipe(Effect.mapError(storageFailure("Could not resolve that conflict.")));

      if (Option.isNone(resolved)) {
        return yield* new CloudSyncError({
          code: "conflict-not-found",
          message: "There is no such conflict in this project.",
        });
      }
      // `alreadyResolved` succeeds rather than failing, unlike the same shape in
      // `revokeLink`. Re-revoking a link is a claim about who can still reach a
      // file and deserves to be corrected; this call only records that a person
      // dealt with two copies of theirs, so a second click from a stale list is
      // already true. The repository has kept the count from moving twice,
      // which is the only thing a double click could actually break.
      const sync = resolved.value.sync;
      if (sync === null) {
        return yield* notFound("This project is not being synced.");
      }
      return {
        conflict: toCloudSyncConflict(resolved.value.record),
        sync: toProjectCloudSync(sync),
      };
    });

  /**
   * Publishes the bytes behind everything the laptop has to fetch, so a
   * download is a plain content-addressed GET like every other transfer.
   *
   * Only the paths the plan actually moves. Ingesting the whole cloud copy on
   * every pass would double the cost of a pass that moves nothing, which is the
   * pass this feature is optimised for.
   */
  const publishForDownload = (
    root: BlobStoreRoot,
    workspaceRoot: string,
    paths: Iterable<string>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        for (const path of paths) {
          const segments = safeSegments(path);
          if (segments === null) {
            continue;
          }
          const absolutePath = nodePath.join(workspaceRoot, segments.join(nodePath.sep));
          const contents = await fsPromises.readFile(absolutePath).catch(() => null);
          if (contents !== null) {
            await storeBytes(root, Uint8Array.from(contents));
          }
        }
      },
      catch: storageFailure("Could not stage the cloud copy for download."),
    });

  const planPass: CloudSyncServiceShape["planPass"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireMember(actor, input);
      const workspaceRoot = yield* readProjectRoot(input);
      const syncRecord = yield* requireSync(input);
      const mode = toMode(syncRecord.mode);

      const refused: CloudSyncRefusedPath[] = [];
      const local = new Map<string, FileState>();
      for (const entry of input.files) {
        const verdict = judgePath(entry.path);
        if (verdict !== "ok") {
          refused.push({ path: entry.path, reason: verdict });
          continue;
        }
        if (entry.sizeBytes > MAX_SYNCED_FILE_BYTES) {
          refused.push({ path: entry.path, reason: "too-large" });
          continue;
        }
        local.set(entry.path, { hash: entry.hash, sizeBytes: entry.sizeBytes });
      }

      const walk = yield* walkRemote(workspaceRoot);
      refused.push(...walk.refused);
      if (walk.truncated) {
        // The same hazard as a partial local scan, from the other side: a
        // half-read cloud copy makes files that are there look gone. Refusing
        // is the whole of obligation 1 applied symmetrically.
        const sync = yield* writeProgress(input, {
          status: "error",
          lastError: "The cloud copy could not be read in full, so this pass was not run.",
        });
        return {
          outcome: "refused",
          reason: "remote-unreadable",
          message:
            "The cloud copy could not be read in full. Syncing against a partial view of it could delete files that are still there.",
          deletions: 0,
          knownPaths: 0,
          reportedPaths: input.files.length,
          allowedDeletions: 0,
          sync,
        } satisfies CloudSyncPassResult;
      }

      const base = yield* readBase(input.projectId);

      const upload: CloudSyncEntry[] = [];
      const download: CloudSyncEntry[] = [];
      const deleteRemote: string[] = [];
      const conflicts: CloudSyncPlannedConflict[] = [];
      const agreed: CloudSyncBaseFileInput[] = [];
      const agreedAt = nowIso();

      if (mode === "handoff") {
        // Obligation 4, and the reason it is a branch rather than a flag: a
        // one-shot upload has no remote deletes, no downloads and no conflicts
        // to have, so the mirror table is not consulted at all. Running it and
        // discarding the deletions afterwards would leave the deletions one
        // refactor away from being honoured.
        for (const [path, state] of local) {
          const localPresence = presenceOf(state);
          if (localPresence === null) {
            continue;
          }
          const remotePresence = presenceOf(walk.remote.get(path));
          if (remotePresence !== null && remotePresence.hash === localPresence.hash) {
            agreed.push({
              path,
              hash: localPresence.hash,
              sizeBytes: localPresence.sizeBytes,
              updatedAt: agreedAt,
              deletedAt: null,
            });
            continue;
          }
          upload.push({ path, hash: localPresence.hash, sizeBytes: localPresence.sizeBytes });
        }
      } else {
        const reconciliation = reconcileTree({ local, remote: walk.remote, base });
        for (const action of reconciliation.actions) {
          switch (action.kind) {
            case "upload":
            case "restoreRemoteFromLocal": {
              upload.push({
                path: action.path,
                hash: action.local.hash,
                sizeBytes: action.local.sizeBytes,
              });
              break;
            }
            case "download":
            case "restoreLocalFromRemote": {
              download.push({
                path: action.path,
                hash: action.remote.hash,
                sizeBytes: action.remote.sizeBytes,
              });
              break;
            }
            case "deleteRemote": {
              deleteRemote.push(action.path);
              break;
            }
            case "conflict": {
              conflicts.push({
                path: action.path,
                conflictedCopyPath: action.conflictedCopyPath,
                remote: {
                  path: action.path,
                  hash: action.remote.hash,
                  sizeBytes: action.remote.sizeBytes,
                },
              });
              break;
            }
            case "advanceBase": {
              // No bytes move, so this can be recorded now rather than waiting
              // for a commit that has nothing to carry.
              const priorHash = presenceOf(base.get(action.path))?.hash ?? "";
              agreed.push(
                "deleted" in action.agreed
                  ? {
                      path: action.path,
                      hash: priorHash,
                      sizeBytes: 0,
                      updatedAt: agreedAt,
                      deletedAt: agreedAt,
                    }
                  : {
                      path: action.path,
                      hash: action.agreed.hash,
                      sizeBytes: action.agreed.sizeBytes,
                      updatedAt: agreedAt,
                      deletedAt: null,
                    },
              );
              break;
            }
            default: {
              break;
            }
          }
        }
      }

      // How big the server thought this tree was, tombstones excluded: a path
      // both sides already agreed was gone is not part of what exists.
      let knownPaths = 0;
      for (const state of base.values()) {
        if (presenceOf(state) !== null) {
          knownPaths += 1;
        }
      }
      const allowed = allowedDeletions(knownPaths);

      if (deleteRemote.length > allowed) {
        // The refusal that matters. A scan reporting a handful of files out of
        // thousands is not a person who deleted thousands of files; it is a
        // walk that stopped early, a permission error, or an exclusion rule
        // that changed between passes. Nothing is written, nothing is deleted,
        // and the numbers go back so the UI can say exactly what it declined.
        const sync = yield* writeProgress(input, {
          status: "error",
          lastError: `This scan reported ${input.files.length} files but the cloud copy has ${knownPaths}. Syncing it would delete ${deleteRemote.length} of them, so it was not run.`,
        });
        return {
          outcome: "refused",
          reason: "implausible-deletion",
          message: `Syncing this scan would delete ${deleteRemote.length} files from the cloud copy, out of ${knownPaths} it knows about. That usually means the scan did not finish rather than that the files are gone.`,
          deletions: deleteRemote.length,
          knownPaths,
          reportedPaths: input.files.length,
          allowedDeletions: allowed,
          sync,
        } satisfies CloudSyncPassResult;
      }

      // A scanner that knows it was interrupted is believed on the one point it
      // is authoritative about. The rest of the pass is still useful — uploads
      // and downloads lose nothing — so only the deletions are dropped.
      const plannedDeletions = input.scanComplete ? deleteRemote : [];

      if (agreed.length > 0) {
        yield* repository
          .putBaseFiles({ projectId: input.projectId, files: agreed })
          .pipe(Effect.mapError(storageFailure("Could not record what this pass agreed.")));
      }

      const root = blobStoreRoot(config.stateDir, input.projectId);
      yield* publishForDownload(root, workspaceRoot, [
        ...download.map((entry) => entry.path),
        ...conflicts.map((conflict) => conflict.path),
      ]);

      const filesTotal =
        upload.length + download.length + conflicts.length + plannedDeletions.length;
      const bytesTotal =
        upload.reduce((total, entry) => total + entry.sizeBytes, 0) +
        download.reduce((total, entry) => total + entry.sizeBytes, 0) +
        conflicts.reduce((total, conflict) => total + conflict.remote.sizeBytes, 0);

      const sync = yield* writeProgress(input, {
        // A pass with nothing to move never says `transferring`; it is simply
        // done, and saying otherwise leaves a progress bar at 0/0 forever.
        status: filesTotal === 0 ? "idle" : "transferring",
        filesTotal,
        filesDone: 0,
        bytesTotal,
        bytesDone: 0,
        // Nothing to move means the two sides already agree in full, which is
        // exactly what this timestamp records.
        lastAgreedAt: filesTotal === 0 ? agreedAt : null,
        lastError: null,
      });

      return {
        outcome: "planned",
        mode,
        upload,
        download,
        deleteRemote: plannedDeletions,
        conflicts,
        refused,
        sync,
      } satisfies CloudSyncPassResult;
    });

  /**
   * Writes one file into the cloud copy, and never leaves a partial one behind.
   *
   * Temporary name then rename: within a filesystem the rename is atomic, so a
   * collaborator reading this path sees either the previous content or the
   * complete new content and never the middle of a transfer. The temporary name
   * is random so two passes writing the same path cannot land on one another's
   * staging file.
   */
  const materialize = (workspaceRoot: string, path: string, contents: Uint8Array) =>
    Effect.tryPromise({
      try: async () => {
        const segments = safeSegments(path);
        if (segments === null) {
          return false;
        }
        const absolutePath = nodePath.join(workspaceRoot, segments.join(nodePath.sep));
        const directory = nodePath.dirname(absolutePath);
        await fsPromises.mkdir(directory, { recursive: true });
        const staged = nodePath.join(directory, `.t3-cloud-sync-${Crypto.randomUUID()}`);
        await fsPromises.writeFile(staged, contents);
        await fsPromises.rename(staged, absolutePath);
        return true;
      },
      catch: storageFailure("Could not write a file into the cloud copy."),
    });

  const removeFromCloud = (workspaceRoot: string, path: string) =>
    Effect.tryPromise({
      try: async () => {
        const segments = safeSegments(path);
        if (segments === null) {
          return false;
        }
        await fsPromises.rm(nodePath.join(workspaceRoot, segments.join(nodePath.sep)), {
          force: true,
        });
        return true;
      },
      catch: storageFailure("Could not remove a file from the cloud copy."),
    });

  const commitPass: CloudSyncServiceShape["commitPass"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireMember(actor, input);
      const workspaceRoot = yield* readProjectRoot(input);
      const syncRecord = yield* requireSync(input);
      const root = blobStoreRoot(config.stateDir, input.projectId);

      const refused: CloudSyncRefusedPath[] = [];
      const agreed: CloudSyncBaseFileInput[] = [];
      const agreedAt = nowIso();
      let applied = 0;
      let appliedBytes = 0;

      for (const entry of input.files) {
        const verdict = judgePath(entry.path);
        if (verdict !== "ok") {
          refused.push({ path: entry.path, reason: verdict });
          continue;
        }
        if (entry.sizeBytes > MAX_SYNCED_FILE_BYTES) {
          refused.push({ path: entry.path, reason: "too-large" });
          continue;
        }
        // From the store and only from the store. The store admits a blob only
        // after its bytes hash to the name they were sent under, so taking
        // content from here is what makes "a file appears at its path once its
        // hash verifies" true rather than asserted — and a hash nobody uploaded
        // simply has no bytes to write.
        const contents = yield* Effect.tryPromise({
          try: () => readBlob(root, entry.hash),
          catch: storageFailure("Could not read the uploaded content."),
        });
        if (contents === null) {
          refused.push({ path: entry.path, reason: "missing-blob" });
          continue;
        }
        const written = yield* materialize(workspaceRoot, entry.path, contents);
        if (!written) {
          refused.push({ path: entry.path, reason: "unsafe-path" });
          continue;
        }
        applied += 1;
        appliedBytes += contents.length;
        agreed.push({
          path: entry.path,
          hash: entry.hash,
          sizeBytes: contents.length,
          updatedAt: agreedAt,
          deletedAt: null,
        });
      }

      let deleted = 0;
      if (input.deletions.length > 0) {
        // The base is read even when the plan already ran, because this call is
        // reachable on its own and the guard has to be, too. A commit that took
        // a deletion list on trust would be a way around the one check standing
        // between a truncated scan and a deleted project.
        const base = yield* readBase(input.projectId);
        let knownPaths = 0;
        for (const state of base.values()) {
          if (presenceOf(state) !== null) {
            knownPaths += 1;
          }
        }
        const allowed = allowedDeletions(knownPaths);
        if (input.deletions.length > allowed) {
          return yield* new CloudSyncError({
            code: "storage",
            message: `Refusing to delete ${input.deletions.length} files from a cloud copy of ${knownPaths}. Run the pass again once the scan completes.`,
          });
        }

        for (const path of input.deletions) {
          const verdict = judgePath(path);
          if (verdict !== "ok") {
            refused.push({ path, reason: verdict });
            continue;
          }
          const priorHash = presenceOf(base.get(path));
          if (priorHash === null) {
            // Rule 4: a path the server never agreed on is never removed,
            // whatever the caller's index says.
            refused.push({ path, reason: "not-agreed" });
            continue;
          }
          const removed = yield* removeFromCloud(workspaceRoot, path);
          if (!removed) {
            refused.push({ path, reason: "unsafe-path" });
            continue;
          }
          deleted += 1;
          // A tombstone, not a deleted row. The hash carries the content that
          // was agreed before the deletion, which is what lets "an edit beats a
          // delete" be settled later; dropping the row instead would say "never
          // seen" and bring the file back on the next pass.
          agreed.push({
            path,
            hash: priorHash.hash,
            sizeBytes: priorHash.sizeBytes,
            updatedAt: agreedAt,
            deletedAt: agreedAt,
          });
        }
      }

      if (agreed.length > 0) {
        yield* repository
          .putBaseFiles({ projectId: input.projectId, files: agreed })
          .pipe(Effect.mapError(storageFailure("Could not record what this pass agreed.")));
      }

      let conflictsRecorded = 0;
      for (const conflict of input.conflicts) {
        // The name is recomputed from the path rather than taken from the
        // caller, so a client cannot ask the server to record a rescued copy
        // somewhere it never wrote one. Two conflicts on one path on one day
        // produce one name, and disambiguating it belongs to whichever machine
        // is touching that disk — the row records where it went.
        const recorded = yield* repository
          .recordConflict({
            conflictId: Crypto.randomUUID(),
            projectId: input.projectId,
            path: conflict.path,
            conflictedCopyPath: conflict.conflictedCopyPath || conflictedCopyPath(conflict.path),
            detectedAt: agreedAt,
          })
          .pipe(Effect.mapError(storageFailure("Could not record a conflict.")));
        if (Option.isSome(recorded)) {
          conflictsRecorded += 1;
        }
      }

      const done = input.final && refused.length === 0;
      const sync = yield* writeProgress(input, {
        status: done ? "idle" : input.final ? "error" : "transferring",
        filesDone: syncRecord.filesDone + applied + deleted,
        bytesDone: syncRecord.bytesDone + appliedBytes,
        // Only a final commit that refused nothing. This is the field that
        // answers "is my work safe", so a pass that left anything behind must
        // not be able to claim the two sides agree.
        lastAgreedAt: done ? agreedAt : null,
        lastError: done
          ? null
          : input.final
            ? `${refused.length} files could not be synced.`
            : null,
      });

      return { applied, deleted, conflictsRecorded, refused, sync };
    });

  return {
    getStatus,
    start,
    pause,
    stop,
    listConflicts,
    resolveConflict,
    planPass,
    commitPass,
    requireProjectAccess,
  } satisfies CloudSyncServiceShape;
});

export const CloudSyncServiceLive: Layer.Layer<
  CloudSyncService,
  never,
  CloudSyncRepository | CollaborationService | ProjectionProjectRepository | ServerConfig
> = Layer.effect(CloudSyncService, makeCloudSyncService);
