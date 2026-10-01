/**
 * The thing `main.ts` said was missing: "Applying actions is not exposed until the
 * controller that sequences a pass exists."
 *
 * Every piece of a pass already existed and was tested — `scan.ts` reads the tree,
 * `reconcile.ts` decides what should happen, `apply.ts` writes one path safely, `watch.ts`
 * says when something moved — and nothing put them in order or spoke to the server. This
 * does, and it is deliberately the only place that does, because `apply.ts`'s safety
 * depends on being handed a plan something agreed to run rather than individual actions a
 * caller composed.
 *
 * ## Who plans
 *
 * The server. Not a preference: `reconcileTree` is the single implementation of the spec's
 * three-way table, and the only side holding both the remote tree and the agreed `base` is
 * the server. The laptop sends a scan, gets a plan, and carries it out. What the laptop
 * checks for itself are the two things it can know without the server — the mode is a
 * mirror, and the scan finished — and it checks them BEFORE sending, because a pass built
 * on a partial scan sees every unreported path as deleted.
 *
 * ## The order within a pass
 *
 * Upload before commit, download before commit, commit last. The commit is what advances
 * the base, and a base advanced past content that never arrived is a path the next pass
 * believes both sides agreed on while one of them has nothing. So a pass that fails
 * part-way through leaves the base where it was and is simply run again: nothing here is
 * destructive, and `apply.ts` moves a conflicting local file aside rather than over.
 *
 * ## Why single-flight and not a queue
 *
 * Two passes over one tree at once can interleave a download with a scan and commit a base
 * for content that was replaced underneath them. So a pass runs alone, and a change that
 * arrives while one is running sets a flag rather than queueing: the next pass re-scans
 * anyway, so N changes during a pass need exactly one more pass, not N.
 */

import { applyPathAction, type ApplyOptions } from "./apply.ts";
import { scanProject, type ScanResult } from "./scan.ts";
import {
  createTreeWatcher,
  type ChangeBatch,
  type TreeWatcher,
  type TreeWatcherOptions,
} from "./watch.ts";
import type { CloudSyncPassPlan, CloudSyncPassResult } from "./passPlan.ts";
import type { CloudSyncTransport } from "./transport.ts";
import type { CloudSyncEntry } from "@t3tools/contracts";
import type { PathAction } from "@t3tools/shared/cloudSync/reconcile";

/** What a pass did, or why it did nothing. A refusal is reported, never thrown. */
export type PassReport =
  | {
      readonly kind: "completed";
      readonly uploaded: number;
      readonly downloaded: number;
      readonly deletedRemote: number;
      readonly conflicts: ReadonlyArray<string>;
      readonly refusedPaths: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
    }
  /**
   * The server will not run this pass. A state and not an error: the most likely
   * explanation is that the scan would have deleted files nobody deleted, and the numbers
   * travel so the UI can say which rather than "sync failed".
   */
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly message: string;
      readonly deletions: number;
      readonly knownPaths: number;
      readonly reportedPaths: number;
      readonly allowedDeletions: number;
    }
  /** The laptop declined before asking, for something only it can know. */
  | {
      readonly kind: "notAttempted";
      readonly reason: "not-a-mirror" | "incomplete-scan" | "already-running";
      readonly message: string;
      readonly details: ReadonlyArray<string>;
    }
  | { readonly kind: "failed"; readonly message: string; readonly cause?: unknown };

export type PassControllerOptions = {
  /** The project directory. */
  readonly root: string;
  readonly transport: CloudSyncTransport;
  /** Only `mirror` reconciles; see `planLocalPass`'s own refusal for why. */
  readonly mode: "handoff" | "mirror";
  readonly onReport?: ((report: PassReport) => void) | undefined;
  /** Injected for tests; defaults to reading the real tree. */
  readonly scan?: ((root: string) => Promise<ScanResult>) | undefined;
  /** Injected for tests; defaults to writing the real tree. */
  readonly apply?: ((action: PathAction, options: ApplyOptions) => Promise<unknown>) | undefined;
  /** Injected for tests; defaults to reading the real file for an upload. */
  readonly readLocalFile?:
    | ((root: string, relativePath: string) => Promise<Uint8Array>)
    | undefined;
  readonly watch?: ((options: TreeWatcherOptions) => TreeWatcher) | undefined;
};

