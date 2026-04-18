import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { TurnDiffSummary } from "../types";
import { buildWorkspaceAgentFileDiffHistory } from "./workspaceAgentDiffs";

describe("buildWorkspaceAgentFileDiffHistory", () => {
  it("groups file changes by path and sorts the latest turn first", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thirdTurnId = TurnId.make("turn-3");
    const histories = buildWorkspaceAgentFileDiffHistory(
      [
        {
          turnId: firstTurnId,
          completedAt: "2026-04-16T09:00:00.000Z",
          files: [{ path: "src/app.tsx", additions: 2, deletions: 1 }],
        },
        {
          turnId: secondTurnId,
          completedAt: "2026-04-16T10:00:00.000Z",
          files: [{ path: "src/app.tsx", additions: 5, deletions: 0 }],
        },
        {
          turnId: thirdTurnId,
          completedAt: "2026-04-16T11:00:00.000Z",
          checkpointTurnCount: 7,
          files: [{ path: "src/app.tsx", additions: 1, deletions: 4 }],
        },
      ] satisfies TurnDiffSummary[],
      {
        [firstTurnId]: 2,
        [secondTurnId]: 3,
      },
    );

    expect(histories.get("src/app.tsx")).toEqual([
      {
        path: "src/app.tsx",
        turnId: thirdTurnId,
        completedAt: "2026-04-16T11:00:00.000Z",
        checkpointTurnCount: 7,
        stat: { additions: 1, deletions: 4 },
      },
      {
        path: "src/app.tsx",
        turnId: secondTurnId,
        completedAt: "2026-04-16T10:00:00.000Z",
        checkpointTurnCount: 3,
        stat: { additions: 5, deletions: 0 },
      },
      {
        path: "src/app.tsx",
        turnId: firstTurnId,
        completedAt: "2026-04-16T09:00:00.000Z",
        checkpointTurnCount: 2,
        stat: { additions: 2, deletions: 1 },
      },
    ]);
  });

  it("normalizes path separators and fills in missing diff stats", () => {
    const turnId = TurnId.make("turn-1");
    const histories = buildWorkspaceAgentFileDiffHistory(
      [
        {
          turnId,
          completedAt: "2026-04-16T09:00:00.000Z",
          files: [{ path: "\\src\\index.ts" }],
        },
      ] satisfies TurnDiffSummary[],
      {},
    );

    expect(histories.get("src/index.ts")).toEqual([
      {
        path: "src/index.ts",
        turnId,
        completedAt: "2026-04-16T09:00:00.000Z",
        stat: { additions: 0, deletions: 0 },
      },
    ]);
  });
});
