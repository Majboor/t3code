import { useQuery } from "@tanstack/react-query";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";

import { getRenderablePatch, resolveFileDiffPath } from "../lib/patchDiff";
import { type WorkspaceAgentFileDiff } from "../lib/workspaceAgentDiffs";

export function useWorkspaceAgentTurnDiff(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  selectedHistoryEntry: WorkspaceAgentFileDiff | null;
  targetFilePath: string | null;
  resolvedTheme: "light" | "dark";
  cacheScope: string;
}) {
  const checkpointRange = useMemo(() => {
    if (typeof input.selectedHistoryEntry?.checkpointTurnCount !== "number") {
      return null;
    }
    return {
      fromTurnCount: Math.max(0, input.selectedHistoryEntry.checkpointTurnCount - 1),
      toTurnCount: input.selectedHistoryEntry.checkpointTurnCount,
    };
  }, [input.selectedHistoryEntry?.checkpointTurnCount]);

  const activeDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: input.environmentId,
      threadId: input.threadId,
      fromTurnCount: checkpointRange?.fromTurnCount ?? null,
      toTurnCount: checkpointRange?.toTurnCount ?? null,
      cacheScope: input.selectedHistoryEntry
        ? `${input.cacheScope}:${input.selectedHistoryEntry.turnId}`
        : null,
      enabled: input.selectedHistoryEntry !== null && checkpointRange !== null,
    }),
  );

  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        activeDiffQuery.data?.diff,
        input.selectedHistoryEntry
          ? `${input.cacheScope}:${input.selectedHistoryEntry.turnId}:${input.resolvedTheme}`
          : input.cacheScope,
      ),
    [activeDiffQuery.data?.diff, input.cacheScope, input.resolvedTheme, input.selectedHistoryEntry],
  );

  const renderableFile = useMemo(() => {
    if (!input.targetFilePath || !renderablePatch || renderablePatch.kind !== "files") {
      return null;
    }
    return (
      renderablePatch.files.find(
        (fileDiff) => resolveFileDiffPath(fileDiff) === input.targetFilePath,
      ) ?? null
    );
  }, [input.targetFilePath, renderablePatch]);

  const diffError =
    activeDiffQuery.error instanceof Error
      ? activeDiffQuery.error.message
      : activeDiffQuery.error
        ? "Failed to load agent diff preview."
        : null;

  return {
    activeDiffQuery,
    checkpointRange,
    diffError,
    renderableFile,
    renderablePatch,
  };
}
