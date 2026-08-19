import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * Storage for syncing a project to the cloud.
 *
 * Records are primitives only, deliberately — the same reasoning as
 * `Services/ShareLinks.ts` and `Services/ProviderSharing.ts`.
 * `@t3tools/contracts` brands the ids and narrows `mode` and `status` to
 * literal unions; reaching for those here would make the repository refuse to
 * load a row written by a build that knew a status this one does not, and a
 * decode failure on read is worse than a mismatch above. In this feature it is
 * worse still than usual: the row that fails to decode is the one holding
 * `lastAgreedAt`, so the panel would lose the only evidence a person's work
 * ever reached the server. The service maps and validates; storage stays dumb.
 *
 * The base-revision table is the heart of this. `listBaseFiles` is the read
 * every reconciliation pass makes over an entire project tree, and
 * `putBaseFiles` is how a pass writes its results back, which is why it takes a
 * batch: a project of twenty thousand files is the design point, and twenty
 * thousand round trips is not a slow implementation, it is a different one.
 */

/**
 * One project's sync.
 *
 * `filesTotal`, `filesDone`, `bytesTotal` and `bytesDone` are the current pass
 * and nothing else — see migration 054 and the note on `updateProgress`.
 * `lastAgreedAt` and `conflictCount` outlive a pass.
 */
