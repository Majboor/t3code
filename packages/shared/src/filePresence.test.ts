import { describe, expect, it } from "vitest";

import {
  AGENT_PRESENCE_TTL_MS,
  decideFilePresence,
  decideFilePresenceAcross,
  filePresenceTtlMs,
  isFilePresenceLive,
  liveFilePresence,
  occupantsOfFile,
  peopleHoldingFiles,
  PERSON_PRESENCE_TTL_MS,
  type FilePresenceEntry,
  type FilePresenceKind,
} from "./filePresence.ts";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function entry(
  overrides: Partial<FilePresenceEntry> & { kind: FilePresenceKind },
): FilePresenceEntry {
  return {
    path: "src/app.ts",
    userId: "user:maya",
    displayName: "Maya",
    sourceId: "page:1",
    refreshedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const person = (overrides: Partial<FilePresenceEntry> = {}) =>
  entry({ kind: "person", ...overrides });
const agent = (overrides: Partial<FilePresenceEntry> = {}) =>
  entry({ kind: "agent", sourceId: "thread:1", ...overrides });

describe("filePresenceTtlMs", () => {
  it("gives an agent longer than a person, because a turn thinks between writes", () => {
    expect(filePresenceTtlMs("person")).toBe(PERSON_PRESENCE_TTL_MS);
    expect(filePresenceTtlMs("agent")).toBe(AGENT_PRESENCE_TTL_MS);
    expect(AGENT_PRESENCE_TTL_MS).toBeGreaterThan(PERSON_PRESENCE_TTL_MS);
  });

  it("takes an override per kind", () => {
    expect(filePresenceTtlMs("person", { personMs: 10 })).toBe(10);
    expect(filePresenceTtlMs("agent", { agentMs: 20 })).toBe(20);
    expect(filePresenceTtlMs("person", { agentMs: 20 })).toBe(PERSON_PRESENCE_TTL_MS);
  });
});

describe("isFilePresenceLive", () => {
  it("believes a claim inside its window", () => {
    expect(isFilePresenceLive(person(), NOW, { personMs: 1_000 })).toBe(true);
  });

  it("believes a claim exactly on the boundary", () => {
    const stale = person({ refreshedAt: new Date(NOW - 1_000).toISOString() });
    expect(isFilePresenceLive(stale, NOW, { personMs: 1_000 })).toBe(true);
  });

  it("stops believing a claim one millisecond past it", () => {
    const stale = person({ refreshedAt: new Date(NOW - 1_001).toISOString() });
    expect(isFilePresenceLive(stale, NOW, { personMs: 1_000 })).toBe(false);
  });

  it("expires a person before an agent from the same instant", () => {
    const at = new Date(NOW - PERSON_PRESENCE_TTL_MS - 1).toISOString();
    expect(isFilePresenceLive(person({ refreshedAt: at }), NOW)).toBe(false);
    expect(isFilePresenceLive(agent({ refreshedAt: at }), NOW)).toBe(true);
  });

  it("tolerates a clock a little ahead rather than losing the person", () => {
    const ahead = person({ refreshedAt: new Date(NOW + 5_000).toISOString() });
    expect(isFilePresenceLive(ahead, NOW, { personMs: 1_000 })).toBe(true);
  });

  it("refuses a timestamp it cannot read", () => {
    expect(isFilePresenceLive(person({ refreshedAt: "not a date" }), NOW)).toBe(false);
  });
});

describe("liveFilePresence", () => {
  it("drops the expired and keeps the rest", () => {
    const kept = person({ userId: "user:ada", sourceId: "page:2" });
    const dropped = person({
      userId: "user:sam",
      sourceId: "page:3",
      refreshedAt: new Date(NOW - 10_000).toISOString(),
    });
    expect(liveFilePresence([kept, dropped], NOW, { personMs: 1_000 })).toEqual([kept]);
  });

  it("is empty for an empty input", () => {
    expect(liveFilePresence([], NOW)).toEqual([]);
  });
});

describe("occupantsOfFile", () => {
  it("counts one person once however many pages they have open", () => {
    const occupants = occupantsOfFile([
      person({ sourceId: "page:1" }),
      person({ sourceId: "page:2" }),
    ]);
    expect(occupants.people).toHaveLength(1);
    expect(occupants.agents).toEqual([]);
  });

  it("keeps the freshest of a person's duplicate claims", () => {
    const occupants = occupantsOfFile([
      person({ sourceId: "page:1", refreshedAt: new Date(NOW - 5_000).toISOString() }),
      person({ sourceId: "page:2" }),
    ]);
    expect(occupants.people[0]?.sourceId).toBe("page:2");
  });

  it("counts one person's two turns as two agents, because they race each other", () => {
    const occupants = occupantsOfFile([
      agent({ sourceId: "thread:1" }),
      agent({ sourceId: "thread:2" }),
    ]);
    expect(occupants.agents).toHaveLength(2);
    expect(occupants.people).toEqual([]);
  });

  it("orders each population most recently seen first", () => {
    const occupants = occupantsOfFile([
      person({
        userId: "user:ada",
        displayName: "Ada",
        sourceId: "page:2",
        refreshedAt: new Date(NOW - 9_000).toISOString(),
      }),
      person({ userId: "user:maya", sourceId: "page:1" }),
    ]);
    expect(occupants.people.map((occupant) => occupant.userId)).toEqual(["user:maya", "user:ada"]);
  });
});

describe("decideFilePresence", () => {
  it("says nothing about an empty file", () => {
    const verdict = decideFilePresence({ path: "src/app.ts", entries: [], nowMs: NOW });
    expect(verdict.outcome).toBe("quiet");
    expect(verdict.severity).toBe("none");
    expect(verdict.headline).toBe("");
    expect(verdict.suggestion).toBe("");
  });

  it("says nothing about one person alone", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [person()],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("quiet");
    expect(verdict.people).toHaveLength(1);
  });

  it("says nothing about one agent alone — an agent in an empty file is just work", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [agent()],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("quiet");
    expect(verdict.agents).toHaveLength(1);
  });

  it("calls two people a collision and suggests a branch", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", displayName: "Maya", sourceId: "page:1" }),
        person({ userId: "user:ada", displayName: "Ada", sourceId: "page:2" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("people-collide");
    expect(verdict.severity).toBe("warn");
    expect(verdict.suggestion).toContain("own branch");
  });

  it("stops suggesting a branch to somebody who already has one", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", displayName: "Maya", sourceId: "page:1" }),
        person({ userId: "user:ada", displayName: "Ada", sourceId: "page:2" }),
      ],
      nowMs: NOW,
      viewerHasOwnBranch: true,
    });
    expect(verdict.outcome).toBe("people-collide");
    expect(verdict.suggestion).toContain("You are on your own branch");
  });

  it("names both people", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", displayName: "Maya", sourceId: "page:1" }),
        person({ userId: "user:ada", displayName: "Ada", sourceId: "page:2" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.headline).toContain("Maya");
    expect(verdict.headline).toContain("Ada");
  });

  it("treats an agent over a person as urgent, not as another collision", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:ada", displayName: "Ada", sourceId: "page:2" }),
        agent({ userId: "user:maya", displayName: "Maya", sourceId: "thread:1" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("agent-over-person");
    expect(verdict.severity).toBe("urgent");
    expect(verdict.suggestion).toContain("Stop the turn");
    expect(verdict.suggestion).not.toContain("own branch");
  });

  it("warns just as loudly when the person and the agent are the same human", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", displayName: "Maya", sourceId: "page:1" }),
        agent({ userId: "user:maya", displayName: "Maya", sourceId: "thread:1" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("agent-over-person");
    expect(verdict.severity).toBe("urgent");
  });

  it("prefers the agent warning when two people and an agent are all in one file", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", displayName: "Maya", sourceId: "page:1" }),
        person({ userId: "user:ada", displayName: "Ada", sourceId: "page:2" }),
        agent({ userId: "user:sam", displayName: "Sam", sourceId: "thread:1" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("agent-over-person");
    expect(verdict.people).toHaveLength(2);
    expect(verdict.agents).toHaveLength(1);
  });

  it("warns about two turns racing with nobody watching", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        agent({ userId: "user:maya", displayName: "Maya", sourceId: "thread:1" }),
        agent({ userId: "user:ada", displayName: "Ada", sourceId: "thread:2" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("agents-collide");
    expect(verdict.severity).toBe("warn");
    expect(verdict.headline).toContain("2 agent turns");
  });

  it("ignores claims on other paths", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", sourceId: "page:1" }),
        person({ userId: "user:ada", sourceId: "page:2", path: "src/other.ts" }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("quiet");
  });

  it("goes quiet once the second person's claim expires", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", sourceId: "page:1" }),
        person({
          userId: "user:ada",
          sourceId: "page:2",
          refreshedAt: new Date(NOW - PERSON_PRESENCE_TTL_MS - 1).toISOString(),
        }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("quiet");
  });

  it("drops the agent warning once the turn's claim goes stale", () => {
    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: [
        person({ userId: "user:maya", sourceId: "page:1" }),
        agent({
          userId: "user:ada",
          sourceId: "thread:1",
          refreshedAt: new Date(NOW - AGENT_PRESENCE_TTL_MS - 1).toISOString(),
        }),
      ],
      nowMs: NOW,
    });
    expect(verdict.outcome).toBe("quiet");
  });
});

