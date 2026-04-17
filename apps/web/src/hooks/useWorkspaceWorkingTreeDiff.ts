import { useQuery } from "@tanstack/react-query";
import { type EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";

import { getRenderablePatch, resolveFileDiffPath } from "../lib/patchDiff";

export function useWorkspaceWorkingTreeDiff(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  relativePath: string | null;
  resolvedTheme: "light" | "dark";
  cacheScope: string;
  enabled?: boolean;
}) {
  const activeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      environmentId: input.environmentId,
      cwd: input.cwd,
      relativePath: input.relativePath,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }),
  );

  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        activeDiffQuery.data?.diff,
        `${input.cacheScope}:${input.relativePath ?? "none"}:${input.resolvedTheme}`,
      ),
    [activeDiffQuery.data?.diff, input.cacheScope, input.relativePath, input.resolvedTheme],
  );

  const renderableFile = useMemo(() => {
    if (!input.relativePath || !renderablePatch || renderablePatch.kind !== "files") {
      return null;
    }
    return (
      renderablePatch.files.find(
        (fileDiff) => resolveFileDiffPath(fileDiff) === input.relativePath,
      ) ?? null
    );
  }, [input.relativePath, renderablePatch]);

  const diffError =
    activeDiffQuery.error instanceof Error
      ? activeDiffQuery.error.message
      : activeDiffQuery.error
        ? "Failed to load workspace diff preview."
        : null;

  return {
    activeDiffQuery,
    diffError,
    renderableFile,
    renderablePatch,
  };
}
