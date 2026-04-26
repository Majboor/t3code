import * as Schema from "effect/Schema";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { WorkspaceWorkingTreeFileStat } from "./workspaceLiveDiffs";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  removeLocalStorageItemsWithPrefix,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";

const WORKSPACE_LIVE_DIFF_BASELINE_STORAGE_PREFIX = "t3code:workspace-live-diff-baseline:v2";

const WorkspaceLiveDiffBaselineFileSchema = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["modified", "added", "deleted", "renamed", "untracked"]),
  insertions: Schema.Number,
  deletions: Schema.Number,
  diffSignature: Schema.optional(Schema.String),
});
const WorkspaceLiveDiffBaselineSnapshotSchema = Schema.Struct({
  cwd: Schema.String,
  isRepo: Schema.Boolean,
  files: Schema.Array(WorkspaceLiveDiffBaselineFileSchema),
});
type WorkspaceLiveDiffBaselineSnapshot = typeof WorkspaceLiveDiffBaselineSnapshotSchema.Type;

function baselineStorageKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${WORKSPACE_LIVE_DIFF_BASELINE_STORAGE_PREFIX}:${environmentId}:${threadId}`;
}

function readSnapshot(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): WorkspaceLiveDiffBaselineSnapshot | null {
  try {
    return getLocalStorageItem(
      baselineStorageKey(environmentId, threadId),
      WorkspaceLiveDiffBaselineSnapshotSchema,
    );
  } catch {
    removeLocalStorageItem(baselineStorageKey(environmentId, threadId));
    return null;
  }
}

export function setPendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
  isRepo: boolean;
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>;
}): void {
  setLocalStorageItem(
    baselineStorageKey(input.environmentId, input.threadId),
    {
      cwd: input.cwd,
      isRepo: input.isRepo,
      files: input.files.map((file) => ({
        path: file.path,
        status: file.status,
        insertions: file.insertions,
        deletions: file.deletions,
        ...(file.diffSignature ? { diffSignature: file.diffSignature } : {}),
      })),
    },
    WorkspaceLiveDiffBaselineSnapshotSchema,
  );
}

export function takePendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
}): WorkspaceLiveDiffBaselineSnapshot | null {
  const snapshot = readSnapshot(input.environmentId, input.threadId);
  if (snapshot === null) {
    return null;
  }

  if (snapshot.cwd !== input.cwd) {
    removeLocalStorageItem(baselineStorageKey(input.environmentId, input.threadId));
    return null;
  }

  return snapshot;
}

export function peekPendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
}): WorkspaceLiveDiffBaselineSnapshot | null {
  const snapshot = readSnapshot(input.environmentId, input.threadId);
  if (snapshot === null || snapshot.cwd !== input.cwd) {
    return null;
  }

  return snapshot;
}

export function clearPendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}): void {
  removeLocalStorageItem(baselineStorageKey(input.environmentId, input.threadId));
}

export function resetWorkspaceLiveDiffBaselineStateForTests(): void {
  removeLocalStorageItemsWithPrefix(WORKSPACE_LIVE_DIFF_BASELINE_STORAGE_PREFIX);
}
