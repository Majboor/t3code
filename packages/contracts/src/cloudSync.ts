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
 * How often the laptop is expected to say "still here", and how long that
 * statement is believed afterwards.
 *
 * A quick tunnel dies without telling anyone — a closed lid, a dropped Wi-Fi
 * connection, a `cloudflared` that was killed — so a registered address is only
 * ever a claim about the past. Rather than trusting it, the laptop re-states it
 * on a heartbeat and the cloud stops believing it after three missed beats.
 *
 * Ninety seconds, and not less, because the two ways of being wrong are not
 * symmetrical. Believing a dead address for a minute costs a visitor one click
 * that fails loudly and instantly, and they are still on the cloud page that
 * offered it. Disbelieving a live one tells them "the person sharing this closed
 * their laptop", which is the sentence that makes somebody give up and go away —
 * and a single garbage-collection pause or a train tunnel would trigger it.
 * Three intervals is the ordinary "missed one, missed two, now I believe it".
 *
 * Ninety seconds, and not more, because the same clock answers "the laptop went
 * away mid-sync". Every second added here is a second spent telling a visitor a
 * transfer is still running when the machine behind it shut hours ago.
 */
export const CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS = 30_000;
export const CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS = 3 * CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS;

const CLOUD_SYNC_COPY_URL_MAX_LENGTH = 512;

/**
 * An address a visitor's browser will be sent to: a quick tunnel's, or the
 * cloud's own.
 *
 * Both ends of the handoff are checked against this. One of them is registered
 * by whichever machine holds the local copy and the other is registered by
 * whichever machine finished a pass, so in both directions this is a URL that
 * arrived over the wire and will end up in a `Location` header. `javascript:`,
 * `data:` and a URL carrying `user:password@` are all refused here rather than
 * at the point of use, because the point of use is a redirect.
 *
 * Plain `http` survives only for a loopback host, which is what a developer's
 * cloud is. Everything reachable by anyone else has to be `https`, since the
 * whole exchange is a private project moving between two machines.
 */
