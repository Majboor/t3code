import { describe, expect, it } from "vitest";

import { findContention } from "./contention.logic";

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
