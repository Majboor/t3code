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

    api.collaboration
      .listMembers(scope)
      .then((result) => {
        if (sequence !== requestSequenceRef.current) {
          return;
        }
        setMembers(result.members);
        setViewerUserId(result.viewerUserId);
      })
      .catch(() => undefined);
  }, [environmentId, scope]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!environmentId || !scope) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    return api.collaboration.subscribe(
      scope,
      (event) => {
        if (
          event.type === "member-updated" ||
          event.type === "member-removed" ||
          event.type === "presence-upserted"
        ) {
          refresh();
        }
      },
      { onResubscribe: refresh },
    );
  }, [environmentId, refresh, scope]);

  const byUserId = useMemo(() => {
    if (members.length === 0) {
      return NO_MEMBERS;
    }
    return new Map(members.map((member) => [member.userId as string, member]));
  }, [members]);

  return { byUserId, viewerUserId };
}
