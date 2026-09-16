import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";

export interface ProjectTenancy {
  readonly tenantId: TenantId | null;
  readonly workspaceId: WorkspaceId | null;
}

/**
 * The tenant and workspace a project belongs to, read from the project itself.
 *
 * Header controls are handed an environment and a project and nothing else,
 * while every tenancy-scoped call wants all four ids — a project id alone finds
 * the row without proving the caller may see it. Threading two more props
 * through the header for each control that needs them is how the same lookup
 * ends up written twice with two different opinions about what "no workspace"
 * means; it is answered here once instead.
 *
 * Null means the project is in no shared workspace at all. That is a real
 * answer, not a missing one: there is nothing to sync it to and nobody to share
 * it with, and callers are expected to render accordingly rather than wait.
 */
export function useProjectTenancy(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ProjectTenancy {
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
    tenantId: ownership?.tenantId ?? null,
    workspaceId: ownership?.workspaceId ?? null,
  };
}
