import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useProjectTenancy } from "../../hooks/useProjectTenancy";
import type { CloudSyncScope } from "./useCloudSync";

/**
 * The tenant and workspace a project belongs to, in the shape cloud sync wants.
 *
 * Every cloud-sync call carries all four ids, because a project id alone finds
 * the row without proving the caller may see it. The lookup itself is
 * `useProjectTenancy`, shared with the share control, which asks the same
 * question of the same store for the same reason.
 *
 * A project with no ownership is not in a shared workspace at all, and there is
 * nothing to sync it to — the caller renders nothing.
 */
export function useProjectCloudSyncScope(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): CloudSyncScope {
  const tenancy = useProjectTenancy(environmentId, projectId);

  return {
    environmentId,
    tenantId: tenancy.tenantId,
    workspaceId: tenancy.workspaceId,
    projectId,
  };
}