describe("decideFilePresenceAcross", () => {
  it("returns nothing when every file is quiet", () => {
    expect(decideFilePresenceAcross({ entries: [person()], nowMs: NOW })).toEqual([]);
  });

  it("puts the urgent file above the merely contested one", () => {
    const verdicts = decideFilePresenceAcross({
      entries: [
        person({ path: "b.ts", userId: "user:maya", sourceId: "page:1" }),
        person({ path: "b.ts", userId: "user:ada", sourceId: "page:2" }),
        person({ path: "a.ts", userId: "user:maya", sourceId: "page:3" }),
        agent({ path: "a.ts", userId: "user:sam", sourceId: "thread:1" }),
      ],
      nowMs: NOW,
    });
    expect(verdicts.map((verdict) => verdict.path)).toEqual(["a.ts", "b.ts"]);
    expect(verdicts[0]?.outcome).toBe("agent-over-person");
    expect(verdicts[1]?.outcome).toBe("people-collide");
  });

  it("orders files of equal severity by path, so two browsers agree", () => {
    const verdicts = decideFilePresenceAcross({
      entries: [
        person({ path: "z.ts", userId: "user:maya", sourceId: "page:1" }),
        person({ path: "z.ts", userId: "user:ada", sourceId: "page:2" }),
        person({ path: "a.ts", userId: "user:maya", sourceId: "page:3" }),
        person({ path: "a.ts", userId: "user:ada", sourceId: "page:4" }),
      ],
      nowMs: NOW,
    });
    expect(verdicts.map((verdict) => verdict.path)).toEqual(["a.ts", "z.ts"]);
  });

  it("carries the branch answer through to every people-collide row", () => {
    const verdicts = decideFilePresenceAcross({
      entries: [
        person({ path: "a.ts", userId: "user:maya", sourceId: "page:1" }),
        person({ path: "a.ts", userId: "user:ada", sourceId: "page:2" }),
      ],
      nowMs: NOW,
      viewerHasOwnBranch: true,
    });
    expect(verdicts[0]?.suggestion).toContain("You are on your own branch");
  });
});

describe("peopleHoldingFiles", () => {
  it("lists what each person has open, once per file", () => {
    const held = peopleHoldingFiles({
      entries: [
        person({ path: "a.ts", userId: "user:maya", sourceId: "page:1" }),
        person({ path: "a.ts", userId: "user:maya", sourceId: "page:2" }),
        person({ path: "b.ts", userId: "user:maya", sourceId: "page:1" }),
      ],
      nowMs: NOW,
    });
    expect(held.map((entryValue) => entryValue.path).toSorted()).toEqual(["a.ts", "b.ts"]);
  });

  it("does not report an agent as somebody holding a file", () => {
    expect(peopleHoldingFiles({ entries: [agent()], nowMs: NOW })).toEqual([]);
  });

  it("forgets a person whose browser stopped saying it was there", () => {
    const held = peopleHoldingFiles({
      entries: [person({ refreshedAt: new Date(NOW - PERSON_PRESENCE_TTL_MS - 1).toISOString() })],
      nowMs: NOW,
    });
    expect(held).toEqual([]);
  });
});
