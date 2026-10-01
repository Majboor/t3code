import type { CollaborationMember, EnvironmentId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";

export interface CollaborationMembers {
  /** Everyone in the workspace, keyed by the id a message is stamped with. */
  readonly byUserId: ReadonlyMap<string, CollaborationMember>;
  /** Who is reading. Their own messages need no label — they know. */
  readonly viewerUserId: string | null;
  /**
   * Whether a roster can exist for what is on screen at all.
   *
   * Distinguishes "the roster has not answered yet" from "there is no roster to
   * ask for". Both leave `viewerUserId` null, and the timeline has to treat
   * them oppositely: a pending roster gets a provisional tag so a colleague's
   * words are never mistaken for the reader's own, while a project with no
   * ownership has no colleagues and every label on it is noise. Without this
   * flag the provisional tag became permanent, which is how an unshared
   * project ended up with every message reading "Someone else" forever.
   */
  readonly hasScope: boolean;
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

interface RosterCacheEntry {
  readonly members: readonly CollaborationMember[];
  readonly viewerUserId: string | null;
}

/**
 * Last roster this browser saw for a given workspace, kept across component
 * mounts.
 *
 * The component that calls this hook does not stay mounted across every
 * navigation that logically keeps the same conversation going — most notably,
 * sending the first message of a local draft thread promotes it to a real
 * thread on a different route, which remounts the chat view (and this hook)
 * from scratch right as that first turn starts streaming. Without this cache,
 * a workspace whose roster this browser already knows a second ago would
 * still start that new mount back at "nobody known yet", which is exactly
 * the window `resolveMessageAuthor` labels every message — including the
 * reader's own — as "Someone else". Seeding state from here instead means a
 * remount into an already-visited workspace renders correctly immediately,
 * with the network refresh (still kicked off on mount) only there to catch
 * anything that changed since.
 */
const rosterCacheByScopeKey = new Map<string, RosterCacheEntry>();

function rosterCacheKey(scope: { tenantId: TenantId; workspaceId: WorkspaceId }): string {
  return `${scope.tenantId}:${scope.workspaceId}`;
}

function readRosterCache(
  scope: { tenantId: TenantId; workspaceId: WorkspaceId } | null,
): RosterCacheEntry | null {
  if (!scope) {
    return null;
  }
  return rosterCacheByScopeKey.get(rosterCacheKey(scope)) ?? null;
}

function writeRosterCache(
  scope: { tenantId: TenantId; workspaceId: WorkspaceId },
  entry: RosterCacheEntry,
): void {
  rosterCacheByScopeKey.set(rosterCacheKey(scope), entry);
}

export function __resetCollaborationMembersCacheForTests(): void {
  rosterCacheByScopeKey.clear();
}

export const __collaborationMembersCacheForTests = {
  read: readRosterCache,
  write: writeRosterCache,
  key: rosterCacheKey,
};

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

  const scope = useMemo(
    () => (tenantId && workspaceId ? { tenantId, workspaceId } : null),
    [tenantId, workspaceId],
  );

  // Seeded from the cache so a remount into a workspace this browser already
  // has an answer for (see `rosterCacheByScopeKey` above) renders correctly
  // on its very first paint instead of starting over at "nobody known yet".
  const [members, setMembers] = useState<readonly CollaborationMember[]>(
    () => readRosterCache(scope)?.members ?? [],
  );
  const [viewerUserId, setViewerUserId] = useState<string | null>(
    () => readRosterCache(scope)?.viewerUserId ?? null,
  );
  const requestSequenceRef = useRef(0);

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
          writeRosterCache(scope, { members: result.members, viewerUserId: result.viewerUserId });
        })
        .catch(() => onUnavailable?.());
    },
    [environmentId, scope],
  );

  useEffect(() => {
    // Re-seat the roster on the new scope before anything is fetched for it.
    // `setMembers` only ever ran on success and the cache only primed the
    // FIRST render, so between switching workspaces and the new roster
    // arriving, the previous workspace's names and colours were still on
    // screen labelling this workspace's messages — not a missing name, a
    // confidently wrong one.
    //
    // Re-read the cache rather than blanking: the cache is per-scope, so the
    // new scope's own names appear immediately where they are known, and
    // clearing would have traded a wrong name for a visible flicker on every
    // workspace switch. A scope of null has no cache entry and correctly
    // yields nobody.
    const seeded = scope ? readRosterCache(scope) : null;
    setMembers(seeded?.members ?? []);
    setViewerUserId(seeded?.viewerUserId ?? null);

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

  // A fresh object every render defeated `MessagesTimeline`'s memo, so every
  // visible row re-rendered on every streaming delta of every turn. The map
  // inside was already memoized; the wrapper around it was not.
  const hasScope = environmentId !== null && scope !== null;
  return useMemo(() => ({ byUserId, viewerUserId, hasScope }), [byUserId, hasScope, viewerUserId]);
}
