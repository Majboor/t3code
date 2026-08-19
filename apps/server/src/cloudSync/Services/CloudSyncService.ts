import type {
  CloudSyncConflictListInput,
  CloudSyncConflictListResult,
  CloudSyncConflictResolveInput,
  CloudSyncConflictResolveResult,
  CloudSyncError,
  CloudSyncLiveCopyRegisterInput,
  CloudSyncLiveCopyRegisterResult,
  CloudSyncMode,
  CloudSyncPauseInput,
  CloudSyncPauseResult,
  CloudSyncStartInput,
  CloudSyncStartResult,
  CloudSyncStatusGetInput,
  CloudSyncStatusResult,
  CloudSyncStopInput,
  CloudSyncStopResult,
  CloudSyncVisitInput,
  CloudSyncVisitorView,
  ProjectCloudSync,
  ProjectId,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

/**
 * Replicating a project on someone's laptop to a cloud copy collaborators can
 * work on in the browser.
 *
 * `docs/cloud-sync-spec.md` is the contract, and its one rule — *a sync never
 * destroys work* — is why this service is shaped the way it is. Two things in
 * particular are worth reading before anything else here makes sense:
 *
 * The decision about what happens to a path is not made here. It is made by
 * `@t3tools/shared/cloudSync/reconcile`, which is pure, total and tested on its
 * own; this service supplies the three sides it compares and honours the two
 * obligations that a pure function cannot enforce — it refuses a pass whose
 * deletions are implausible (spec obligation 1), and it does not run mirror
 * reconciliation for a `handoff` at all (obligation 4).
 *
 * Nothing here touches the laptop. The local half of a pass — moving a local
 * file aside before writing the remote one, disambiguating a conflicted copy
 * name that already exists — belongs to whatever is holding that disk, and this
 * service names both paths so it can be done in the right order.
 */

/**
 * Whoever is starting, pausing or reading a sync.
 *
 * Structurally the collaboration actor, as `ShareLinkActor` is and for the same
 * reason: membership is read from the collaboration roster, so the same person
 * has to be recognisable to both. Nothing here comes off the wire — the
 * caller's identity comes from the session, which is what stops "sync this
 * project" from being a claim anyone can make about any project.
 */
export interface CloudSyncActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

/**
 * Tenant and workspace travel with the project on every call. A project id is
 * enough to find a row and is not enough to prove the caller may see it, and
 * this feature moves whole trees between machines, so a mis-scoped read is the
 * expensive kind.
 */
export interface CloudSyncProjectScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
}

/** One path with the hash of its content. Sizes are for the progress bar only. */
export interface CloudSyncEntry {
  readonly path: string;
  readonly hash: string;
  readonly sizeBytes: number;
}

/** A path this pass will not carry, and the reason, so nothing is skipped silently. */
export interface CloudSyncRefusedPath {
  readonly path: string;
  readonly reason:
    /** `.git`, `node_modules`, `.DS_Store` and friends — see the spec's exclusions. */
    | "excluded"
    /** Absolute, escaping the project root, or a symlink. Never followed. */
    | "unsafe-path"
    /** Over the per-file ceiling. */
    | "too-large"
    /** Agreed at a hash whose bytes the server does not have. It cannot appear at its path. */
    | "missing-blob"
    /** Asked to be deleted, but the server never agreed it existed. Rule 4: it stays. */
    | "not-agreed";
}

export interface CloudSyncPassInput extends CloudSyncProjectScope {
  /** Every path the local scan found, already filtered by the client's exclusions. */
  readonly files: ReadonlyArray<CloudSyncEntry>;
  /**
   * Whether the walk that produced `files` ran to the end.
   *
   * A scanner that knows it was interrupted is cheap to believe and worth
   * believing: a pass built on a partial scan sees every unreported path as
   * deleted. It is deliberately not the only defence, because a scanner that
   * *thinks* it finished is the failure this whole guard exists for — the
   * implausible-deletion rule runs whatever this says.
   */
  readonly scanComplete: boolean;
}

/** What a conflict asks the client to do, in the order it has to be done. */
export interface CloudSyncPlannedConflict {
  readonly path: string;
  /** Where the local version goes. Move it aside *before* writing the remote one. */
  readonly conflictedCopyPath: string;
  readonly remote: CloudSyncEntry;
}

