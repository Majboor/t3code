import { describe, expect, it, beforeEach } from "vitest";

import {
  clearPendingWorkspaceLiveDiffBaselineForThread,
  resetWorkspaceLiveDiffBaselineStateForTests,
  setPendingWorkspaceLiveDiffBaselineForThread,
  takePendingWorkspaceLiveDiffBaselineForThread,
} from "./workspaceLiveDiffBaselineState";

describe("workspaceLiveDiffBaselineState", () => {
  beforeEach(() => {
    resetWorkspaceLiveDiffBaselineStateForTests();
  });

  it("stores and consumes a pending baseline for the matching thread and cwd", () => {
    setPendingWorkspaceLiveDiffBaselineForThread({
      environmentId: "environment-local" as never,
      threadId: "thread-1" as never,
      cwd: "/repo/project",
      isRepo: true,
      files: [{ path: "app.ts", status: "modified", insertions: 1, deletions: 0 }],
    });

    expect(
      takePendingWorkspaceLiveDiffBaselineForThread({
        environmentId: "environment-local" as never,
        threadId: "thread-1" as never,
        cwd: "/repo/project",
      }),
    ).toEqual({
      cwd: "/repo/project",
      isRepo: true,
      files: [{ path: "app.ts", status: "modified", insertions: 1, deletions: 0 }],
    });

    expect(
      takePendingWorkspaceLiveDiffBaselineForThread({
        environmentId: "environment-local" as never,
        threadId: "thread-1" as never,
        cwd: "/repo/project",
      }),
    ).toBeNull();
  });

  it("drops a pending baseline when the workspace root no longer matches", () => {
    setPendingWorkspaceLiveDiffBaselineForThread({
      environmentId: "environment-local" as never,
      threadId: "thread-1" as never,
      cwd: "/repo/project",
      isRepo: true,
      files: [],
    });

    expect(
      takePendingWorkspaceLiveDiffBaselineForThread({
        environmentId: "environment-local" as never,
        threadId: "thread-1" as never,
        cwd: "/repo/other",
      }),
    ).toBeNull();

    expect(
      takePendingWorkspaceLiveDiffBaselineForThread({
        environmentId: "environment-local" as never,
        threadId: "thread-1" as never,
        cwd: "/repo/project",
      }),
    ).toBeNull();
  });

  it("clears a pending baseline explicitly", () => {
    setPendingWorkspaceLiveDiffBaselineForThread({
      environmentId: "environment-local" as never,
      threadId: "thread-1" as never,
      cwd: "/repo/project",
      isRepo: true,
      files: [],
    });

    clearPendingWorkspaceLiveDiffBaselineForThread({
      environmentId: "environment-local" as never,
      threadId: "thread-1" as never,
    });

    expect(
      takePendingWorkspaceLiveDiffBaselineForThread({
        environmentId: "environment-local" as never,
        threadId: "thread-1" as never,
        cwd: "/repo/project",
      }),
    ).toBeNull();
  });
});
