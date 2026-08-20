import { describe, expect, it } from "vitest";

import { findContention, findWorkspaceContention } from "./contention.logic";

const NOW = Date.parse("2026-08-14T05:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const touch = (path: string, userId: string, minutesAgo: number) =>
  ({ path, userId, displayName: userId, touchedAt: at(minutesAgo) }) as never;

describe("findContention", () => {
  it("finds a file two people are both working on", () => {
    const contested = findContention([touch("app.py", "ana", 2), touch("app.py", "bo", 1)], {
      now: NOW,
    });
    expect(contested).toHaveLength(1);
    expect(contested[0]?.path).toBe("app.py");
    expect(contested[0]?.people.map((person) => person.userId)).toEqual(["bo", "ana"]);
  });

  it("does not call one person touching a file ten times a conflict", () => {
    const contested = findContention(
      [touch("app.py", "ana", 3), touch("app.py", "ana", 2), touch("app.py", "ana", 1)],
      { now: NOW },
    );
    expect(contested).toEqual([]);
  });

  it("forgets what happened yesterday", () => {
    // The information is only worth having while both are still working.
    const contested = findContention([touch("app.py", "ana", 60 * 24), touch("app.py", "bo", 1)], {
      now: NOW,
    });
    expect(contested).toEqual([]);
  });

  it("keeps files apart", () => {
    const contested = findContention([touch("a.py", "ana", 1), touch("b.py", "bo", 1)], {
      now: NOW,
    });
    expect(contested).toEqual([]);
  });

  it("puts the file somebody is still typing in first", () => {
    const contested = findContention(
      [
        touch("old.py", "ana", 10),
        touch("old.py", "bo", 9),
        touch("live.py", "ana", 2),
        touch("live.py", "bo", 1),
      ],
      { now: NOW },
    );
    expect(contested.map((entry) => entry.path)).toEqual(["live.py", "old.py"]);
  });

  it("ignores a timestamp it cannot read rather than treating it as now", () => {
    const contested = findContention(
      [
        { path: "a.py", userId: "ana", displayName: "ana", touchedAt: "not a date" } as never,
        touch("a.py", "bo", 1),
      ],
      { now: NOW },
    );
    expect(contested).toEqual([]);
  });
});

const held = (path: string, userId: string, kind: "person" | "agent", secondsAgo = 1) => ({
  path,
  userId,
  displayName: userId,
  kind,
  sourceId: `${kind}:${userId}`,
  refreshedAt: new Date(NOW - secondsAgo * 1_000).toISOString(),
});

describe("findWorkspaceContention", () => {
  it("suggests a branch when two people are in a file", () => {
    const rows = findWorkspaceContention({
      touches: [],
      presence: [held("app.py", "ana", "person"), held("app.py", "bo", "person")],
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("people-collide");
    expect(rows[0]?.suggestion).toContain("own branch");
  });

  it("stops suggesting a branch when the thing in the file is an agent", () => {
    // The branch is no answer here: the turn runs in the same worktree the
    // file is open in, so a branch changes nothing about what gets overwritten.
    const rows = findWorkspaceContention({
      touches: [],
      presence: [held("app.py", "ana", "person"), held("app.py", "bo", "agent")],
      nowMs: NOW,
    });
    expect(rows[0]?.outcome).toBe("agent-over-person");
    expect(rows[0]?.severity).toBe("urgent");
    expect(rows[0]?.suggestion).toContain("Stop the turn");
    expect(rows[0]?.suggestion).not.toContain("own branch");
  });

  it("puts the agent file above the merely contested one", () => {
    const rows = findWorkspaceContention({
      touches: [],
      presence: [
        held("z.py", "ana", "person"),
        held("z.py", "bo", "person"),
        held("a.py", "ana", "person"),
        held("a.py", "bo", "agent"),
      ],
      nowMs: NOW,
    });
    expect(rows.map((row) => row.path)).toEqual(["a.py", "z.py"]);
  });

  it("lets what is happening now speak over what happened recently", () => {
    const rows = findWorkspaceContention({
      touches: [touch("app.py", "ana", 2), touch("app.py", "bo", 1)],
      presence: [held("app.py", "ana", "person"), held("app.py", "bo", "agent")],
      nowMs: NOW,
    });
    // One row for the file, and it is the live one: two sentences about the
    // same path, one of them out of date, is how a warning stops being read.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("live");
  });

  it("still reports a file two people changed recently when nobody is in it now", () => {
    const rows = findWorkspaceContention({
      touches: [touch("app.py", "ana", 2), touch("app.py", "bo", 1)],
      presence: [],
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("recent");
    expect(rows[0]?.outcome).toBe("recent-touches");
    // History, said as history. Nothing here knows whether either is still in
    // the file, and a file written by a script outside the app has no author to
    // report at all.
    expect(rows[0]?.headline).toContain("recently");
  });

  it("forgets a person whose browser stopped saying it was there", () => {
    const rows = findWorkspaceContention({
      touches: [],
      presence: [held("app.py", "ana", "person", 1), held("app.py", "bo", "person", 60 * 60)],
      nowMs: NOW,
    });
    expect(rows).toEqual([]);
  });

  it("says nothing at all about an empty workspace", () => {
    expect(findWorkspaceContention({ touches: [], presence: [], nowMs: NOW })).toEqual([]);
  });
});
