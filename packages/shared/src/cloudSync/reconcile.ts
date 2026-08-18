/**
 * The reconciliation engine for cloud sync: given what a path looks like locally,
 * remotely, and at the base revision both sides last agreed on, decide what should
 * happen to it. Pure — no filesystem, no network, no clock in any decision.
 *
 * The contract is `docs/cloud-sync-spec.md`. Its one rule is that a sync never destroys
 * work, and its corollaries are the reason this module is shaped the way it is:
 *
 * 1. Nothing local is deleted by a sync. There is deliberately no action in
 *    {@link PathAction} that removes local content, so a caller cannot be told to.
 * 2. A conflict is never resolved by choosing — both versions survive.
 * 3. An edit beats a delete, in both directions. Redoing a delete costs a keystroke;
 *    recovering a deleted edit costs the work.
 * 4. A file the server has never seen is never removed, whatever the server's index says.
 *
 * Modification times are not accepted here at all. Clock skew between a laptop and a
 * server makes "last" a guess, and a wrong guess silently deletes the loser's work. A
 * caller that wants mtime as a cheap "might have changed" pre-filter before hashing is
 * free to have one; it must not reach this function.
 */

/** A path that exists, identified by the hash of its content. `sizeBytes` is for progress only. */
export type FilePresence = {
  readonly hash: string;
  readonly sizeBytes: number;
};

/**
 * An explicit "this path is gone", as opposed to `null`'s "nobody has seen it". Both read
 * as absent here; the two are kept apart only so a change feed that reports tombstones
 * does not have to lie about them.
 */
export type FileTombstone = { readonly deleted: true };

/** What one side knows about one path. `null` means never existed, or not seen. */
export type FileState = FilePresence | FileTombstone | null;

export type PathAction =
  /** The three sides agree, or all three are absent. */
  | { readonly kind: "nothing"; readonly path: string }
  | { readonly kind: "upload"; readonly path: string; readonly local: FilePresence }
  | { readonly kind: "download"; readonly path: string; readonly remote: FilePresence }
  /** The user deleted it locally and the remote never moved. A mirror is not a backup. */
  | { readonly kind: "deleteRemote"; readonly path: string }
  /** The remote deleted content the local side still has. Rule 3: put it back up. */
  | { readonly kind: "restoreRemoteFromLocal"; readonly path: string; readonly local: FilePresence }
  /** The local side deleted content the remote then edited. Rule 3: bring it back down. */
  | {
      readonly kind: "restoreLocalFromRemote";
      readonly path: string;
      readonly remote: FilePresence;
    }
  /** No bytes move; only the agreed base is recorded. Both sides already match. */
  | {
      readonly kind: "advanceBase";
      readonly path: string;
      readonly agreed: FilePresence | FileTombstone;
    }
  /**
   * Both sides changed to different content. The remote version takes the path so
   * collaborators in the browser stay consistent with each other, and the local version is
   * written beside it at `conflictedCopyPath` — never overwritten, never cleaned up.
   */
  | {
      readonly kind: "conflict";
      readonly path: string;
      readonly conflictedCopyPath: string;
      readonly local: FilePresence;
      readonly remote: FilePresence;
    };

export type PathActionKind = PathAction["kind"];

/**
 * One row per kind, written as a record so the compiler rejects both a kind added to
 * {@link PathAction} and forgotten here, and a kind listed here that no longer exists.
 */
const PATH_ACTION_KIND_LOOKUP: { readonly [Kind in PathActionKind]: true } = {
  nothing: true,
  upload: true,
  download: true,
  deleteRemote: true,
  restoreRemoteFromLocal: true,
  restoreLocalFromRemote: true,
  advanceBase: true,
  conflict: true,
};

/**
 * Every action kind, for callers that need to enumerate them (progress counters, tests
 * that assert no local-deleting kind was ever added).
 */
export const PATH_ACTION_KINDS = Object.keys(PATH_ACTION_KIND_LOOKUP) as readonly PathActionKind[];