export interface CloudSyncPassPlan {
  readonly outcome: "planned";
  readonly mode: CloudSyncMode;
  /** Content the laptop must send. Includes remote content it is restoring (rule 3). */
  readonly upload: ReadonlyArray<CloudSyncEntry>;
  /** Content the laptop must fetch. Includes local content the remote is restoring. */
  readonly download: ReadonlyArray<CloudSyncEntry>;
  /** The one place a sync removes anything, and only in the cloud. Empty for `handoff`. */
  readonly deleteRemote: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<CloudSyncPlannedConflict>;
  readonly refused: ReadonlyArray<CloudSyncRefusedPath>;
  readonly sync: ProjectCloudSync;
}

/**
 * A pass that will not run, told apart from a pass that failed.
 *
 * This is a state and not an error, and the distinction is the point. `start`
 * failing with `storage` means try again; this means *a person has to look*,
 * because the most likely explanation is that a scan the server was asked to
 * trust would have deleted files nobody deleted. The numbers travel with it so
 * the UI can say which ones rather than "sync refused".
 */
export interface CloudSyncPassRefusal {
  readonly outcome: "refused";
  readonly reason: "implausible-deletion" | "remote-unreadable";
  readonly message: string;
  /** How many remote paths the plan would have removed. */
  readonly deletions: number;
  /** How many paths the server believed existed before this scan. */
  readonly knownPaths: number;
  /** How many paths the scan reported. */
  readonly reportedPaths: number;
  /** The most this pass was allowed to delete without being questioned. */
  readonly allowedDeletions: number;
  readonly sync: ProjectCloudSync;
}

export type CloudSyncPassResult = CloudSyncPassPlan | CloudSyncPassRefusal;

export interface CloudSyncCommitInput extends CloudSyncProjectScope {
  /**
   * Paths both sides now agree on, at the hash they agree on. Each is written
   * into the cloud copy and recorded as the new base revision — but only if its
   * bytes are already in the store and hash to the name given, so a path never
   * appears holding something other than what was agreed.
   */
  readonly files: ReadonlyArray<CloudSyncEntry>;
  /** Remote paths to remove. Re-guarded here, so the plan cannot be bypassed. */
  readonly deletions: ReadonlyArray<string>;
  /** Conflicts the client resolved onto disk, recorded so the badge can count them. */
  readonly conflicts: ReadonlyArray<CloudSyncPlannedConflict>;
  /**
   * The last commit of this pass. Only a final commit with nothing refused
   * moves `lastAgreedAt`, which is the single field answering "is my work
   * safe" and must never be advanced by a partial one.
   */
  readonly final: boolean;
}

export interface CloudSyncCommitResult {
  readonly applied: number;
  readonly deleted: number;
  readonly conflictsRecorded: number;
  readonly refused: ReadonlyArray<CloudSyncRefusedPath>;
  readonly sync: ProjectCloudSync;
}

export interface CloudSyncServiceShape {
  /**
   * `sync` is null for a project nobody has ever synced, rather than a
   * `not-found` failure: that is the ordinary first answer for every project in
   * the list, and a panel that has to catch an error to draw its default state
   * will eventually draw an error.
   */
  readonly getStatus: (
    actor: CloudSyncActor,
    input: CloudSyncStatusGetInput,
  ) => Effect.Effect<CloudSyncStatusResult, CloudSyncError>;

  /**
   * Begins a sync, or begins a new pass on one that already exists.
   *
   * Changing mode is refused with `mode-locked` unless the sync is idle.
   * `handoff` and `mirror` disagree about which copy is canonical, and swapping
   * that underneath a transfer already in flight would reinterpret every byte
   * still in the air; the change is `stop` then `start`, which also gives the
   * UI a moment to say what is about to happen.
   */
  readonly start: (
    actor: CloudSyncActor,
    input: CloudSyncStartInput,
  ) => Effect.Effect<CloudSyncStartResult, CloudSyncError>;

