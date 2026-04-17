import { describe, expect, it } from "vitest";

import { getRenderablePatch } from "./patchDiff";
import {
  buildWorkspaceDiffReviewItems,
  buildWorkspaceFocusedFileDiff,
} from "./workspaceDiffReview";

describe("workspaceDiffReview", () => {
  it("builds stable review items and can focus a single hunk", () => {
    const patch = [
      "diff --git a/src/live.ts b/src/live.ts",
      "index 1111111..2222222 100644",
      "--- a/src/live.ts",
      "+++ b/src/live.ts",
      "@@ -1 +1 @@",
      "-export const first = false;",
      "+export const first = true;",
      "@@ -3 +3 @@",
      "-export const second = false;",
      "+export const second = true;",
    ].join("\n");
    const renderablePatch = getRenderablePatch(patch, "workspace-diff-review-test");

    expect(renderablePatch?.kind).toBe("files");
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return;
    }

    const fileDiff = renderablePatch.files[0];
    expect(fileDiff).toBeTruthy();
    if (!fileDiff) {
      return;
    }

    const reviewItems = buildWorkspaceDiffReviewItems(fileDiff);

    expect(reviewItems).toHaveLength(2);
    expect(reviewItems[0]).toMatchObject({
      index: 0,
      additions: 1,
      deletions: 1,
      lineLabel: "new 1, old 1",
    });
    expect(reviewItems[1]).toMatchObject({
      index: 1,
      additions: 1,
      deletions: 1,
      lineLabel: "new 3, old 3",
    });

    const focusedFileDiff = buildWorkspaceFocusedFileDiff(fileDiff, reviewItems[1] ?? null);

    expect(focusedFileDiff.hunks).toHaveLength(1);
    expect(focusedFileDiff.hunks[0]?.additionStart).toBe(3);
    expect(focusedFileDiff.hunks[0]?.deletionStart).toBe(3);
    expect(focusedFileDiff.splitLineCount).toBe(focusedFileDiff.hunks[0]?.splitLineCount);
    expect(focusedFileDiff.unifiedLineCount).toBe(focusedFileDiff.hunks[0]?.unifiedLineCount);
  });
});
