import type {
  EnvironmentId,
  ProviderAccountId,
  ProviderAuthKind,
  ProviderUsageRequest,
  ProviderUsageRequestDecision,
  ProviderUsageRequestId,
  ProviderUsageRequestReason,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

export interface ProviderUsage {
  /** Both halves at once: what this person asked for, and what they can answer. */
  readonly requests: readonly ProviderUsageRequest[];
  /**
   * Whether this person has anything to lend, straight from the server. An
   * empty `requests` says nothing about it — a contributor nobody has asked and
   * a member who cannot help look identical from the array alone.
   */
  readonly canRespond: boolean;
  /** False until the first read lands, so the panel never guesses at empty. */
  readonly loaded: boolean;
  readonly refresh: () => void;
  /** `note` is sent even when null: a cleared field is a fact, not an omission. */
  readonly ask: (input: {
    provider: ProviderAuthKind;
    reason: ProviderUsageRequestReason;
    note: string | null;
  }) => Promise<void>;
  readonly respond: (input: {
    requestId: ProviderUsageRequestId;
    decision: ProviderUsageRequestDecision;
    /** Which account a grant contributes; null for a decline, which lends nothing. */
    accountId: ProviderAccountId | null;
  }) => Promise<void>;
  readonly withdraw: (requestId: ProviderUsageRequestId) => Promise<void>;
}

/**
 * Requests, read whole.
 *
 * There is no stream behind these: nothing pushes a new request at a possible
 * responder, so this reads on mount — the collaboration popover mounts when it
 * opens, which is the moment somebody is actually looking — and again after
 * every mutation. Nothing is painted optimistically, because a grant is not a
 * status change on the client's side of the wire: the server also switches the
 * responder's share on and gives the requester workspace access, and a panel
 * that predicted the row would be claiming those happened too.
 */
export function useProviderUsageRequests(input: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): ProviderUsage {
  const { environmentId, tenantId, workspaceId } = input;
  const [requests, setRequests] = useState<readonly ProviderUsageRequest[]>([]);
  const [canRespond, setCanRespond] = useState(false);
  const [loaded, setLoaded] = useState(false);
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

    api.providerUsage
      .listRequests(scope)
      .then((result) => {
        if (sequence === requestSequenceRef.current) {
          setRequests(result.requests);
          setCanRespond(result.canRespond);
          setLoaded(true);
        }
      })
      .catch(() => undefined);
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
      try {
        await run(api);
      } finally {
        // Even a refusal moved something: `request-already-pending` and
        // `request-already-decided` both mean this list is out of date.
        refresh();
      }
    },
    [environmentId, refresh, scope],
  );

  const ask = useCallback<ProviderUsage["ask"]>(
    async (patch) => {
      if (!scope) {
        return;
      }
      await call((api) => api.providerUsage.createRequest({ ...scope, ...patch }));
    },
    [call, scope],
  );

  const respond = useCallback<ProviderUsage["respond"]>(
    async (patch) => {
      if (!scope) {
        return;
      }
      const base = { ...scope, requestId: patch.requestId, decision: patch.decision };
      await call((api) =>
        api.providerUsage.respondToRequest(
          patch.accountId === null ? base : { ...base, accountId: patch.accountId },
        ),
      );
    },
    [call, scope],
  );

  const withdraw = useCallback<ProviderUsage["withdraw"]>(
    async (requestId) => {
      if (!scope) {
        return;
      }
      await call((api) => api.providerUsage.withdrawRequest({ ...scope, requestId }));
    },
    [call, scope],
  );

  return { requests, canRespond, loaded, refresh, ask, respond, withdraw };
}
