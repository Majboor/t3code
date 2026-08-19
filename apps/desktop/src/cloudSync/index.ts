/**
 * The laptop half of cloud sync: walk (`scan.ts`), watch (`watch.ts`), apply (`apply.ts`),
 * and the one thing that has to sit above all three — the guard that decides whether a
 * pass is allowed to run at all.
 *
 * `docs/cloud-sync-spec.md` lists four things the reconciler cannot enforce and its
 * callers must. Two of them are ordering rules inside `apply.ts` and live there. The other
 * two are decisions about a whole pass, and they live here so that no caller can reach the
 * reconciler without passing them:
 *
 * - a partial scan is never reconciled, because every unreported path reads as a deletion;
 * - `handoff` does not run this at all, because a remote delete is meaningless during a
 *   one-shot upload.
 */

import type { CloudSyncMode } from "@t3tools/contracts";
import type { FileState, TreeReconciliation } from "@t3tools/shared/cloudSync/reconcile";
import { reconcileTree } from "@t3tools/shared/cloudSync/reconcile";

import { createUnknownPathPredicate, type ScanResult } from "./scan.ts";

export * from "./apply.ts";
export * from "./scan.ts";
export * from "./watch.ts";

/**
 * Deletions below this count are always allowed through. A project with four files, three
 * of which the person just deleted, is an ordinary Tuesday; blocking it would make the
 * guard fire constantly on small trees and teach whoever sees it to click past it.
 */
const ALWAYS_PLAUSIBLE_DELETIONS = 10;

/**
 * Above the floor, a pass may remove at most this share of the paths it knows about.
 * Anything more looks like a tree that moved, a drive that unmounted, or an exclusion rule
 * that changed — none of which the person asked for.
 */
const MAX_DELETION_SHARE = 0.25;

export type DeletionPlausibility =
  | { readonly plausible: true }
  | {
      readonly plausible: false;
      readonly deletions: number;
      readonly knownPaths: number;
      readonly allowed: number;
    };

/**
 * The spec's first obligation, second half: refuse *and ask* when the number of remote
 * deletions is implausible against the size of the tree. Pure, so the threshold can be
 * argued about in a test rather than in production.
 */
export function assessRemoteDeletions(input: {
  readonly deletions: number;
  /** Files the scan actually found. The denominator has to be what is there, not what was. */
  readonly localFileCount: number;
}): DeletionPlausibility {
  const knownPaths = input.localFileCount + input.deletions;
  const allowed = Math.max(ALWAYS_PLAUSIBLE_DELETIONS, Math.ceil(knownPaths * MAX_DELETION_SHARE));
  return input.deletions <= allowed
    ? { plausible: true }
    : { plausible: false, deletions: input.deletions, knownPaths, allowed };
}

export type PassRefusalReason =
  | "incomplete-scan"
  | "implausible-deletions"
  /** `handoff` is a one-shot upload; reconciliation is mirror semantics. */
  | "not-a-mirror";

export type PassRefusal = {
  readonly reason: PassRefusalReason;
  /** Wording aimed at the person, because every one of these ends in a question for them. */
  readonly message: string;
  readonly details: readonly string[];
};

export type LocalPassPlan = TreeReconciliation & {
  /**
   * Paths the scan could not speak for, held out of the reconciliation entirely. They are
   * neither uploaded nor deleted; they are simply not this pass's business.
   */
  readonly excludedPaths: readonly string[];
};

export type LocalPassOutcome =
  | { readonly ok: true; readonly plan: LocalPassPlan }
  | { readonly ok: false; readonly refusal: PassRefusal };

/**
 * Turns a scan and the server's view into a plan, or refuses.
 *
 * The refusals are the point. A plan that comes back from here has been checked against
 * the two ways a correct reconciler still loses a tree, and a caller that ignores the
 * `ok: false` case has to do so on purpose.
 */
export function planLocalPass(input: {
  readonly mode: CloudSyncMode;
  readonly scan: ScanResult;
  readonly remote: ReadonlyMap<string, FileState>;
  readonly base: ReadonlyMap<string, FileState>;
  readonly now?: Date | undefined;
}): LocalPassOutcome {
  if (input.mode !== "mirror") {
    return {
      ok: false,
      refusal: {
        reason: "not-a-mirror",
        message: "This project was shared as a one-off upload, so there is nothing to reconcile.",
        details: [],
      },
    };
  }

  if (!input.scan.complete) {
    return {
      ok: false,
      refusal: {
        reason: "incomplete-scan",
        message:
          "Part of this project could not be read, so we cannot tell what you deleted from what we simply did not see. Nothing was changed.",
        details: input.scan.incompleteReasons,
      },
    };
  }

  const isUnknown = createUnknownPathPredicate(input.scan);
  const excludedPaths: string[] = [];

  function filtered(source: ReadonlyMap<string, FileState>): Map<string, FileState> {
    const result = new Map<string, FileState>();
    for (const [path, state] of source) {
      if (isUnknown(path)) {
        excludedPaths.push(path);
        continue;
      }
      result.set(path, state);
    }
    return result;
  }

  // The local map is filtered too: a path can be both scanned and skipped only if the
  // rules changed underneath the walk, and in that case the skip is the cautious answer.
  const local = filtered(input.scan.files);
  const remote = filtered(input.remote);
  const base = filtered(input.base);

  const reconciliation = reconcileTree({
    local,
    remote,
    base,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  const plausibility = assessRemoteDeletions({
    deletions: reconciliation.summary.counts.deleteRemote,
    localFileCount: local.size,
  });
  if (!plausibility.plausible) {
    return {
      ok: false,
      refusal: {
        reason: "implausible-deletions",
        message: `This pass would remove ${plausibility.deletions} files from the cloud copy of a project with ${plausibility.knownPaths} known files. That is more than we will do without asking.`,
        details: reconciliation.actions
          .filter((action) => action.kind === "deleteRemote")
          .slice(0, 20)
          .map((action) => action.path),
      },
    };
  }

  return {
    ok: true,
    plan: { ...reconciliation, excludedPaths: [...new Set(excludedPaths)].toSorted() },
  };
}
