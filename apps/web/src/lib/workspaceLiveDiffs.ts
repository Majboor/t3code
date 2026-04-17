import type { WorkspaceAgentDiffStat } from "./workspaceAgentDiffs";
import { normalizeWorkspaceDiffPath } from "./workspaceAgentDiffs";

interface WorkspaceWorkingTreeFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

function buildWorkspaceWorkingTreeStatMap(
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
): ReadonlyMap<string, WorkspaceAgentDiffStat> {
  const statByPath = new Map<string, WorkspaceAgentDiffStat>();

  for (const file of files) {
    const path = normalizeWorkspaceDiffPath(file.path);
    if (path.length === 0) {
      continue;
    }

    statByPath.set(path, {
      additions: file.insertions,
      deletions: file.deletions,
    });
  }

  return statByPath;
}

export function buildWorkspaceLiveTurnDiffStatByPath(
  currentFiles: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
  baselineFiles: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
): ReadonlyMap<string, WorkspaceAgentDiffStat> {
  const baselineStatByPath = buildWorkspaceWorkingTreeStatMap(baselineFiles);
  const liveDiffStatByPath = new Map<string, WorkspaceAgentDiffStat>();

  for (const file of currentFiles) {
    const path = normalizeWorkspaceDiffPath(file.path);
    if (path.length === 0) {
      continue;
    }

    const currentStat = {
      additions: file.insertions,
      deletions: file.deletions,
    } satisfies WorkspaceAgentDiffStat;
    const baselineStat = baselineStatByPath.get(path) ?? null;
    if (
      baselineStat !== null &&
      baselineStat.additions === currentStat.additions &&
      baselineStat.deletions === currentStat.deletions
    ) {
      continue;
    }

    liveDiffStatByPath.set(path, currentStat);
  }

  return liveDiffStatByPath;
}