  /** Stops for now and keeps the pass. Resuming continues rather than restarting. */
  readonly pause: (
    actor: CloudSyncActor,
    input: CloudSyncPauseInput,
  ) => Effect.Effect<CloudSyncPauseResult, CloudSyncError>;

  /** Switches the sync off. Both copies survive and start diverging from here. */
  readonly stop: (
    actor: CloudSyncActor,
    input: CloudSyncStopInput,
  ) => Effect.Effect<CloudSyncStopResult, CloudSyncError>;

  readonly listConflicts: (
    actor: CloudSyncActor,
    input: CloudSyncConflictListInput,
  ) => Effect.Effect<CloudSyncConflictListResult, CloudSyncError>;

  /**
   * Records that a person dealt with a conflict. It decides nothing: both
   * versions are already on disk, and there is no side to pick.
   */
  readonly resolveConflict: (
    actor: CloudSyncActor,
    input: CloudSyncConflictResolveInput,
  ) => Effect.Effect<CloudSyncConflictResolveResult, CloudSyncError>;

  /**
   * Reconciles one pass and says what has to move — or refuses.
   *
   * The three sides are the scan in `input`, the cloud copy as read off the
   * server's disk, and the base revisions both sides last agreed on. For
   * `handoff` no reconciliation runs at all: a remote delete has no meaning in
   * a one-shot upload, so the plan is the upload and nothing else.
   */
  readonly planPass: (
    actor: CloudSyncActor,
    input: CloudSyncPassInput,
  ) => Effect.Effect<CloudSyncPassResult, CloudSyncError>;

  /**
   * Publishes agreed content into the cloud copy and advances the base.
   *
   * A file appears at its path only once its bytes are complete and verified,
   * which is enforced here rather than trusted: content is taken from the
   * content-addressed store by hash, written to a temporary name and moved into
   * place. A path whose bytes are missing is refused and reported, never
   * recorded as agreed.
   */
  readonly commitPass: (
    actor: CloudSyncActor,
    input: CloudSyncCommitInput,
  ) => Effect.Effect<CloudSyncCommitResult, CloudSyncError>;

  /**
   * "A live copy of this project is reachable at <url> as of now", or "I am
   * still here and have nothing to publish".
   *
   * Both are the same call, because sharing must go ahead when the tunnel
   * cannot start — `cloudflared` missing, or the auth gate refusing to publish
   * a server that would hand a visitor an owner session. The live link is an
   * accelerator, never a requirement, and a heartbeat that could only carry an
   * address would leave the cloud unable to tell a laptop with no tunnel from a
   * laptop that closed.
   *
   * The address is advisory and perishable and is stored as such. Nothing here
   * makes it an identity: the link a person hands out is the cloud URL, always,
   * because a quick tunnel's address changes on every restart and dies with the
   * machine — and it would die in somebody else's inbox.
   */
  readonly registerLiveCopy: (
    actor: CloudSyncActor,
    input: CloudSyncLiveCopyRegisterInput,
  ) => Effect.Effect<CloudSyncLiveCopyRegisterResult, CloudSyncError>;

  /**
   * What to show someone who opened the cloud URL: the spec's four cases, plus
   * "this project has no sync".
   *
   * Membership-gated like everything else here, and that gate is doing real
   * work rather than being copied from the call above it. The reply carries a
   * working address for somebody's laptop, and handing that to an
   * unauthenticated caller would publish the tunnel URL — the one thing this
   * whole design exists to keep out of circulation.
   */
  readonly getVisitorView: (
    actor: CloudSyncActor,
    input: CloudSyncVisitInput,
  ) => Effect.Effect<CloudSyncVisitorView, CloudSyncError>;

  /**
   * The membership gate on its own, for the blob routes.
   *
   * Exposed rather than reimplemented in the transport: a second definition of
   * "who may touch this project" would eventually disagree with this one, and
   * this one is what stands between a workspace's files and everybody else.
   */
  readonly requireProjectAccess: (
    actor: CloudSyncActor,
    scope: CloudSyncProjectScope,
  ) => Effect.Effect<void, CloudSyncError>;
}

export class CloudSyncService extends Context.Service<CloudSyncService, CloudSyncServiceShape>()(
  "t3/cloudSync/Services/CloudSyncService",
) {}