export const CloudSyncCopyUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CLOUD_SYNC_COPY_URL_MAX_LENGTH),
);
export type CloudSyncCopyUrl = typeof CloudSyncCopyUrl.Type;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function isSafeCloudSyncCopyUrl(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > CLOUD_SYNC_COPY_URL_MAX_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  // Credentials in a redirect target are how a link that looks like ours signs
  // a visitor in to somewhere else.
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/**
 * Where a live copy of this project is reachable right now, and when the machine
 * holding it last said so.
 *
 * Advisory and perishable, and it is never the identity of anything. The link a
 * person hands out is always the cloud URL; this is transport that happens to be
 * ready sooner. `confirmedAt` is what makes it safe to hold at all — see the
 * heartbeat constants above — and a reader that ignores it is handing visitors
 * an address that may have died with a laptop lid.
 */
export const CloudSyncLiveCopy = Schema.Struct({
  url: CloudSyncCopyUrl,
  /** The last heartbeat. Older than `staleAfterMs` means there is no live copy. */
  confirmedAt: IsoDateTime,
  /** Carried so a client counts down against the server's rule rather than its own. */
  staleAfterMs: NonNegativeInt,
});
export type CloudSyncLiveCopy = typeof CloudSyncLiveCopy.Type;

/**
 * Whether the machine holding the local copy is still answering, and if so
 * whether it is publishing one.
 *
 * `confirmedAt` is stamped by every heartbeat, including a heartbeat that
 * carries no URL. That is deliberate and it is the whole reason "still
 * uploading" and "the person sharing this closed their laptop" can be told apart
 * from the data: without it, a sync with no tunnel and a sync whose laptop shut
 * look identical, and the spec requires different advice for each.
 */
export function isLiveCopyFresh(confirmedAt: string | null, now: Date): boolean {
  if (confirmedAt === null) {
    return false;
  }
  const at = Date.parse(confirmedAt);
  if (Number.isNaN(at)) {
    return false;
  }
  // A timestamp from the future is a clock disagreement, not a dead laptop, and
  // this whole feature refuses to settle anything by comparing two clocks.
  return now.getTime() - at <= CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS;
}

/**
 * What a visitor arriving at the cloud URL should be shown. The spec's four
 * cases, plus the one that precedes all of them.
 *
 * These say what a visitor can *do*, which is why they are not the sync's
 * `status`: `scanning`, `transferring` and a `paused` first pass all leave the
 * same two options open — wait, or go through to the live copy — and the reason
 * the bar is not moving belongs in `sync`, which travels alongside.
 *
 * `sharer-away` is the one that has to be earned rather than guessed. It means
 * the heartbeat stopped, and nothing else: a first pass that is genuinely slow
 * over a slow link keeps saying so, and never degrades into this.
 */
export const CloudSyncVisitorState = Schema.Literals([
  /** This project has no sync at all. Nothing was ever uploaded and nothing is coming. */
  "not-syncing",
  /** First pass running, laptop answering, no live copy to offer. */
  "first-pass",
  /** First pass running, and a live copy a visitor can be sent straight through to. */
  "first-pass-live",
  /** First pass never finished and the laptop stopped answering. */
  "sharer-away",
  /** The two sides have agreed at least once: the cloud copy is canonical, serve from here. */
  "synced",
]);
export type CloudSyncVisitorState = typeof CloudSyncVisitorState.Type;

/**
 * `turnsAllowed` is stated rather than derived, because the spec's requirement —
 * refuse turns until the first pass completes — is one rule, and a rule
 * re-derived in every client is a rule that will eventually be derived wrongly
 * in one of them. An agent let loose on a half-uploaded tree reads a truncated
 * file, decides the code is broken, and confidently "fixes" it.
 */
export const CloudSyncVisitorView = Schema.Struct({
  state: CloudSyncVisitorState,
  /** Null only for `not-syncing`. Carries the progress bar and the reason it is stuck. */
  sync: Schema.NullOr(ProjectCloudSync),
  /**
   * Set only in `first-pass-live`. A stale registration is not reported as an
   * old address — it is reported as no address, because the two are the same
   * thing to anyone who would click it.
   */
  liveCopy: Schema.NullOr(CloudSyncLiveCopy),
  /** False until the first full agreement. See above; this is the spec's rule, not a hint. */
  turnsAllowed: Schema.Boolean,
});
export type CloudSyncVisitorView = typeof CloudSyncVisitorView.Type;

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
    /**
     * An address that will not be redirected to: not `https` (nor loopback),
     * or carrying credentials. Refused at the door rather than stored, because
     * a stored one is a `Location` header waiting to happen.
     */
    "unusable-url",
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

/**
 * "A live copy of this project is reachable at <url>, as of now."
 *
 * A null `url` is not a no-op and not a mistake: it is the laptop saying "I am
 * still here, there is nothing to publish". Sharing must work with no
 * `cloudflared` installed and behind an auth policy the tunnel refuses to
 * publish, and in both of those cases the sync goes ahead — so the heartbeat has
 * to be able to carry the absence of a live copy as easily as its presence.
 * Sending null is also how a laptop withdraws an address it is about to stop
 * serving.
 */
export const CloudSyncLiveCopyRegisterInput = Schema.Struct({
  ...CloudSyncProjectScope,
  url: Schema.NullOr(CloudSyncCopyUrl),
});
export type CloudSyncLiveCopyRegisterInput = typeof CloudSyncLiveCopyRegisterInput.Type;

/**
 * The sync comes back with every heartbeat, which is what tells the laptop the
 * first pass completed without a second call — and tells it even when the pass
 * was finished by something other than the process holding the tunnel.
 */
export const CloudSyncLiveCopyRegisterResult = Schema.Struct({
  sync: ProjectCloudSync,
  /** What the cloud will now hand to visitors, after applying the staleness rule. */
  liveCopy: Schema.NullOr(CloudSyncLiveCopy),
});
export type CloudSyncLiveCopyRegisterResult = typeof CloudSyncLiveCopyRegisterResult.Type;

export const CloudSyncVisitInput = Schema.Struct(CloudSyncProjectScope);
export type CloudSyncVisitInput = typeof CloudSyncVisitInput.Type;

/**
 * "This project's canonical copy is at <url>; send anyone who lands here on."
 *
 * Registered by the laptop *against its own server* once the first pass
 * completes, which is the mirror image of the call above and the reason both
 * exist. The tunnel published this machine, so this machine is the only one that
 * can catch a visitor still sitting on it — and the address it sends them to was
 * always the one in their inbox.
 */
export const CloudSyncHandoffRegisterInput = Schema.Struct({
  ...CloudSyncProjectScope,
  canonicalUrl: CloudSyncCopyUrl,
});
export type CloudSyncHandoffRegisterInput = typeof CloudSyncHandoffRegisterInput.Type;
