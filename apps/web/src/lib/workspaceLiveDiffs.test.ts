import { describe, expect, it } from "vitest";

import { buildWorkspaceLiveTurnDiffStatByPath } from "./workspaceLiveDiffs";

describe("buildWorkspaceLiveTurnDiffStatByPath", () => {
  it("ignores files that were already dirty before the turn started", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [
        { path: "src/app.ts", insertions: 1, deletions: 0 },
        { path: "src/new.ts", insertions: 1, deletions: 0 },
      ],
      [{ path: "src/app.ts", insertions: 1, deletions: 0 }],
    );

    expect(liveDiffs.get("src/app.ts")).toBeUndefined();
    expect(liveDiffs.get("src/new.ts")).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps files whose diff stats changed during the turn", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [{ path: "src/app.ts", insertions: 2, deletions: 1 }],
      [{ path: "src/app.ts", insertions: 1, deletions: 1 }],
    );

    expect(liveDiffs.get("src/app.ts")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});
