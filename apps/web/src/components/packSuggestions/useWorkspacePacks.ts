/**
 * The packs this workspace can see, loaded once for the prompt bar.
 *
 * Fetched on mount rather than per keystroke: matching happens locally, so
 * there is no reason to ask the server what it already told us — and a request
 * per character would make typing feel like the network.
 *
 * Failure is silent and returns nothing. A suggestion strip is an offer; if it
 * cannot be made, the composer should look exactly as it did before rather
 * than grow an error nobody asked for.
 */
import type { EnvironmentId, PackRegistryEntry, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";

export function useWorkspacePacks(
  environmentId: EnvironmentId | null,
  tenantId: TenantId | null,
  workspaceId: WorkspaceId | null,
): ReadonlyArray<PackRegistryEntry> {
  const [packs, setPacks] = useState<ReadonlyArray<PackRegistryEntry>>([]);

  useEffect(() => {
    if (!environmentId || !tenantId || !workspaceId) {
      setPacks([]);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    let cancelled = false;
    api.packs
      .search({ tenantId, workspaceId })
      .then((result) => {
        if (!cancelled) setPacks(result.packs);
      })
      .catch(() => {
        if (!cancelled) setPacks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [environmentId, tenantId, workspaceId]);

  return packs;
}
