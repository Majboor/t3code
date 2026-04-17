import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { TurnDiffSummary } from "../types";
import {
  buildWorkspaceAgentDiffIndex,
  buildWorkspaceAgentFileDiffHistory,
  buildWorkspaceAgentTurnFileDiffHistory,
} from "./workspaceAgentDiffs";

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

  it("groups changed files by turn and sorts file paths predictably", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const turnFiles = buildWorkspaceAgentTurnFileDiffHistory(
      [
        {
          turnId: firstTurnId,
          completedAt: "2026-04-16T09:00:00.000Z",
          files: [
            { path: "src/z-last.ts", additions: 3, deletions: 1 },
            { path: "src/a-first.ts", additions: 1, deletions: 0 },
          ],
        },
        {
          turnId: secondTurnId,
          completedAt: "2026-04-16T10:00:00.000Z",
          checkpointTurnCount: 4,
          files: [{ path: "src/middle.ts", additions: 2, deletions: 2 }],
        },
      ] satisfies TurnDiffSummary[],
      {
        [firstTurnId]: 2,
      },
    );

    expect(turnFiles.get(firstTurnId)).toEqual([
      {
        path: "src/a-first.ts",
        turnId: firstTurnId,
        completedAt: "2026-04-16T09:00:00.000Z",
        checkpointTurnCount: 2,
        stat: { additions: 1, deletions: 0 },
      },
      {
        path: "src/z-last.ts",
        turnId: firstTurnId,
        completedAt: "2026-04-16T09:00:00.000Z",
        checkpointTurnCount: 2,
        stat: { additions: 3, deletions: 1 },
      },
    ]);
    expect(turnFiles.get(secondTurnId)).toEqual([
      {
        path: "src/middle.ts",
        turnId: secondTurnId,
        completedAt: "2026-04-16T10:00:00.000Z",
        checkpointTurnCount: 4,
        stat: { additions: 2, deletions: 2 },
      },
    ]);
  });

  it("builds file and turn indexes from the same normalized entries", () => {
    const turnId = TurnId.make("turn-1");
    const index = buildWorkspaceAgentDiffIndex(
      [
        {
          turnId,
          completedAt: "2026-04-16T09:00:00.000Z",
          files: [
            { path: "\\src\\index.ts", additions: 2, deletions: 0 },
            { path: "src/utils.ts", additions: 0, deletions: 1 },
          ],
        },
      ] satisfies TurnDiffSummary[],
      {
        [turnId]: 5,
      },
    );

    expect(index.fileHistoryByPath.get("src/index.ts")?.[0]).toEqual(
      index.turnFilesByTurnId.get(turnId)?.[0],
    );
    expect(index.turnFilesByTurnId.get(turnId)?.map((entry) => entry.path)).toEqual([
      "src/index.ts",
      "src/utils.ts",
    ]);
  });
});