function presence(state: FileState): FilePresence | null {
  if (state === null) {
    return null;
  }
  // A malformed state carrying both a hash and a tombstone is read as content. The
  // failure we are willing to accept is "kept a file we could have removed"; the one we
  // are not is the reverse.
  return "hash" in state ? state : null;
}

/**
 * Content identity is the hash and only the hash. Two states with the same hash and
 * different sizes are a caller bug or a collision, and neither is resolved by preferring
 * one size over the other.
 */
function sameContent(left: FilePresence, right: FilePresence): boolean {
  return left.hash === right.hash;
}

export function reconcilePath(input: {
  readonly path: string;
  readonly local: FileState;
  readonly remote: FileState;
  readonly base: FileState;
  /** Only ever used to name a conflicted copy. It cannot influence which side wins. */
  readonly now?: Date;
}): PathAction {
  const { path } = input;
  const local = presence(input.local);
  const remote = presence(input.remote);
  const base = presence(input.base);

  if (local !== null && remote !== null) {
    if (sameContent(local, remote)) {
      // Both sides hold the same bytes. If the base holds them too there is nothing to
      // record; otherwise both sides changed to identical content — the same edit applied
      // twice, or a file regenerated from the same source. A coincidence, not a conflict.
      return base !== null && sameContent(base, local)
        ? { kind: "nothing", path }
        : { kind: "advanceBase", path, agreed: { hash: remote.hash, sizeBytes: remote.sizeBytes } };
    }
    if (base !== null && sameContent(base, local)) {
      // Local has not moved since the agreement, so there is no local work to lose.
      return { kind: "download", path, remote };
    }
    if (base !== null && sameContent(base, remote)) {
      return { kind: "upload", path, local };
    }
    // Either both sides moved away from the base, or there is no base and the two sides
    // were created independently. Nothing available here can pick a winner without
    // destroying somebody's work, so both are kept and the person decides later.
    return {
      kind: "conflict",
      path,
      conflictedCopyPath: conflictedCopyPath(path, input.now),
      local,
      remote,
    };
  }

  if (local !== null) {
    // Remote absent. With no base the server has never seen this path, so its absence is
    // not a delete and cannot remove anything (rule 4).
    if (base === null) {
      return { kind: "upload", path, local };
    }
    // The remote deleted it. Whether the local copy was edited since the base or not, the
    // local content is the only content left, and rule 3 says an edit beats a delete. The
    // spec lists "same | deleted" and "changed | deleted" as separate rows with the same
    // outcome; they are the same case from here.
    return { kind: "restoreRemoteFromLocal", path, local };
  }

  if (remote !== null) {
    // Local absent, and again a missing base means nothing was ever agreed to delete.
    if (base === null) {
      return { kind: "download", path, remote };
    }
    if (sameContent(base, remote)) {
      // The user deleted it locally and nobody touched the remote copy. This is the one
      // place a sync removes anything, and it removes it only in the cloud.
      return { kind: "deleteRemote", path };
    }
    // The asymmetry that matters: the local side deleted a file the remote side then
    // edited. The delete is cheap to repeat and the edit is not, so the file comes back.
    return { kind: "restoreLocalFromRemote", path, remote };
  }

  // Neither side has it. With a base, both deleted it independently and the base is stale;
  // record the agreement so the path stops being reconsidered every pass.
  return base === null
    ? { kind: "nothing", path }
    : { kind: "advanceBase", path, agreed: { deleted: true } };
}

/**
 * Matches the marker this module appends, so re-conflicting an already-conflicted copy
 * replaces its marker instead of nesting one inside another. The date is matched loosely
 * on purpose: a copy named by an older or newer version of this code must still be
 * recognised, or nesting creeps back in.
 */
const CONFLICTED_COPY_MARKER = / \(conflicted copy [^()]*\)$/;

function splitName(path: string): {
  readonly directory: string;
  readonly stem: string;
  readonly extension: string;
} {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = path.slice(0, separatorIndex + 1);
  const name = path.slice(separatorIndex + 1);
  // A leading dot names the file (".env"); it does not introduce an extension, hence
  // `> 0`. The last dot wins, so "archive.tar.gz" becomes "archive.tar" + ".gz" and the
  // copy still opens the way the original did — without this module carrying a table of
  // compound extensions it would have to keep up to date.
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0
    ? { directory, stem: name.slice(0, dotIndex), extension: name.slice(dotIndex) }
    : { directory, stem: name, extension: "" };
}

