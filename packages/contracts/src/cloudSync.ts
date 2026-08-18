import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TenantId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas.ts";

/**
 * Syncing a project between a laptop and a cloud copy.
 *
 * `docs/cloud-sync-spec.md` is the contract and this file is its type-level
 * half; where the two disagree the document wins. The single rule it exists to
 * enforce — *a sync never destroys work* — is what shapes the schemas here, and
 * two consequences are worth naming before anything else:
 *
 * Agreement is a content hash, never a clock. A laptop and a server disagree
 * about the time by seconds at least, so "whose write was later" is a guess,
 * and a wrong guess silently deletes the loser's morning. Every decision is
 * made against a *base revision* — the hash both sides last agreed on for a
 * path — which is why `CloudSyncFile` is the load-bearing type in this file and
 * `ProjectCloudSync` is only a progress bar.
 *
 * Resolving a conflict is never a choice between two versions. Both survive;
 * `CloudSyncConflict` records where the second one was put, and nothing in this
 * contract offers a "keep mine" flag, because such a flag is a delete with
 * better manners.
 */

/**
 * Branded here rather than in `baseSchemas.ts` for the reason `ShareLinkId`
 * gives: this id never leaves this exchange.
 */
export const CloudSyncConflictId = TrimmedNonEmptyString.pipe(Schema.brand("CloudSyncConflictId"));
export type CloudSyncConflictId = typeof CloudSyncConflictId.Type;

/**
 * A content hash, branded apart from every other string so that a path can
 * never be passed where a hash is wanted. The two are both project-relative
 * strings of similar length, and confusing them would make every comparison in
 * the reconciler return "unchanged" — a silent no-op sync, the hardest kind of
 * failure to notice.
 */
export const CloudSyncHash = TrimmedNonEmptyString.pipe(Schema.brand("CloudSyncHash"));
export type CloudSyncHash = typeof CloudSyncHash.Type;

const CLOUD_SYNC_PATH_MAX_LENGTH = 1024;

/**
 * A project-relative path.
 *
 * Deliberately not `TrimmedNonEmptyString`, which every other path-ish field in
 * this package uses. Trim rewrites its input, and a rewritten path is a file
 * written somewhere other than where it came from — on macOS and Linux a
 * trailing space is a legal, ordinary part of a filename. Under rule 1 a sync
 * that refuses a path is a nuisance and a sync that relocates one is data loss,
 * so this validates and never edits.
 */
export const CloudSyncPath = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(CLOUD_SYNC_PATH_MAX_LENGTH),
);
export type CloudSyncPath = typeof CloudSyncPath.Type;

/**
 * Which bargain the person struck, chosen once when they first share a project.
 *
 * Two literals rather than a `continuous` boolean, because these are not one
 * mechanism with a switch. `handoff` makes the cloud canonical and stops
 * watching the laptop; `mirror` replicates both ways forever. A boolean would
 * let a flip of one bit change which copy is authoritative, and that is the
 * decision the whole feature turns on.
 *
 * Neither mode ever deletes the local directory. "Move it to the cloud" is
 * product wording for `handoff`, not an `mv`.
 */
export const CloudSyncMode = Schema.Literals(["handoff", "mirror"]);
export type CloudSyncMode = typeof CloudSyncMode.Type;

/**
 * What the sync is doing right now.
 *
 * `scanning` and `transferring` are separate because they fail differently and
 * a person reads them differently: a scan that takes a minute on a large tree
 * is normal, a transfer stuck at the same byte for a minute is not.
 *
 * `paused` is a state and not the absence of one — stopping a mirror leaves
 * both copies intact and diverging, and the UI has to be able to say that
 * rather than showing an idle sync that is quietly no longer running.
 */
export const CloudSyncStatus = Schema.Literals([
  "idle",
  "scanning",
  "transferring",
  "paused",
  "error",
]);
export type CloudSyncStatus = typeof CloudSyncStatus.Type;

/**
 * One project's sync, and everything the sync button needs to render.
 *
 * `filesTotal`, `filesDone`, `bytesTotal` and `bytesDone` describe **the
 * current pass only**. They are reset the moment a pass begins, and they are
 * not lifetime totals: after two passes over a hundred files, `filesDone` is at
 * most a hundred, never two hundred. A counter that only ever climbs makes a
 * progress bar that can never reach its end, and someone will spend an hour
 * looking for the leak.
 *
 * `lastAgreedAt` is the durable one. It survives every pass, and it is the only
 * field that answers the question a person actually asks — "is my work
 * safe?" — so nothing short of a completed agreement moves it.
 *
 * `activelyChanging` exists to stop a true statement from reading as a bug. A
 * mirror over a tree someone is typing into will not converge, and without this
 * flag the UI has no way to distinguish "still working, because you are still
 * working" from "stuck".
 */
