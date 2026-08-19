import type {
  CloudSyncConflict,
  CloudSyncConflictId,
  CloudSyncMode,
  EnvironmentId,
  ProjectCloudSync,
  ProjectId,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";
import {
  describeCloudSyncFailure,
  describeCloudSyncWait,
  deriveVisitorView,
  type CloudSyncWaitState,
} from "./cloudSync.logic";

/**
 * How often a running pass is re-read.
 *
 * Only while something is actually moving. A settled sync is re-read when
 * somebody opens the panel and not otherwise: the workspace shares a 120
 * RPC/minute budget with the rest of the app, and a progress bar for a sync
 * that has nothing to do is not worth a fifth of it.
 */
const CLOUD_SYNC_POLL_MS = 3_000;

/** One page is plenty for a panel; the badge carries the real number. */
const CLOUD_SYNC_CONFLICT_PAGE = 50;

export interface CloudSyncScope {
  readonly environmentId: EnvironmentId | null;
  readonly tenantId: TenantId | null;
  readonly workspaceId: WorkspaceId | null;
  readonly projectId: ProjectId | null;
}

export interface CloudSyncState {
  /** Null both before the first read lands and for a project nobody ever shared. */
  readonly sync: ProjectCloudSync | null;
  /** False until the first read lands, so nothing claims "not shared" prematurely. */
  readonly loaded: boolean;
  /** Set when the read itself failed — `forbidden` for a non-member lands here. */
  readonly readError: unknown;
  /**
   * What a visitor should be told, and whether turns are allowed. Derived here
   * so that the header badge, the panel and the composer gate cannot disagree
   * about whether a project has finished arriving.
   */
  readonly wait: CloudSyncWaitState;
  readonly conflicts: readonly CloudSyncConflict[];
  readonly conflictsLoaded: boolean;
  /** More conflicts exist than this page holds. */
  readonly hasMoreConflicts: boolean;
  readonly busy: boolean;
  readonly refresh: () => void;
  readonly start: (mode: CloudSyncMode) => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly resolveConflict: (conflictId: CloudSyncConflictId) => Promise<void>;
}

/**
 * One project's sync, read on demand and after every mutation.
 *
 * Nothing is painted optimistically. A `start` the server refused with
 * `mode-locked` must not leave a panel showing a mode that is not running, and
 * a `resolve` refused as `forbidden` must not leave a conflict looking dealt
 * with — under a promise that no work is destroyed, a row that lies about what
 * survived is worse than a slow one.
 */
export function useCloudSync(
  scope: CloudSyncScope & { readonly enabled: boolean },
): CloudSyncState {
  const { environmentId, tenantId, workspaceId, projectId, enabled } = scope;
  const [sync, setSync] = useState<ProjectCloudSync | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [conflicts, setConflicts] = useState<readonly CloudSyncConflict[]>([]);
  const [conflictsLoaded, setConflictsLoaded] = useState(false);
  const [hasMoreConflicts, setHasMoreConflicts] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestSequenceRef = useRef(0);

  const target = useMemo(
    () => (tenantId && workspaceId && projectId ? { tenantId, workspaceId, projectId } : null),
    [tenantId, workspaceId, projectId],
  );

  const refresh = useCallback(() => {
    if (!environmentId || !target) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    // A slow earlier read must not overwrite a later one's answer; progress
    // going backwards reads as a sync losing ground.
    requestSequenceRef.current += 1;
    const sequence = requestSequenceRef.current;
    const isCurrent = () => sequence === requestSequenceRef.current;

    api.cloudSync
      .getStatus(target)
      .then((result) => {
        if (!isCurrent()) {
          return;
        }
        setSync(result.sync);
        setReadError(null);
        setLoaded(true);

        if (!result.sync || result.sync.conflictCount === 0) {
          setConflicts([]);
          setHasMoreConflicts(false);
          setConflictsLoaded(true);
          return;
        }
        return api.cloudSync
          .listConflicts({ ...target, limit: CLOUD_SYNC_CONFLICT_PAGE })
          .then((page) => {
            if (!isCurrent()) {
              return;
            }
            setConflicts(page.conflicts);
            setHasMoreConflicts(page.nextCursor !== null);
            setConflictsLoaded(true);
          });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        // Kept rather than toasted: a read that fails on mount would otherwise
        // pop a toast at somebody who never asked for anything.
        setReadError(error);
        setLoaded(true);
      });
  }, [environmentId, target]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    refresh();
  }, [enabled, refresh]);

  const running =
    sync !== null &&
    (sync.status === "scanning" || sync.status === "transferring" || sync.activelyChanging);

  useEffect(() => {
    if (!enabled || !running) {
      return;
    }
    const timer = setInterval(refresh, CLOUD_SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, running, refresh]);

  const mutate = useCallback(
    async (
      fallbackTitle: string,
      run: (
        api: NonNullable<ReturnType<typeof readEnvironmentApi>>,
        scoped: {
          readonly tenantId: TenantId;
          readonly workspaceId: WorkspaceId;
          readonly projectId: ProjectId;
        },
      ) => Promise<unknown>,
    ): Promise<void> => {
      if (!environmentId || !target) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }
      setBusy(true);
      try {
        await run(api, target);
      } catch (error: unknown) {
        const notice = describeCloudSyncFailure(error, { fallbackTitle });
        toastManager.add({
          type: notice.tone,
          title: notice.title,
          description: notice.description,
        });
      } finally {
        setBusy(false);
        // Even a refusal moved something: `mode-locked` and `conflict-not-found`
        // both mean what is on screen no longer matches the server.
        refresh();
      }
    },
    [environmentId, refresh, target],
  );

  const start = useCallback(
    (mode: CloudSyncMode) =>
      mutate("Could not start syncing this project", (api, scoped) =>
        api.cloudSync.start({ ...scoped, mode }),
      ),
    [mutate],
  );

  const pause = useCallback(
    () => mutate("Could not pause the sync", (api, scoped) => api.cloudSync.pause(scoped)),
    [mutate],
  );

  const stop = useCallback(
    () => mutate("Could not stop the sync", (api, scoped) => api.cloudSync.stop(scoped)),
    [mutate],
  );

  const resolveConflict = useCallback(
    (conflictId: CloudSyncConflictId) =>
      mutate("Could not clear that conflict", (api, scoped) =>
        api.cloudSync.resolveConflict({ ...scoped, conflictId }),
      ),
    [mutate],
  );

  return {
    sync,
    wait: describeCloudSyncWait(deriveVisitorView(sync)),
    loaded,
    readError,
    conflicts,
    conflictsLoaded,
    hasMoreConflicts,
    busy,
    refresh,
    start,
    pause,
    stop,
    resolveConflict,
  };
}
