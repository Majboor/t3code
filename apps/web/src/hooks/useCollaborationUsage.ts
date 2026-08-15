import type {
  CollaborationUsageQueryResult,
  EnvironmentId,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { readEnvironmentApi } from "../environmentApi";

/**
 * How long a usage report is treated as good enough to reopen the panel on.
 *
 * The report summarises a month; it does not move meaningfully in five
 * minutes, and the workspace shares a 120 RPC/minute budget with everything
 * else the app does. Nothing here polls — a stale window is refetched only
 * when someone opens the panel again after this long, or presses Refresh.
 */
export const COLLABORATION_USAGE_STALE_MS = 5 * 60_000;

export interface UseCollaborationUsageInput {
  readonly environmentId: EnvironmentId | null;
  readonly tenantId: TenantId | null;
  readonly workspaceId: WorkspaceId | null;
  /** Gate the request on the panel actually being open. */
  readonly enabled: boolean;
}

export function useCollaborationUsage({
  environmentId,
  tenantId,
  workspaceId,
  enabled,
}: UseCollaborationUsageInput): UseQueryResult<CollaborationUsageQueryResult> {
  return useQuery({
    enabled: enabled && environmentId !== null && tenantId !== null && workspaceId !== null,
    queryKey: ["collaboration", "usage", environmentId, tenantId, workspaceId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This environment is not connected.");
      if (tenantId === null || workspaceId === null) {
        throw new Error("This project is not in a shared workspace.");
      }
      // The window is left to the server, which defaults to the last 30 days.
      return api.collaboration.queryUsage({ tenantId, workspaceId });
    },
    staleTime: COLLABORATION_USAGE_STALE_MS,
    // A report of the last month has no business refetching because a window
    // regained focus.
    refetchOnWindowFocus: false,
  });
}
