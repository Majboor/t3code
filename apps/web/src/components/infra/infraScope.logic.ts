import type { OrchestrationProjectOwnership, TenantId, WorkspaceId } from "@t3tools/contracts";

export interface InfraScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

type ScopedWorkspace = Pick<InfraScope, "tenantId"> & { readonly id: WorkspaceId };

/**
 * Which workspace this project's packs belong to.
 *
 * The project's own ownership is the answer whenever it is there: a session can
 * see several workspaces, and a pack enabled in one is invisible from another,
 * so picking the first one listed reads somebody else's project back at them.
 *
 * The first workspace remains the fallback only because ownership is optional on
 * the wire — a snapshot from an older server, or a project the session can see
 * without owning. It is a guess, and it is only right when there is one
 * workspace to guess from.
 */
export function resolveInfraScope(input: {
  readonly ownership: OrchestrationProjectOwnership | null | undefined;
  readonly workspaces: ReadonlyArray<ScopedWorkspace>;
}): InfraScope | null {
  const { ownership, workspaces } = input;

  if (ownership) {
    return { tenantId: ownership.tenantId, workspaceId: ownership.workspaceId };
  }

  const workspace = workspaces[0];
  return workspace ? { tenantId: workspace.tenantId, workspaceId: workspace.id } : null;
}
