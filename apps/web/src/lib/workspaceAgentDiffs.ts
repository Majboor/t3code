import type { TurnId } from "@t3tools/contracts";

import type { TurnDiffSummary } from "../types";

export interface WorkspaceAgentDiffStat {
  additions: number;
  deletions: number;
}

export interface WorkspaceAgentFileDiff {
  path: string;
  turnId: TurnId;
  completedAt: string;
  checkpointTurnCount?: number;
  stat: WorkspaceAgentDiffStat;
}

function normalizeWorkspaceDiffPath(pathValue: string): string {
  return pathValue.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function compareWorkspaceAgentDiffs(
  left: WorkspaceAgentFileDiff,
  right: WorkspaceAgentFileDiff,
): number {
  const leftTurnCount = left.checkpointTurnCount ?? -1;
  const rightTurnCount = right.checkpointTurnCount ?? -1;
  if (leftTurnCount !== rightTurnCount) {
    return rightTurnCount - leftTurnCount;
  }
  return right.completedAt.localeCompare(left.completedAt);
}

export function buildWorkspaceAgentFileDiffHistory(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Partial<Record<TurnId, number>>,
): ReadonlyMap<string, ReadonlyArray<WorkspaceAgentFileDiff>> {
  const fileHistoryByPath = new Map<string, WorkspaceAgentFileDiff[]>();

  for (const summary of turnDiffSummaries) {
    const checkpointTurnCount =
      summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];

    for (const file of summary.files) {
      const path = normalizeWorkspaceDiffPath(file.path);
      if (path.length === 0) {
        continue;
      }

      const history = fileHistoryByPath.get(path) ?? [];
      history.push({
        path,
        turnId: summary.turnId,
        completedAt: summary.completedAt,
        ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
        stat: {
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        },
      });
      fileHistoryByPath.set(path, history);
    }
  }

  return new Map(
    Array.from(fileHistoryByPath.entries(), ([path, history]) => [
      path,
      history.toSorted(compareWorkspaceAgentDiffs),
    ]),
  );
}
