import type {
  EnvironmentId,
  ProviderAccessMode,
  ProviderAccountId,
  ProviderAuthKind,
  ProviderPolicyMode,
  ProviderSharingOverviewResult,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

export interface ProviderSharing {
  /** Null until the first read lands, and if the read fails. */
  readonly overview: ProviderSharingOverviewResult | null;
  readonly loading: boolean;
  readonly refresh: () => void;
  /** The viewer's own account, for this workspace only. Rejects on failure. */
  readonly setShare: (input: {
    provider: ProviderAuthKind;
    accountId: ProviderAccountId;
    enabled: boolean;
  }) => Promise<void>;
  readonly setPolicy: (input: {
    provider: ProviderAuthKind;
    mode: ProviderPolicyMode;
    sharedOwnerUserId?: UserId | null;
    sharedAccountId?: ProviderAccountId | null;
  }) => Promise<void>;
  readonly setMemberAccess: (input: {
    userId: UserId;
    provider: ProviderAuthKind;
    access: ProviderAccessMode;
  }) => Promise<void>;
}

/**
 * Everything the sharing panel reads, in one request.
 *
 * The overview is deliberately not merged from several calls: `isShared` on the
 * workspace roster and `enabled` on a viewer's own share are two views of the
 * same row, and a client that patched one without the other would show an admin
 * an account nobody is contributing. So every mutation re-reads the whole
 * thing, and only the contribute switch — the one control where a round trip is
 * felt — paints its predicted answer first.
 */
export function useProviderSharing(input: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): ProviderSharing {
  const { environmentId, tenantId, workspaceId } = input;
  const [overview, setOverview] = useState<ProviderSharingOverviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSequenceRef = useRef(0);

  const scope = useMemo(
    () => (tenantId && workspaceId ? { tenantId, workspaceId } : null),
    [tenantId, workspaceId],
  );

  const refresh = useCallback(() => {
    if (!environmentId || !scope) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    // A slow earlier load must not overwrite the results of a later one.
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;
    setLoading(true);

    api.providerSharing
      .getOverview(scope)
      .then((result) => {
        if (sequence === requestSequenceRef.current) {
          setOverview(result);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (sequence === requestSequenceRef.current) {
          setLoading(false);
        }
      });
  }, [environmentId, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const call = useCallback(
    async (run: (api: NonNullable<ReturnType<typeof readEnvironmentApi>>) => Promise<unknown>) => {
      if (!environmentId || !scope) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      await run(api);
      refresh();
    },
    [environmentId, refresh, scope],
  );

  const setShare = useCallback<ProviderSharing["setShare"]>(
    async (patch) => {
      const current = overview;
      if (!current || !scope) {
        return;
      }
      // Paint the flip now; a switch that waits a round trip reads as broken.
      setOverview({
        ...current,
        viewerShares: [
          {
            ...scope,
            ownerUserId: current.viewerUserId,
            provider: patch.provider,
            accountId: patch.accountId,
            enabled: patch.enabled,
            updatedAt: new Date().toISOString(),
          },
          ...current.viewerShares.filter((entry) => entry.provider !== patch.provider),
        ],
      });
      try {
        await call((api) => api.providerSharing.updateShare({ ...scope, ...patch }));
      } catch (error) {
        setOverview(current);
        throw error;
      }
    },
    [call, overview, scope],
  );

  const setPolicy = useCallback<ProviderSharing["setPolicy"]>(
    async (patch) => {
      if (!scope) {
        return;
      }
      await call((api) => api.providerSharing.updatePolicy({ ...scope, ...patch }));
    },
    [call, scope],
  );

  const setMemberAccess = useCallback<ProviderSharing["setMemberAccess"]>(
    async (patch) => {
      if (!scope) {
        return;
      }
      await call((api) => api.providerSharing.updateMember({ ...scope, ...patch }));
    },
    [call, scope],
  );

  return { overview, loading, refresh, setShare, setPolicy, setMemberAccess };
}
