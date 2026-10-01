import { useEffect, useState } from "react";

import { fetchGatewayInstance, type GatewayInstance } from "../environments/primary/gateway";

/**
 * Whether this instance has a LogicPacks gateway, for readers that only need
 * the yes/no.
 *
 * `undefined` while the answer is outstanding, which every caller must read as
 * "leave things as they are" rather than as "no" — the same rule the settings
 * nav already applies to unloaded preferences. `fetchGatewayInstance` caches
 * per tab, so mounting this in several places costs one request.
 */
export function useGatewayInstance(): {
  readonly instance: GatewayInstance | null | undefined;
  readonly billingAvailable: boolean | null;
} {
  const [instance, setInstance] = useState<GatewayInstance | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchGatewayInstance().then((result) => {
      if (!cancelled) setInstance(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    instance,
    // `null` for both "still asking" and "could not find out": neither is a
    // statement that there is no gateway, and only such a statement may hide
    // anything.
    billingAvailable: instance === undefined || instance === null ? null : instance.configured,
  };
}
