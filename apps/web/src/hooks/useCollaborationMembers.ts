import type { CollaborationMember, EnvironmentId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

export interface CollaborationMembers {
  /** Everyone in the workspace, keyed by the id a message is stamped with. */
  readonly byUserId: ReadonlyMap<string, CollaborationMember>;
  /** Who is reading. Their own messages need no label — they know. */
  readonly viewerUserId: string | null;
}

const NO_MEMBERS: ReadonlyMap<string, CollaborationMember> = new Map();

/**
 * How long to wait before asking for the roster again, doubling each time.
 *
 * Short at first because the usual reason for a miss is a socket that is a
 * moment from being registered; capped so a genuinely absent environment costs
 * a request a minute rather than a request a frame.
 */
const ROSTER_RETRY_BASE_MS = 500;
const ROSTER_RETRY_MAX_ATTEMPT = 7;

/**
 * The roster, indexed for looking up the author of a message.
 *
 * The transcript needs the same colour and initials the roster shows, or the
 * same person would appear as two different people depending on where you
 * looked. It follows the collaboration stream so a recolour or someone coming
 * online reaches the conversation without a reload.
 */
export function useCollaborationMembers(input: {
  environmentId: EnvironmentId | null;
  tenantId: TenantId | null;
  workspaceId: WorkspaceId | null;
}): CollaborationMembers {
  const { environmentId, tenantId, workspaceId } = input;
  const [members, setMembers] = useState<readonly CollaborationMember[]>([]);
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);

  const scope = useMemo(
    () => (tenantId && workspaceId ? { tenantId, workspaceId } : null),
    [tenantId, workspaceId],
  );

  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const refresh = useCallback(
    (onUnavailable?: () => void) => {
      if (!environmentId || !scope) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        // The socket for this environment is not registered yet, or is being
        // rebound. Bailing out silently is what used to strand the roster: the
        // effect never runs again on its own, so the transcript spent the rest
        // of its life with nobody to name.
        onUnavailable?.();
        return;
      }

      // A slow earlier load must not overwrite the results of a later one.
      requestSequenceRef.current += 1;
      const sequence = requestSequenceRef.current;

      api.collaboration
        .listMembers(scope)
        .then((result) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }
          // Answered, so the next hiccup starts backing off from the top again
          // rather than inheriting a wait from an outage long since over.
          retryAttemptRef.current = 0;
          setMembers(result.members);
          setViewerUserId(result.viewerUserId);
        })
        .catch(() => onUnavailable?.());
    },
    [environmentId, scope],
  );

  useEffect(() => {
    if (!environmentId || !scope) {
      return;
    }

    const subscribedEnvironmentId = environmentId;
    const subscribedScope = scope;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    // Keep asking until the environment answers. Anything that leaves the roster
    // empty leaves every message in the thread unattributed, which is a worse
    // failure than a handful of retries.
    function attempt() {
      if (disposed) {
        return;
      }
      retryTimerRef.current = null;
      refresh(scheduleRetry);
      if (!unsubscribe) {
        const api = readEnvironmentApi(subscribedEnvironmentId);
        unsubscribe = api?.collaboration.subscribe(
          subscribedScope,
          (event) => {
            if (
              event.type === "member-updated" ||
              event.type === "member-removed" ||
              event.type === "presence-upserted"
            ) {
              refresh();
            }
          },
          { onResubscribe: () => refresh() },
        );
      }
    }

    function scheduleRetry() {
      if (disposed || retryTimerRef.current !== null) {
        return;
      }
      retryAttemptRef.current = Math.min(retryAttemptRef.current + 1, ROSTER_RETRY_MAX_ATTEMPT);
      retryTimerRef.current = window.setTimeout(
        attempt,
        ROSTER_RETRY_BASE_MS * 2 ** (retryAttemptRef.current - 1),
      );
    }

    retryAttemptRef.current = 0;
    attempt();

    return () => {
      disposed = true;
      clearRetry();
      unsubscribe?.();
    };
  }, [clearRetry, environmentId, refresh, scope]);

  const byUserId = useMemo(() => {
    if (members.length === 0) {
      return NO_MEMBERS;
    }
    return new Map(members.map((member) => [member.userId as string, member]));
  }, [members]);

  return { byUserId, viewerUserId };
}