export const ProjectCloudSync = Schema.Struct({
  projectId: ProjectId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  mode: CloudSyncMode,
  status: CloudSyncStatus,
  /** Null until the two sides have agreed in full even once. */
  lastAgreedAt: Schema.NullOr(IsoDateTime),
  /** Set with `status: "error"`, and cleared by the next pass that gets past it. */
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  /** Current pass only. See the note above before treating any of these four as a running total. */
  filesTotal: NonNegativeInt,
  filesDone: NonNegativeInt,
  bytesTotal: NonNegativeInt,
  bytesDone: NonNegativeInt,
  /** A write seen in the last few seconds. Why a sync can be busy and healthy at once. */
  activelyChanging: Schema.Boolean,
  /** Conflicts still waiting on a person. Resolved ones are not counted. */
  conflictCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectCloudSync = typeof ProjectCloudSync.Type;

/**
 * The base revision for one path: what both sides last agreed this file was.
 *
 * This is the heart of the feature. For every path the reconciler compares
 * three things — local, remote, and this — and the whole table of outcomes in
 * the spec is written in terms of that comparison. Without a base, "both sides
 * differ" is unanswerable and the only remaining tiebreak is a clock.
 *
 * `deletedAt` is not an internal detail and must never be collapsed into a
 * missing row. The reconciler reads three distinct states per path:
 *
 *   - a row with `deletedAt` null — we agreed on this content;
 *   - a row with `deletedAt` set — we agreed this path is *gone*;
 *   - no row at all — we have never seen this path.
 *
 * The last two look identical from a distance and behave oppositely. A file the
 * server has never seen is never removed, whatever its index says (rule 4);
 * a file both sides agreed to delete may be. Merge them and the first sync
 * after a reinstall deletes a project.
 *
 * `hash` stays populated on a tombstone, holding the content that was agreed
 * before the agreed deletion. That is what makes "an edit beats a delete"
 * (rule 3) resolvable later without a second table, and it is why this field is
 * not nullable.
 */
export const CloudSyncFile = Schema.Struct({
  projectId: ProjectId,
  path: CloudSyncPath,
  /** The agreed content hash. On a tombstone, the content agreed before it went. */
  hash: CloudSyncHash,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
  /** Set means "both sides agreed this path is gone" — categorically not "unknown". */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type CloudSyncFile = typeof CloudSyncFile.Type;

/**
 * One path where both sides changed to different content.
 *
 * There is no winner field, and adding one would be a bug. The remote version
 * keeps the path so that collaborators in the browser stay consistent with each
 * other, and the local divergent version is written beside it at
 * `conflictedCopyPath` — never overwritten, never tidied away on a schedule.
 *
 * `resolvedAt` means a person dealt with it, not that the system picked
 * something. It exists so the badge can stop nagging while the row survives for
 * anyone asking later what happened to their file.
 */
export const CloudSyncConflict = Schema.Struct({
  id: CloudSyncConflictId,
  projectId: ProjectId,
  /** The path that stayed canonical, holding the remote version. */
  path: CloudSyncPath,
  /** Where the local version was kept: `<name> (conflicted copy <ISO date>)<ext>`. */
  conflictedCopyPath: CloudSyncPath,
  detectedAt: IsoDateTime,
  /** Null while it still needs a person. */
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type CloudSyncConflict = typeof CloudSyncConflict.Type;

/**
 * `not-found` is "this project has no sync", which is what `pause`, `stop` and
 * `status.get` hit on a project nobody ever shared. `conflict-not-found` is a
 * conflict id that matches nothing, kept separate because the caller's next
 * move differs entirely: one means start a sync, the other means the list on
 * screen is stale and should be refetched.
 *
 * `mode-locked` refuses to reinterpret a running sync. Switching `handoff` to
 * `mirror` in place would change which copy is canonical underneath a transfer
 * already in flight, so the change has to be `stop` and then `start` — two
 * calls, and a moment where the UI can say what is about to happen.
 */
export class CloudSyncError extends Schema.TaggedErrorClass<CloudSyncError>()("CloudSyncError", {
  message: TrimmedNonEmptyString,
  code: Schema.Literals([
    "forbidden",
    "not-found",
    /** No such conflict — usually a list the person is looking at has gone stale. */
    "conflict-not-found",
    /** Changing mode means stopping first; see above. */
    "mode-locked",
    /** The store refused the write. Never reported as a completed sync. */
    "storage",
  ]),
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * Every call carries the tenant and workspace beside the project. The project
 * id alone would be enough to find the row and is not enough to prove the
 * caller may see it — and this feature moves whole trees between machines, so a
 * mis-scoped read is the expensive kind.
 */
const CloudSyncProjectScope = {
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
};

export const CloudSyncStatusGetInput = Schema.Struct(CloudSyncProjectScope);
export type CloudSyncStatusGetInput = typeof CloudSyncStatusGetInput.Type;

/**
 * `sync` is nullable rather than the call failing with `not-found`. "This
 * project has never been synced" is the ordinary first answer for every project
 * in the list, and a panel that has to catch an error to render its default
 * state will eventually render an error instead.
 */
export const CloudSyncStatusResult = Schema.Struct({
  sync: Schema.NullOr(ProjectCloudSync),
});
export type CloudSyncStatusResult = typeof CloudSyncStatusResult.Type;

/**
 * The mode is required and has no default. This is the one question the person
 * is asked, the two answers differ in which copy becomes canonical, and a
 * default here would answer it on their behalf.
 */
export const CloudSyncStartInput = Schema.Struct({
  ...CloudSyncProjectScope,
  mode: CloudSyncMode,
});
export type CloudSyncStartInput = typeof CloudSyncStartInput.Type;

/** The started sync, so the caller renders from the reply rather than refetching. */
export const CloudSyncStartResult = Schema.Struct({
  sync: ProjectCloudSync,
});
export type CloudSyncStartResult = typeof CloudSyncStartResult.Type;

export const CloudSyncPauseInput = Schema.Struct(CloudSyncProjectScope);
export type CloudSyncPauseInput = typeof CloudSyncPauseInput.Type;

export const CloudSyncPauseResult = Schema.Struct({
  sync: ProjectCloudSync,
});
export type CloudSyncPauseResult = typeof CloudSyncPauseResult.Type;

export const CloudSyncStopInput = Schema.Struct(CloudSyncProjectScope);
export type CloudSyncStopInput = typeof CloudSyncStopInput.Type;

/**
 * Stopping returns the final row rather than nothing. Both copies survive a
 * stop and start diverging from that moment, and the timestamp on this row is
 * how the UI can later say when they parted company.
 */
export const CloudSyncStopResult = Schema.Struct({
  sync: ProjectCloudSync,
});
export type CloudSyncStopResult = typeof CloudSyncStopResult.Type;

const CLOUD_SYNC_CONFLICTS_MAX_LIMIT = 200;

/**
 * Two people editing one mirrored project offline pile conflicted copies up, so
 * this list is bounded and paged from the start. `afterId` is a keyset cursor
 * over the same order the rows come back in, not an offset: an offset re-reads
 * everything it skips, and it silently repeats or drops rows when a new
 * conflict is detected between two pages — which, in a list of things that are
 * appearing right now, is the normal case rather than the edge one.
 */
export const CloudSyncConflictListInput = Schema.Struct({
  ...CloudSyncProjectScope,
  /** Default is open conflicts only: what still needs a person. */
  includeResolved: Schema.optional(Schema.Boolean),
  afterId: Schema.optional(CloudSyncConflictId),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(CLOUD_SYNC_CONFLICTS_MAX_LIMIT)),
  ),
});
export type CloudSyncConflictListInput = typeof CloudSyncConflictListInput.Type;

/**
 * `nextCursor` rather than a total. Counting every conflict to render "page 3
 * of 40" costs a full scan of a table that only ever grows, and the badge on
 * the sync button already has the number that matters — `conflictCount`, which
 * the store keeps as a running summary.
 */
export const CloudSyncConflictListResult = Schema.Struct({
  conflicts: Schema.Array(CloudSyncConflict),
  /** Null when this page is the last one. */
  nextCursor: Schema.NullOr(CloudSyncConflictId),
});
export type CloudSyncConflictListResult = typeof CloudSyncConflictListResult.Type;

/**
 * No `keep: "local" | "remote"`. Both versions are already on disk by the time
 * a conflict is listed, and this call only records that a person has dealt with
 * it. Accepting a side here would make the server delete one of two files it
 * was asked to preserve, which is the exact failure the whole feature is built
 * to avoid.
 */
export const CloudSyncConflictResolveInput = Schema.Struct({
  ...CloudSyncProjectScope,
  conflictId: CloudSyncConflictId,
});
export type CloudSyncConflictResolveInput = typeof CloudSyncConflictResolveInput.Type;

/**
 * The resolved conflict and the sync it belongs to, because resolving one
 * changes the badge as well as the row, and returning both saves the panel a
 * second call it would otherwise make against a count that had already moved.
 */
export const CloudSyncConflictResolveResult = Schema.Struct({
  conflict: CloudSyncConflict,
  sync: ProjectCloudSync,
});
export type CloudSyncConflictResolveResult = typeof CloudSyncConflictResolveResult.Type;
