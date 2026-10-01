/**
 * What `POST /api/cloud-sync/pass` answers, from the laptop's side.
 *
 * The server is the side that plans, and that is settled by the architecture
 * rather than by preference: `reconcileTree` in
 * `packages/shared/src/cloudSync/reconcile.ts` is the single implementation of
 * the spec's three-way table, and the only side holding both the remote tree
 * and the agreed `base` is the server. So the laptop sends a scan, receives a
 * plan, and carries it out. `planLocalPass` is a second, independent run of the
 * same reconciler for the laptop's own verification — it needs `remote` and
 * `base`, which this response does not carry, so it is not on this path yet.
 *
 * A refusal is a state, not an error. `/pass` answers 409 with the numbers
 * behind it, and the most likely reason is that the scan would have deleted
 * files nobody deleted. The caller has to tell that apart from a failed
 * request, which is why `requestPass` returns this union instead of throwing on
 * 409.
 */

import type {
  CloudSyncEntry,
  CloudSyncMode,
  CloudSyncPlannedConflict,
  CloudSyncRefusedPath,
  ProjectCloudSync,
} from "@t3tools/contracts";

export type CloudSyncPassPlan = {
  readonly outcome: "planned";
  readonly mode: CloudSyncMode;
  /** Content this laptop must send. Includes remote content it is restoring (rule 3). */
  readonly upload: ReadonlyArray<CloudSyncEntry>;
  /** Content this laptop must fetch. Includes local content the remote is restoring. */
  readonly download: ReadonlyArray<CloudSyncEntry>;
  /** The one place a sync removes anything, and only in the cloud. Empty for `handoff`. */
  readonly deleteRemote: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<CloudSyncPlannedConflict>;
  readonly refused: ReadonlyArray<CloudSyncRefusedPath>;
  readonly sync: ProjectCloudSync;
};

export type CloudSyncPassRefusal = {
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
};

export type CloudSyncPassResult = CloudSyncPassPlan | CloudSyncPassRefusal;