export type PassController = {
  /** Runs one pass now. Resolves with what it did; never rejects. */
  readonly runPass: () => Promise<PassReport>;
  /** Starts watching the tree and running a pass per settled batch. */
  readonly start: () => void;
  readonly stop: () => void;
  /** True while a pass is in flight. */
  readonly isRunning: () => boolean;
};

function entriesFromScan(scan: ScanResult): ReadonlyArray<CloudSyncEntry> {
  const entries: CloudSyncEntry[] = [];
  for (const [path, file] of scan.files) {
    entries.push({
      path,
      hash: file.hash,
      sizeBytes: file.sizeBytes,
    } as CloudSyncEntry);
  }
  return entries;
}

/**
 * The server's plan, as actions `apply.ts` understands.
 *
 * Only the two kinds that touch this disk are produced. `upload` and `deleteRemote` are
 * the transport's business and `apply.ts` answers `noLocalChange` for them, so running
 * them through it would be a loop that does nothing; the restores the spec's rule 3 calls
 * for are already folded into the plan's `upload` and `download` lists by the server, which
 * is why there is no `restore*` case here.
 *
 * A conflict is one action, not two, because the order inside it matters: the local file is
 * moved aside first and the remote written second, and `applyPathAction` is what guarantees
 * that order.
 */
export function localActionsForPlan(
  plan: CloudSyncPassPlan,
  scan: ScanResult,
): ReadonlyArray<PathAction> {
  const actions: PathAction[] = [];
  for (const entry of plan.download) {
    actions.push({
      kind: "download",
      path: entry.path,
      remote: { hash: entry.hash, sizeBytes: entry.sizeBytes },
    });
  }
  for (const conflict of plan.conflicts) {
    const local = scan.files.get(conflict.path);
    // A conflict whose local side vanished between the scan and now has nothing to
    // preserve. Dropping it here would silently take the remote version; the download
    // branch is what should then handle it, so it is left for the next pass rather than
    // guessed at.
    if (local === undefined) continue;
    actions.push({
      kind: "conflict",
      path: conflict.path,
      conflictedCopyPath: conflict.conflictedCopyPath,
      local: { hash: local.hash, sizeBytes: local.sizeBytes },
      remote: { hash: conflict.remote.hash, sizeBytes: conflict.remote.sizeBytes },
    });
  }
  return actions;
}

/**
 * What the commit claims both sides now agree on.
 *
 * Everything the scan found, minus what the server refused to carry and minus what it is
 * about to delete. Claiming agreement on a path the server refused would advance the base
 * past content it does not have, and the next pass would read that as "both sides had it
 * and the laptop deleted it".
 */
export function agreedFilesAfterPlan(
  plan: CloudSyncPassPlan,
  scan: ScanResult,
): ReadonlyArray<CloudSyncEntry> {
  const refused = new Set(plan.refused.map((entry) => entry.path));
  const deleting = new Set(plan.deleteRemote);
  const agreed: CloudSyncEntry[] = [];
  for (const entry of entriesFromScan(scan)) {
    if (refused.has(entry.path) || deleting.has(entry.path)) continue;
    agreed.push(entry);
  }
  // A download replaces local content, so the agreed hash for that path is the remote one
  // rather than whatever the scan saw a moment ago.
  const downloaded = new Map(plan.download.map((entry) => [entry.path, entry]));
  for (const conflict of plan.conflicts) {
    downloaded.set(conflict.path, conflict.remote);
  }
  return agreed.map((entry) => downloaded.get(entry.path) ?? entry);
}

