import type { GitWorkingTreeFileStatus } from "@t3tools/contracts";

import type { WorkspaceAgentDiffStat } from "./workspaceAgentDiffs";
import { normalizeWorkspaceDiffPath } from "./workspaceAgentDiffs";

export interface WorkspaceWorkingTreeFileStat {
  path: string;
  status: GitWorkingTreeFileStatus;
  insertions: number;
  deletions: number;
}

interface WorkspaceBaselineEntry extends WorkspaceAgentDiffStat {
  status: GitWorkingTreeFileStatus;
}

function buildWorkspaceWorkingTreeBaselineMap(
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
): ReadonlyMap<string, WorkspaceBaselineEntry> {
  const baselineByPath = new Map<string, WorkspaceBaselineEntry>();

  for (const file of files) {
    const path = normalizeWorkspaceDiffPath(file.path);
    if (path.length === 0) {
      continue;
    }

    baselineByPath.set(path, {
      additions: file.insertions,
      deletions: file.deletions,
      status: file.status,
    });
  }

  return baselineByPath;
}

// Compare the current working tree to the baseline captured when the turn started, and emit
// a stat entry per file that meaningfully changed during the turn. Deletions are surfaced
// even when git shows no entry for them anymore by consulting the baseline.
export function buildWorkspaceLiveTurnDiffStatByPath(
  currentFiles: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
  baselineFiles: ReadonlyArray<WorkspaceWorkingTreeFileStat>,
): ReadonlyMap<string, WorkspaceAgentDiffStat> {
  const baselineByPath = buildWorkspaceWorkingTreeBaselineMap(baselineFiles);
  const liveDiffStatByPath = new Map<string, WorkspaceAgentDiffStat>();
  const seenPaths = new Set<string>();

  for (const file of currentFiles) {
    const path = normalizeWorkspaceDiffPath(file.path);
    if (path.length === 0) {
      continue;
    }
    seenPaths.add(path);

    const currentStat: WorkspaceAgentDiffStat = {
      additions: file.insertions,
      deletions: file.deletions,
    };
    const baseline = baselineByPath.get(path);
    if (
      baseline !== undefined &&
      baseline.additions === currentStat.additions &&
      baseline.deletions === currentStat.deletions &&
      baseline.status === file.status
    ) {
      continue;
    }

    liveDiffStatByPath.set(path, currentStat);
  }

  // A file present in baseline but absent from the current working tree means the agent
  // deleted (or un-untracked) it during the turn — emit a synthetic entry so review UI sees it.
  for (const [path, baseline] of baselineByPath) {
    if (seenPaths.has(path)) continue;
    liveDiffStatByPath.set(path, { additions: 0, deletions: baseline.deletions });
  }

  return liveDiffStatByPath;
}
