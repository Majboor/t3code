import { describe, expect, it } from "vitest";

import { buildWorkspaceLiveTurnDiffStatByPath } from "./workspaceLiveDiffs";

describe("buildWorkspaceLiveTurnDiffStatByPath", () => {
  it("ignores files that were already dirty before the turn started", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [
        { path: "src/app.ts", status: "modified", insertions: 1, deletions: 0 },
        { path: "src/new.ts", status: "untracked", insertions: 1, deletions: 0 },
      ],
      [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 0 }],
    );

    expect(liveDiffs.get("src/app.ts")).toBeUndefined();
    expect(liveDiffs.get("src/new.ts")).toEqual({
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps files whose diff stats changed during the turn", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [{ path: "src/app.ts", status: "modified", insertions: 2, deletions: 1 }],
      [{ path: "src/app.ts", status: "modified", insertions: 1, deletions: 1 }],
    );

    expect(liveDiffs.get("src/app.ts")).toEqual({
      additions: 2,
      deletions: 1,
    });
  });

  it("surfaces deletions that disappear from the working tree during the turn", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [],
      [{ path: "src/app.ts", status: "modified", insertions: 0, deletions: 0 }],
    );

    expect(liveDiffs.get("src/app.ts")).toEqual({
      additions: 0,
      deletions: 0,
    });
  });

  it("surfaces a status change even when stat counts are unchanged", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [{ path: "src/app.ts", status: "deleted", insertions: 0, deletions: 10 }],
      [{ path: "src/app.ts", status: "modified", insertions: 0, deletions: 10 }],
    );

    expect(liveDiffs.get("src/app.ts")).toEqual({
      additions: 0,
      deletions: 10,
    });
  });

  it("surfaces a patch signature change even when stat counts are unchanged", () => {
    const liveDiffs = buildWorkspaceLiveTurnDiffStatByPath(
      [
        {
          path: "src/app.ts",
          status: "modified",
          insertions: 1,
          deletions: 1,
          diffSignature: "after",
        },
      ],
      [
        {
          path: "src/app.ts",
          status: "modified",
          insertions: 1,
          deletions: 1,
          diffSignature: "before",
        },
      ],
    );

    expect(liveDiffs.get("src/app.ts")).toEqual({
      additions: 1,
      deletions: 1,
      diffSignature: "after",
    });
  });
});
