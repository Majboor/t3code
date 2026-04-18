import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { WorkspaceWorkingTreeFileStat } from "./workspaceLiveDiffs";

interface WorkspaceLiveDiffBaselineSnapshot {
  cwd: string;
  isRepo: boolean;
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>;
}

interface WorkspaceLiveDiffBaselineGlobalState {
  pendingByThreadKey: Map<string, WorkspaceLiveDiffBaselineSnapshot>;
}

const WORKSPACE_LIVE_DIFF_BASELINE_GLOBAL_KEY =
  "__t3_workspace_live_diff_baseline_state__" as const;

function readWorkspaceLiveDiffBaselineGlobalState(): WorkspaceLiveDiffBaselineGlobalState {
  const globalObject = globalThis as typeof globalThis & {
    [WORKSPACE_LIVE_DIFF_BASELINE_GLOBAL_KEY]?: WorkspaceLiveDiffBaselineGlobalState;
  };
  const existingState = globalObject[WORKSPACE_LIVE_DIFF_BASELINE_GLOBAL_KEY];
  if (existingState) {
    return existingState;
  }

  const nextState: WorkspaceLiveDiffBaselineGlobalState = {
    pendingByThreadKey: new Map<string, WorkspaceLiveDiffBaselineSnapshot>(),
  };
  globalObject[WORKSPACE_LIVE_DIFF_BASELINE_GLOBAL_KEY] = nextState;
  return nextState;
}

function baselineThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function setPendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
  isRepo: boolean;
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>;
}): void {
  readWorkspaceLiveDiffBaselineGlobalState().pendingByThreadKey.set(
    baselineThreadKey(input.environmentId, input.threadId),
    {
      cwd: input.cwd,
      isRepo: input.isRepo,
      files: input.files,
    },
  );
}

export function takePendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string;
}): WorkspaceLiveDiffBaselineSnapshot | null {
  const key = baselineThreadKey(input.environmentId, input.threadId);
  const pendingByThreadKey = readWorkspaceLiveDiffBaselineGlobalState().pendingByThreadKey;
  const snapshot = pendingByThreadKey.get(key) ?? null;
  if (snapshot === null) {
    return null;
  }

  if (snapshot.cwd !== input.cwd) {
    pendingByThreadKey.delete(key);
    return null;
  }

  pendingByThreadKey.delete(key);
  return snapshot;
}

export function clearPendingWorkspaceLiveDiffBaselineForThread(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}): void {
  readWorkspaceLiveDiffBaselineGlobalState().pendingByThreadKey.delete(
    baselineThreadKey(input.environmentId, input.threadId),
  );
}

export function resetWorkspaceLiveDiffBaselineStateForTests(): void {
  readWorkspaceLiveDiffBaselineGlobalState().pendingByThreadKey.clear();
}