/** True for a path this module would have produced, so the UI can list and skip them. */
export function isConflictedCopyPath(path: string): boolean {
  return CONFLICTED_COPY_MARKER.test(splitName(path).stem);
}

/**
 * `<name> (conflicted copy <ISO date>)<ext>`, beside the original.
 *
 * The date is UTC, so a conflict late in the evening west of Greenwich is named with
 * tomorrow's date. That is the cost of a name that means the same thing to the laptop and
 * to the collaborator reading it in the browser.
 */
export function conflictedCopyPath(path: string, now: Date = new Date()): string {
  const { directory, stem, extension } = splitName(path);
  const isoDate = now.toISOString().slice(0, 10);
  const original = stem.replace(CONFLICTED_COPY_MARKER, "");
  return `${directory}${original} (conflicted copy ${isoDate})${extension}`;
}

export type PathActionCounts = { readonly [Kind in PathActionKind]: number };

export type TreeSummary = {
  /** Size of the union of all three sides — the denominator of the progress bar. */
  readonly paths: number;
  readonly counts: PathActionCounts;
  readonly bytesToUpload: number;
  readonly bytesToDownload: number;
  /** Same number as `counts.conflict`, named because the UI asks for it by name. */
  readonly conflicts: number;
};

export type TreeReconciliation = {
  readonly actions: readonly PathAction[];
  readonly summary: TreeSummary;
};

function emptyCounts(): Record<PathActionKind, number> {
  // Seeded from the kind list rather than written out again, so a new kind cannot appear
  // in `actions` while its counter stays undefined and every arithmetic on it is NaN.
  const counts = {} as Record<PathActionKind, number>;
  for (const kind of PATH_ACTION_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

/**
 * Reconciles every path in the union of the three sides.
 *
 * Actions come back sorted by path so two runs over the same input produce the same plan,
 * and the summary is accumulated in the same pass — the progress UI reads it on every
 * frame and must never pay for a second walk. Unchanged paths are included as `nothing`
 * because the caller asked for the union; callers rendering a list should filter on kind
 * rather than assume this array is small.
 */
export function reconcileTree(input: {
  readonly local: ReadonlyMap<string, FileState>;
  readonly remote: ReadonlyMap<string, FileState>;
  readonly base: ReadonlyMap<string, FileState>;
  readonly now?: Date;
}): TreeReconciliation {
  // Resolved once so every conflicted copy produced by one pass carries one date, even if
  // the pass runs across midnight.
  const now = input.now ?? new Date();

  const paths = [
    ...new Set([...input.local.keys(), ...input.remote.keys(), ...input.base.keys()]),
  ].toSorted();

  const actions: PathAction[] = [];
  const counts = emptyCounts();
  let bytesToUpload = 0;
  let bytesToDownload = 0;

  for (const path of paths) {
    const action = reconcilePath({
      path,
      local: input.local.get(path) ?? null,
      remote: input.remote.get(path) ?? null,
      base: input.base.get(path) ?? null,
      now,
    });

    actions.push(action);
    counts[action.kind] += 1;

    switch (action.kind) {
      case "upload":
      case "restoreRemoteFromLocal": {
        bytesToUpload += action.local.sizeBytes;
        break;
      }
      case "download":
      case "restoreLocalFromRemote": {
        bytesToDownload += action.remote.sizeBytes;
        break;
      }
      case "conflict": {
        // The remote version still has to come down to take the path; the local version is
        // moved aside on the machine that already holds it, so it crosses no wire.
        bytesToDownload += action.remote.sizeBytes;
        break;
      }
      default: {
        break;
      }
    }
  }

  return {
    actions,
    summary: {
      paths: paths.length,
      counts,
      bytesToUpload,
      bytesToDownload,
      conflicts: counts.conflict,
    },
  };
}
