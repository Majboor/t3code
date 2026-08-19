import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useStore } from "../../store";
import { createProjectSelectorByRef } from "../../storeSelectors";
import type { CloudSyncScope } from "./useCloudSync";

/**
 * The tenant and workspace a project belongs to, from the project itself.
 *
 * Every cloud-sync call carries all three ids, because a project id alone finds
 * the row without proving the caller may see it. The header only ever has the
 * environment and the project, so the other two are read here rather than
 * threaded through another layer of props for one control.
 *
 * A project with no ownership is not in a shared workspace at all, and there is
 * nothing to sync it to — the caller renders nothing.
 */
export function useProjectCloudSyncScope(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): CloudSyncScope {
  // `scopeProjectRef` builds a fresh object, so it is memoised on the two ids
  // rather than on itself; otherwise the selector is rebuilt and resubscribed
  // on every render of a header that renders constantly.
  const projectRef = useMemo(
    () => (environmentId && projectId ? scopeProjectRef(environmentId, projectId) : null),
    [environmentId, projectId],
  );
  const projectSelector = useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]);
  const project = useStore(projectSelector);
  const ownership = project?.ownership ?? null;

  return {
    environmentId,
    tenantId: ownership?.tenantId ?? null,
    workspaceId: ownership?.workspaceId ?? null,
    projectId,
  };
}