export function createPassController(options: PassControllerOptions): PassController {
  const scan = options.scan ?? ((root: string) => scanProject({ root }));
  const apply = options.apply ?? applyPathAction;
  const makeWatcher = options.watch ?? createTreeWatcher;
  const readLocalFile =
    options.readLocalFile ??
    (async (root: string, relativePath: string) => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      return new Uint8Array(await fs.readFile(path.join(root, relativePath)));
    });

  let running = false;
  let dirtyWhileRunning = false;
  let watcher: TreeWatcher | null = null;

  const report = (value: PassReport): PassReport => {
    options.onReport?.(value);
    return value;
  };

  const runPassOnce = async (): Promise<PassReport> => {
    // Only a mirror reconciles. A handoff is a one-off upload and has no base to advance,
    // so running this over one would be inventing an agreement nobody made.
    if (options.mode !== "mirror") {
      return report({
        kind: "notAttempted",
        reason: "not-a-mirror",
        message: "This project was shared as a one-off upload, so there is nothing to reconcile.",
        details: [],
      });
    }

    let scanned: ScanResult;
    try {
      scanned = await scan(options.root);
    } catch (cause) {
      return report({ kind: "failed", message: "This project could not be read.", cause });
    }

    // Checked here and again by the server. A pass built on a partial scan sees every
    // unreported path as deleted, and the laptop is the only side that knows its walk was
    // cut short.
    if (!scanned.complete) {
      return report({
        kind: "notAttempted",
        reason: "incomplete-scan",
        message:
          "Part of this project could not be read, so we cannot tell what you deleted from what we simply did not see. Nothing was changed.",
        details: scanned.incompleteReasons,
      });
    }

    let planned: CloudSyncPassResult;
    try {
      planned = await options.transport.requestPass({
        files: entriesFromScan(scanned),
        scanComplete: scanned.complete,
      });
    } catch (cause) {
      return report({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "The pass could not be planned.",
        cause,
      });
    }

    if (planned.outcome === "refused") {
      return report({
        kind: "refused",
        reason: planned.reason,
        message: planned.message,
        deletions: planned.deletions,
        knownPaths: planned.knownPaths,
        reportedPaths: planned.reportedPaths,
        allowedDeletions: planned.allowedDeletions,
      });
    }

    try {
      // Upload first. The commit below advances the base, and a base advanced past content
      // that never arrived is a path the next pass believes both sides agreed on while the
      // cloud holds nothing.
      const wanted = planned.upload.map((entry) => entry.hash);
      const missing = new Set(await options.transport.missingBlobs(wanted));
      let uploaded = 0;
      for (const entry of planned.upload) {
        if (!missing.has(entry.hash)) continue;
        const bytes = await readLocalFile(options.root, entry.path);
        await options.transport.uploadBlob(entry.hash, bytes);
        uploaded += 1;
      }

      const applyOptions: ApplyOptions = {
        root: options.root,
        fetchRemoteFile: ({ remote }) => options.transport.fetchBlob(remote.hash),
      };
      const actions = localActionsForPlan(planned, scanned);
      for (const action of actions) {
        await apply(action, applyOptions);
      }

      await options.transport.commitPass({
        files: agreedFilesAfterPlan(planned, scanned),
        deletions: planned.deleteRemote,
        conflicts: planned.conflicts,
        final: true,
      });

      return report({
        kind: "completed",
        uploaded,
        downloaded: planned.download.length,
        deletedRemote: planned.deleteRemote.length,
        conflicts: planned.conflicts.map((conflict) => conflict.path),
        refusedPaths: planned.refused.map((entry) => ({
          path: entry.path,
          reason: entry.reason,
        })),
      });
    } catch (cause) {
      // Nothing here is destructive and the base has not moved, so the honest report is
      // "this pass did not finish" and the next one starts from the same place.
      return report({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "This pass did not finish.",
        cause,
      });
    }
  };

  const runPass = async (): Promise<PassReport> => {
    if (running) {
      dirtyWhileRunning = true;
      return report({
        kind: "notAttempted",
        reason: "already-running",
        message: "A pass is already running; this change will be picked up by the next one.",
        details: [],
      });
    }
    running = true;
    try {
      let result = await runPassOnce();
      // One more pass covers every change that arrived during this one, because the next
      // pass re-scans. Only re-run after a pass that actually completed: re-running after a
      // refusal would spin against a condition a person has to clear.
      while (dirtyWhileRunning && result.kind === "completed") {
        dirtyWhileRunning = false;
        result = await runPassOnce();
      }
      dirtyWhileRunning = false;
      return result;
    } finally {
      running = false;
    }
  };

  return {
    runPass,
    isRunning: () => running,
    start: () => {
      if (watcher !== null) return;
      watcher = makeWatcher({
        root: options.root,
        onBatch: (_batch: ChangeBatch) => {
          void runPass();
        },
      });
    },
    stop: () => {
      watcher?.close();
      watcher = null;
    },
  };
}
