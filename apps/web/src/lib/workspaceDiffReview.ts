import type { FileDiffMetadata } from "@pierre/diffs/react";

type FileDiffHunk = FileDiffMetadata["hunks"][number];

export interface WorkspaceDiffReviewItem {
  id: string;
  index: number;
  additions: number;
  deletions: number;
  hunk: FileDiffHunk;
  lineLabel: string;
}

export function buildWorkspaceDiffReviewItems(
  fileDiff: FileDiffMetadata,
): ReadonlyArray<WorkspaceDiffReviewItem> {
  return fileDiff.hunks.map((hunk, index) => ({
    id: `${fileDiff.cacheKey ?? fileDiff.name}:hunk:${index}:${hunk.additionLineIndex}:${hunk.deletionLineIndex}`,
    index,
    additions: hunk.additionLines,
    deletions: hunk.deletionLines,
    hunk,
    lineLabel: `new ${hunk.additionStart}, old ${hunk.deletionStart}`,
  }));
}

export function buildWorkspaceFocusedFileDiff(
  fileDiff: FileDiffMetadata,
  selectedHunk: WorkspaceDiffReviewItem | null,
): FileDiffMetadata {
  if (selectedHunk === null) {
    return fileDiff;
  }

  const normalizedHunk: FileDiffHunk = {
    ...selectedHunk.hunk,
    collapsedBefore: 0,
    splitLineStart: 0,
    unifiedLineStart: 0,
  };

  return {
    ...fileDiff,
    hunks: [normalizedHunk],
    splitLineCount: normalizedHunk.splitLineCount,
    unifiedLineCount: normalizedHunk.unifiedLineCount,
  };
}
