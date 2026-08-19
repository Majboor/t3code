import type {
  EnvironmentId,
  ProjectId,
  ShareLink,
  ShareLinkAudience,
  ShareLinkId,
  ShareLinkScope,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import { mintAndCopyShareLink, type MintedShareLink } from "./mintShareLink";
import { checkShareLinkTarget, describeShareLinkFailure } from "./shareLinks.logic";

export interface ShareLinksState {
  /** Every field of every link except the token, which `list` never returns. */
  readonly links: readonly ShareLink[];
  /** False until the first read lands, so the panel never claims an empty list. */
  readonly loaded: boolean;
  readonly refresh: () => void;
  readonly mint: (input: {
    readonly scope: ShareLinkScope;
    /**
     * Required, like the contract's own field. There is no default: a link
     * created without anybody saying who it is for would be a public link
     * nobody chose to make public.
     */
    readonly audience: ShareLinkAudience;
    readonly filePath?: string | null;
    readonly label?: string | null;
  }) => Promise<MintedShareLink | null>;
  readonly revoke: (linkId: ShareLinkId) => Promise<void>;
}

/**
 * The links a project's panel manages.
 *
 * Read on mount and again after every mutation, like the usage-request panel:
 * nothing streams share links, and view counts move without anybody here doing
 * a thing, so a cached list is stale the moment somebody opens a link. Nothing
 * is painted optimistically — a revoke that the server refused as `forbidden`
 * must not leave a row looking switched off.
 */
export function useShareLinks(input: {
  readonly environmentId: EnvironmentId | null;
  readonly tenantId: TenantId | null;
  readonly workspaceId: WorkspaceId | null;
  /**
   * Narrows the list to one project. Workspace-scoped links belong to no
   * project, so the panel reads the whole workspace and filters for display
   * rather than losing them.
   */
  readonly projectId: ProjectId | null;
}): ShareLinksState {
  const { environmentId, tenantId, workspaceId, projectId } = input;
  const [links, setLinks] = useState<readonly ShareLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const requestSequenceRef = useRef(0);

  /** Named apart from a link's `scope`, which is a different thing entirely. */
  const tenancy = useMemo(
    () => (tenantId && workspaceId ? { tenantId, workspaceId } : null),
    [tenantId, workspaceId],
  );

  const refresh = useCallback(() => {
    if (!environmentId || !tenancy) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    // A slow earlier load must not overwrite the results of a later one.
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;

    api.shareLinks
      .list(tenancy)
      .then((result) => {
        if (sequence === requestSequenceRef.current) {
          setLinks(result.links);
          setLoaded(true);
        }
      })
      .catch(() => undefined);
  }, [environmentId, tenancy]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const mint = useCallback<ShareLinksState["mint"]>(
    async (draft) => {
      if (!environmentId || !tenancy) {
        return null;
      }
      const target = checkShareLinkTarget({
        scope: draft.scope,
        projectId,
        filePath: draft.filePath ?? null,
      });
      if (!target.ok) {
        toastManager.add({
          type: "error",
          title: "Nothing to link to",
          description: target.reason,
        });
        return null;
      }

      const minted = await mintAndCopyShareLink({
        environmentId,
        failureTitle: "Could not make the link",
        create: {
          ...tenancy,
          scope: draft.scope,
          audience: draft.audience,
          projectId: target.projectId,
          filePath: target.filePath,
          label: draft.label?.trim() ? draft.label.trim() : null,
        },
      });
      refresh();
      return minted;
    },
    [environmentId, projectId, refresh, tenancy],
  );

  const revoke = useCallback<ShareLinksState["revoke"]>(
    async (linkId) => {
      if (!environmentId || !tenancy) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      try {
        await api.shareLinks.revoke({ ...tenancy, linkId });
      } catch (error: unknown) {
        const notice = describeShareLinkFailure(error, {
          fallbackTitle: "Could not switch that link off",
        });
        toastManager.add({
          type: notice.tone,
          title: notice.title,
          description: notice.description,
        });
      } finally {
        // Even a refusal moved something: `revoked` and `not-found` both mean
        // this list no longer matches the server's.
        refresh();
      }
    },
    [environmentId, refresh, tenancy],
  );

  return { links, loaded, refresh, mint, revoke };
}
