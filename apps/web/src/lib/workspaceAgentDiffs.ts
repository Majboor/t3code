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

export interface WorkspaceAgentDiffIndex {
  fileHistoryByPath: ReadonlyMap<string, ReadonlyArray<WorkspaceAgentFileDiff>>;
  turnFilesByTurnId: ReadonlyMap<TurnId, ReadonlyArray<WorkspaceAgentFileDiff>>;
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

function compareWorkspaceAgentDiffPaths(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortWorkspaceAgentDiffHistoryByPath(
  fileHistoryByPath: Map<string, WorkspaceAgentFileDiff[]>,
): ReadonlyMap<string, ReadonlyArray<WorkspaceAgentFileDiff>> {
  return new Map(
    Array.from(fileHistoryByPath.entries(), ([path, history]) => [
      path,
      history.toSorted(compareWorkspaceAgentDiffs),
    ]),
  );
}

function sortWorkspaceAgentTurnFilesByTurnId(
  turnFilesByTurnId: Map<TurnId, WorkspaceAgentFileDiff[]>,
): ReadonlyMap<TurnId, ReadonlyArray<WorkspaceAgentFileDiff>> {
  return new Map(
    Array.from(turnFilesByTurnId.entries(), ([turnId, files]) => [
      turnId,
      files.toSorted((left, right) => compareWorkspaceAgentDiffPaths(left.path, right.path)),
    ]),
  );
}

export function buildWorkspaceAgentDiffIndex(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Partial<Record<TurnId, number>>,
): WorkspaceAgentDiffIndex {
  const fileHistoryByPath = new Map<string, WorkspaceAgentFileDiff[]>();
  const turnFilesByTurnId = new Map<TurnId, WorkspaceAgentFileDiff[]>();

  for (const summary of turnDiffSummaries) {
    const checkpointTurnCount =
      summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
    const turnFiles: WorkspaceAgentFileDiff[] = [];

    for (const file of summary.files) {
      const path = normalizeWorkspaceDiffPath(file.path);
      if (path.length === 0) {
        continue;
      }

      const entry: WorkspaceAgentFileDiff = {
        path,
        turnId: summary.turnId,
        completedAt: summary.completedAt,
        ...(checkpointTurnCount !== undefined ? { checkpointTurnCount } : {}),
        stat: {
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        },
      };
      turnFiles.push(entry);

      const history = fileHistoryByPath.get(path) ?? [];
      history.push(entry);
      fileHistoryByPath.set(path, history);
    }

    if (turnFiles.length > 0) {
      turnFilesByTurnId.set(summary.turnId, turnFiles);
    }
  }

  return {
    fileHistoryByPath: sortWorkspaceAgentDiffHistoryByPath(fileHistoryByPath),
    turnFilesByTurnId: sortWorkspaceAgentTurnFilesByTurnId(turnFilesByTurnId),
  };
}

export function buildWorkspaceAgentFileDiffHistory(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Partial<Record<TurnId, number>>,
): ReadonlyMap<string, ReadonlyArray<WorkspaceAgentFileDiff>> {
  return buildWorkspaceAgentDiffIndex(turnDiffSummaries, inferredCheckpointTurnCountByTurnId)
    .fileHistoryByPath;
}

export function buildWorkspaceAgentTurnFileDiffHistory(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Partial<Record<TurnId, number>>,
): ReadonlyMap<TurnId, ReadonlyArray<WorkspaceAgentFileDiff>> {
  return buildWorkspaceAgentDiffIndex(turnDiffSummaries, inferredCheckpointTurnCountByTurnId)
    .turnFilesByTurnId;
}
