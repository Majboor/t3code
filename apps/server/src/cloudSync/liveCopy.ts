import {
  CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS,
  isLiveCopyFresh,
  isSafeCloudSyncCopyUrl,
  type CloudSyncVisitorView,
  type ProjectCloudSync,
  type ProjectId,
} from "@t3tools/contracts";

/**
 * Sharing before the sync has finished: the two halves of it that are decisions
 * rather than storage.
 *
 * Both are pure, and both are here rather than inside the service for the same
 * reason `reconcile.ts` sits outside it — what a visitor is told is the product,
 * and it should be arguable in a test rather than in production at the moment
 * somebody's laptop shuts.
 */

export interface VisitInput {
  /** Null when this project has no sync at all. */
  readonly sync: ProjectCloudSync | null;
  /** The address last registered, whatever its age. Freshness is decided here. */
  readonly liveCopyUrl: string | null;
  /** The last heartbeat from the machine holding the local copy. */
  readonly laptopConfirmedAt: string | null;
  readonly now: Date;
}

/**
 * Which of the spec's cases this visitor is in.
 *
 * The order of the decisions is the argument:
 *
 * 1. `lastAgreedAt` first, because once the two sides have agreed even once the
 *    cloud copy is canonical and nothing about the laptop matters any more. A
 *    synced project whose owner has gone to lunch is not a project in trouble.
 * 2. Then the heartbeat, because "the person sharing this closed their laptop"
 *    and "still uploading" are different advice and the spec requires them told
 *    apart. This is read from a timestamp the laptop stamps whether or not it
 *    has a tunnel, so the answer is data and not a guess.
 * 3. Only then the address — and only if it is fresh. A stale registration is
 *    reported as no live copy rather than as an old one, because to anyone who
 *    would click it those are the same thing.
 */
export function classifyVisit(input: VisitInput): CloudSyncVisitorView {
  const sync = input.sync;
  if (sync === null) {
    return { state: "not-syncing", sync: null, liveCopy: null, turnsAllowed: false };
  }

  if (sync.lastAgreedAt !== null) {
    // Serve it from the cloud. A mirror may well be mid-pass again, and that is
    // not a reason to make anybody wait: what they would read is a tree both
    // sides agreed on, with some of it newer.
    return { state: "synced", sync, liveCopy: null, turnsAllowed: true };
  }

  const laptopPresent = isLiveCopyFresh(input.laptopConfirmedAt, input.now);
  if (!laptopPresent) {
    return { state: "sharer-away", sync, liveCopy: null, turnsAllowed: false };
  }

  // A URL that would not be accepted today is not offered today either, even if
  // an older build stored it. The check is cheap and the alternative is a
  // redirect nobody validated.
  const url = input.liveCopyUrl;
  if (url === null || !isSafeCloudSyncCopyUrl(url)) {
    return { state: "first-pass", sync, liveCopy: null, turnsAllowed: false };
  }

  return {
    state: "first-pass-live",
    sync,
    liveCopy: {
      url,
      // Not null by this point: freshness was decided from it a few lines up.
      confirmedAt: input.laptopConfirmedAt ?? sync.updatedAt,
      staleAfterMs: CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS,
    },
    // Refused until the first pass completes, whatever route the visitor takes.
    // An agent turned loose on a half-uploaded tree reads a truncated file,
    // concludes the code is broken, and confidently "fixes" it.
    turnsAllowed: false,
  };
}

/**
 * Where a project's canonical copy is, as registered *on this server* by the
 * machine that just finished uploading it.
 *
 * This is the handoff, and it is the mirror image of registering a live copy.
 * The tunnel published this machine, so this machine is the only one that can
 * catch a visitor still sitting on it and send them home — and home is the cloud
 * URL, which is the address they were sent in the first place.
 *
 * Deliberately in memory and deliberately not in the database. The state is only
 * meaningful while the tunnel that created the situation is alive, and that
 * tunnel is a child of this process's lifetime; persisting it would mean a
 * server that restarted next month still redirecting for a share that ended.
 *
 * None of this is load-bearing. A visitor who never gets redirected is not
 * stranded: they hold the cloud URL, because that is the only link this feature
 * ever hands out. The redirect is the courteous fast path, and the durable
 * answer is the address in their inbox — which is why the handoff does not
 * depend on the tunnel being alive to *work*, only to be quick.
 */
export interface HandoffRegistration {
  readonly canonicalUrl: string;
  readonly registeredAt: string;
}

export class CloudSyncHandoffRegistry {
  private readonly byProject = new Map<ProjectId, HandoffRegistration>();

  register(projectId: ProjectId, canonicalUrl: string, registeredAt: string): boolean {
    if (!isSafeCloudSyncCopyUrl(canonicalUrl)) {
      return false;
    }
    this.byProject.set(projectId, { canonicalUrl, registeredAt });
    return true;
  }

  get(projectId: ProjectId): HandoffRegistration | null {
    return this.byProject.get(projectId) ?? null;
  }

  release(projectId: ProjectId): void {
    this.byProject.delete(projectId);
  }
}

/**
 * One per process, because there is one tunnel per process. Exported as a value
 * so a test can build its own rather than reaching into this one.
 */
export const cloudSyncHandoffRegistry = new CloudSyncHandoffRegistry();
