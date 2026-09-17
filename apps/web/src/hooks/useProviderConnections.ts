import { useEffect, useState } from "react";
import { readSupabaseBrowserAccessToken } from "../environments/primary/auth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { parseConnections, type Connection } from "../components/settings/providerAccounts.logic";

export async function fetchConnections(): Promise<readonly Connection[]> {
  const accessToken = readSupabaseBrowserAccessToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/provider-auth/connections"), {
    credentials: "include",
    ...(accessToken ? { headers: { authorization: `Bearer ${accessToken}` } } : {}),
  });
  if (!response.ok) {
    return [];
  }
  const data: unknown = await response.json().catch(() => null);
  return parseConnections(data);
}

/**
 * Whether *any* account of an OAuth-connectable provider (Codex/Claude) is
 * connected — GLM has no such concept and is always treated as connected.
 * Shared by `ProviderStatusBanner` (the "not connected" banner) and
 * `ProviderModelPicker` (greying out a disconnected provider in the picker).
 */
export function useProviderConnections(enabled: boolean): readonly Connection[] | null {
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    void fetchConnections().then((result) => {
      if (!cancelled) {
        setConnections(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return connections;
}
