import { describe, expect, it } from "vitest";

import {
  createWorkspaceDirectoryRelistGate,
  WORKSPACE_DIRECTORY_RELIST_MIN_INTERVAL_MS,
} from "./workspaceTreePoll.logic";

describe("workspace directory relist gate", () => {
  it("lets a first re-list through and holds the next one back", () => {
    const gate = createWorkspaceDirectoryRelistGate();

    expect(gate.claim(["", "src"], { now: 0 })).toEqual(["", "src"]);
    gate.release(["", "src"]);

    expect(gate.claim(["", "src"], { now: 1_000 })).toEqual([]);
    expect(gate.claim(["", "src"], { now: WORKSPACE_DIRECTORY_RELIST_MIN_INTERVAL_MS })).toEqual([
      "",
      "src",
    ]);
  });

  it("drops a directory that is still in flight, even for an explicit refresh", () => {
    const gate = createWorkspaceDirectoryRelistGate();

    expect(gate.claim(["src"], { now: 0 })).toEqual(["src"]);
    expect(gate.claim(["src"], { now: 10_000 })).toEqual([]);
    expect(gate.claim(["src"], { now: 10_000, immediate: true })).toEqual([]);

    gate.release(["src"]);
    expect(gate.claim(["src"], { now: 10_000, immediate: true })).toEqual(["src"]);
  });

  it("lets an explicit refresh skip the interval", () => {
    const gate = createWorkspaceDirectoryRelistGate();

    gate.claim(["src"], { now: 0 });
    gate.release(["src"]);

    expect(gate.claim(["src"], { now: 500 })).toEqual([]);
    expect(gate.claim(["src"], { now: 500, immediate: true })).toEqual(["src"]);
  });

  it("only holds back the directories it has already seen", () => {
    const gate = createWorkspaceDirectoryRelistGate();

    gate.claim(["", "src"], { now: 0 });
    gate.release(["", "src"]);

    expect(gate.claim(["", "src", "src/lib"], { now: 1_000 })).toEqual(["src/lib"]);
  });

  it("honours a caller-supplied interval", () => {
    const gate = createWorkspaceDirectoryRelistGate({ minIntervalMs: 100 });

    gate.claim(["src"], { now: 0 });
    gate.release(["src"]);

    expect(gate.claim(["src"], { now: 50 })).toEqual([]);
    expect(gate.claim(["src"], { now: 150 })).toEqual(["src"]);
  });
});
