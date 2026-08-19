import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { toastManager } from "../ui/toast";
import type { CloudSyncWaitState } from "./cloudSync.logic";
import { useCloudSync } from "./useCloudSync";
import { useProjectCloudSyncScope } from "./useProjectCloudSyncScope";

export interface CloudSyncTurnGate {
  readonly wait: CloudSyncWaitState;
  /**
   * Call before starting a turn. Returns true when the turn was refused, and
   * says why on the way out.
   */
  readonly refuse: () => boolean;
}

/**
 * Refuses turns until a shared project has finished arriving.
 *
 * The spec is blunt about why: an agent let loose on a half-uploaded tree reads
 * a truncated file, concludes the code is broken, and confidently "fixes" it.
 * Waiting is worse than working and much better than that, so the composer
 * checks this and says which of the two waits it is — one resolves itself, the
 * other needs the person who shared the project.
 *
 * A project that was never shared is not waiting for anything and passes
 * straight through, which is every local project.
 */
export function useCloudSyncTurnGate(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): CloudSyncTurnGate {
  const scope = useProjectCloudSyncScope(environmentId, projectId);
  const enabled = scope.tenantId !== null && scope.workspaceId !== null && scope.projectId !== null;
  const { wait } = useCloudSync({ ...scope, enabled });

  const refuse = useCallback(() => {
    if (!wait.blocked) {
      return false;
    }
    toastManager.add({
      // A wait is not a failure, and colouring it as one sends people looking
      // for something to fix.
      type: wait.kind === "sharer-away" ? "warning" : "info",
      title: wait.title,
      description: wait.detail,
    });
    return true;
  }, [wait.blocked, wait.kind, wait.title, wait.detail]);

  return { wait, refuse };
}