export interface ProjectCloudSyncRecord {
  readonly projectId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  /** "handoff" | "mirror" — validated above this layer. */
  readonly mode: string;
  /** "idle" | "scanning" | "transferring" | "paused" | "error". */
  readonly status: string;
  /** Null until the two sides have agreed in full even once. */
  readonly lastAgreedAt: string | null;
  readonly lastError: string | null;
  /** Current pass only. Not a lifetime total, and may go down between passes. */
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly bytesTotal: number;
  readonly bytesDone: number;
  /** A write seen in the last few seconds. */
  readonly activelyChanging: boolean;
  /** Open conflicts only; the resolved ones are not counted. */
  readonly conflictCount: number;
  /**
   * Where a live copy of this project is reachable right now, if anywhere.
   * Advisory, perishable, and never an identity — read it only together with
   * the timestamp below.
   */
  readonly liveCopyUrl: string | null;
  /**
   * When the machine holding the local copy last spoke for this sync, with or
   * without a live copy to publish. Two questions, one clock: whether the
   * address above can still be offered, and whether the person sharing this
   * closed their laptop mid-pass.
   */
  readonly laptopConfirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The base revision for one path: what both sides last agreed this file was.
 *
 * `deletedAt` set means "we agreed this path is gone". The absence of a record
 * entirely means "we have never seen this path", and the two are not the same —
 * a path the server has never seen is never removed, whatever its index says.
 * `hash` is populated even on a tombstone, holding what the content was before
 * the agreed deletion.
 */
export interface CloudSyncFileRecord {
  readonly projectId: string;
  readonly path: string;
  readonly hash: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** One path where both sides changed to different content. Both versions survive. */
export interface CloudSyncConflictRecord {
  readonly conflictId: string;
  readonly projectId: string;
  /** The canonical path, holding the remote version. */
  readonly path: string;
  /** Where the local version was kept instead of being discarded. */
  readonly conflictedCopyPath: string;
  readonly detectedAt: string;
  /** Null while it still needs a person. */
  readonly resolvedAt: string | null;
}

/**
 * Beginning a sync, or restarting one. `createdAt` is only used when the row is
 * new; a restart keeps the original, so the panel can go on saying when this
 * project was first shared.
 *
 * This is also where the per-pass counters reset, and the only place they do so
 * implicitly — see the shape below.
 */
export const UpsertProjectCloudSyncInput = Schema.Struct({
  projectId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  mode: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type UpsertProjectCloudSyncInput = typeof UpsertProjectCloudSyncInput.Type;

/**
 * Tenant and workspace travel with the project id on every read and write, so
 * that storage is incapable of honouring a mismatch even if an id were guessed.
 * The service checks membership first; this is the cheap second lock, and this
 * feature moves whole trees between machines, so a mis-scoped read is the
 * expensive kind.
 */
export const GetProjectCloudSyncInput = Schema.Struct({
  projectId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type GetProjectCloudSyncInput = typeof GetProjectCloudSyncInput.Type;

export const ListProjectCloudSyncsForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListProjectCloudSyncsForWorkspaceInput =
  typeof ListProjectCloudSyncsForWorkspaceInput.Type;

/**
 * Every field but `projectId` and `updatedAt` is nullable, and null means
 * "leave this alone" rather than "set it to nothing". Pausing sends a status
 * and nulls, and must not zero a half-finished pass that is about to resume;
 * a pass starting sends real numbers, including an explicit 0 where it wants a
 * reset. There is one exception, called out below, and it is deliberate.
 */
export const UpdateCloudSyncProgressInput = Schema.Struct({
  projectId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  status: Schema.NullOr(Schema.String),
  filesTotal: Schema.NullOr(Schema.Int),
  filesDone: Schema.NullOr(Schema.Int),
  bytesTotal: Schema.NullOr(Schema.Int),
  bytesDone: Schema.NullOr(Schema.Int),
  activelyChanging: Schema.NullOr(Schema.Boolean),
  /**
   * Advances only. Null means "no new agreement", never "forget the last one" —
   * a routine progress tick must not be able to erase the fact that a person's
   * work reached the server, which is the single question this column answers.
   */
  lastAgreedAt: Schema.NullOr(Schema.String),
  /**
   * The exception: written every time, so null really does clear it. A message
   * that survives the failure it describes is how a sync that is working again
   * stays red forever, and this is the only call that can say "not any more".
   */
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type UpdateCloudSyncProgressInput = typeof UpdateCloudSyncProgressInput.Type;

/**
 * One heartbeat from the machine holding the local copy.
 *
 * `liveCopyUrl` is written outright rather than coalesced, so null really does
 * clear it — the opposite of the progress fields above and for the opposite
 * reason. A progress tick must not erase a half-finished pass; an address that
 * has stopped working must be erasable the moment its owner says so, because
 * every second it survives is a second a visitor is sent somewhere dead.
 *
 * `confirmedAt` is stamped on every call including one carrying no URL. See the
 * record above: it is the only thing that distinguishes a sync with no tunnel
 * from a sync whose laptop went away.
 */
export const RegisterCloudSyncLiveCopyInput = Schema.Struct({
  projectId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  liveCopyUrl: Schema.NullOr(Schema.String),
  confirmedAt: Schema.String,
});
export type RegisterCloudSyncLiveCopyInput = typeof RegisterCloudSyncLiveCopyInput.Type;

/** One base revision on its way in. A tombstone is this with `deletedAt` set. */
export const CloudSyncBaseFileInput = Schema.Struct({
  path: Schema.String,
  hash: Schema.String,
  sizeBytes: Schema.Int,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type CloudSyncBaseFileInput = typeof CloudSyncBaseFileInput.Type;

/**
 * A whole pass's worth of agreements at once. The array is the point: a
 * reconciler that has just walked twenty thousand paths has twenty thousand
 * results, and handing them over one at a time would spend the entire pass in
 * statement overhead.
 */
export const PutCloudSyncBaseFilesInput = Schema.Struct({
  projectId: Schema.String,
  files: Schema.Array(CloudSyncBaseFileInput),
});
export type PutCloudSyncBaseFilesInput = typeof PutCloudSyncBaseFilesInput.Type;

/**
 * Paged by `afterPath`, a keyset cursor, and not by an offset. Two reasons and
 * both bite at this size: an offset re-walks every row it skips, turning one
 * pass over a large tree into a quadratic one; and it silently repeats or drops
 * rows when the set shifts under it, which in a table being written by the pass
 * that is reading it is the normal case.
 *
 * `limit` is required rather than defaulted, for the reason
 * `ListShareLinkViewsInput` gives: the bound belongs where someone can see it.
 */
export const ListCloudSyncBaseFilesInput = Schema.Struct({
  projectId: Schema.String,
  /** Exclusive, in the `path ASC` order the rows come back in. Null starts at the beginning. */
  afterPath: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});
export type ListCloudSyncBaseFilesInput = typeof ListCloudSyncBaseFilesInput.Type;

/**
 * Forgets a base row entirely, which is *not* how a deletion is agreed. This
 * says "we have never seen this path" and puts the reconciler back to treating
 * it as new; a tombstone — `putBaseFiles` with `deletedAt` set — says "we
 * agreed it is gone". Reaching for this one when the other was meant is how a
 * deleted file comes back on the next pass.
 */
export const DeleteCloudSyncBaseFileInput = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
});
export type DeleteCloudSyncBaseFileInput = typeof DeleteCloudSyncBaseFileInput.Type;

/**
 * No winner field, here or anywhere else. Both versions are already on disk by
 * the time this is written; the row records where the second one was put.
 */
export const RecordCloudSyncConflictInput = Schema.Struct({
  conflictId: Schema.String,
  projectId: Schema.String,
  path: Schema.String,
  conflictedCopyPath: Schema.String,
  detectedAt: Schema.String,
});
export type RecordCloudSyncConflictInput = typeof RecordCloudSyncConflictInput.Type;

export const ListCloudSyncConflictsInput = Schema.Struct({
  projectId: Schema.String,
  /** False lists only what still needs a person, which is what the badge counts. */
  includeResolved: Schema.Boolean,
  /** Exclusive keyset cursor, in the `detected_at ASC, conflict_id ASC` order returned. */
  afterId: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});
export type ListCloudSyncConflictsInput = typeof ListCloudSyncConflictsInput.Type;

export const ResolveCloudSyncConflictInput = Schema.Struct({
  conflictId: Schema.String,
  projectId: Schema.String,
  resolvedAt: Schema.String,
});
export type ResolveCloudSyncConflictInput = typeof ResolveCloudSyncConflictInput.Type;

export interface CloudSyncRepositoryShape {
  /**
   * Begins a sync, or begins a new pass on one that exists. `created_at` and
   * `last_agreed_at` and `conflict_count` survive; the four per-pass counters
   * are reset to zero and `last_error` is cleared, because this call is exactly
   * the moment a new pass starts and a progress bar carried over from the last
   * one is the bug this feature will otherwise ship with.
   */
  readonly upsertProjectSync: (
    input: UpsertProjectCloudSyncInput,
  ) => Effect.Effect<ProjectCloudSyncRecord, PersistenceSqlError>;
  /** `none` means this project has never been synced, which is the ordinary first answer. */
  readonly getProjectSync: (
    input: GetProjectCloudSyncInput,
  ) => Effect.Effect<Option.Option<ProjectCloudSyncRecord>, PersistenceSqlError>;
  readonly listProjectSyncsForWorkspace: (
    input: ListProjectCloudSyncsForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<ProjectCloudSyncRecord>, PersistenceSqlError>;
  /**
   * Writes a batch of base revisions in one transaction, so that a pass either
   * advances the agreement or does not. A half-written base is worse than none:
   * the next pass would read a mixture of two agreements and conclude that
   * files nobody touched had changed on both sides.
   *
   * Returns the number of rows written, which the caller compares with what it
   * sent rather than assuming.
   */
  readonly putBaseFiles: (
    input: PutCloudSyncBaseFilesInput,
  ) => Effect.Effect<number, PersistenceSqlError>;
  /**
   * One page of a project's base revisions in `path ASC` order, served by the
   * primary key. Tombstones are included and must be: the reconciler needs
   * "we agreed this is gone" and cannot infer it from a row that is not there.
   */
  readonly listBaseFiles: (
    input: ListCloudSyncBaseFilesInput,
  ) => Effect.Effect<ReadonlyArray<CloudSyncFileRecord>, PersistenceSqlError>;
  /** Forgets a path was ever agreed. Not a deletion — see the input for the difference. */
  readonly deleteBaseFile: (
    input: DeleteCloudSyncBaseFileInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  /**
   * Appends a conflict and bumps the project's open count, in one transaction
   * so the badge and the list cannot disagree. `none` means the project has no
   * sync row, in which case nothing at all is written: a conflict counted
   * against a sync that does not exist is a badge nobody can ever clear.
   */
  readonly recordConflict: (
    input: RecordCloudSyncConflictInput,
  ) => Effect.Effect<Option.Option<CloudSyncConflictRecord>, PersistenceSqlError>;
  readonly listConflicts: (
    input: ListCloudSyncConflictsInput,
  ) => Effect.Effect<ReadonlyArray<CloudSyncConflictRecord>, PersistenceSqlError>;
  /**
   * Marks a conflict dealt with and decrements the open count, in one
   * transaction. `alreadyResolved` says whether this call is what closed it, so
   * that a double click cannot take the count down twice — the same problem
   * `revokeLink` solves, and for the same reason timestamps cannot solve it.
   *
   * `none` means no such conflict in this project.
   */
  readonly resolveConflict: (input: ResolveCloudSyncConflictInput) => Effect.Effect<
    Option.Option<{
      readonly record: CloudSyncConflictRecord;
      readonly alreadyResolved: boolean;
      readonly sync: ProjectCloudSyncRecord | null;
    }>,
    PersistenceSqlError
  >;
  /**
   * Moves the progress bar, the status, or both. An UPDATE and never an upsert:
   * a progress report for a project with no sync row means the caller is
   * reporting on something it never started, and inventing a row here would
   * fabricate a `mode` — the field that decides which copy is canonical.
   */
  readonly updateProgress: (
    input: UpdateCloudSyncProgressInput,
  ) => Effect.Effect<Option.Option<ProjectCloudSyncRecord>, PersistenceSqlError>;
  /**
   * Records that the laptop is still there, and where its live copy is if it
   * has one. An UPDATE and never an upsert, for `updateProgress`'s reason: a
   * heartbeat for a project with no sync row is a machine reporting on
   * something it never started, and a row invented here would have to invent a
   * `mode` — the field that decides which copy is canonical.
   */
  readonly registerLiveCopy: (
    input: RegisterCloudSyncLiveCopyInput,
  ) => Effect.Effect<Option.Option<ProjectCloudSyncRecord>, PersistenceSqlError>;
}

export class CloudSyncRepository extends Context.Service<
  CloudSyncRepository,
  CloudSyncRepositoryShape
>()("t3/persistence/Services/CloudSync/CloudSyncRepository") {}
