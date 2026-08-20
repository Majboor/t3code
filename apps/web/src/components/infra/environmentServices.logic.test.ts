import { describe, expect, it } from "vitest";

import type { EnvironmentService, PortClaim } from "@t3tools/contracts";

import {
  describeExposure,
  describeOwnership,
  describeProbe,
  describeSince,
  describeState,
  groupServices,
  liveClaims,
} from "./environmentServices.logic";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function service(overrides: Partial<EnvironmentService> = {}): EnvironmentService {
  return {
    port: 3000,
    name: "hello",
    state: "listening",
    ownership: "ours",
    ownershipReason: "pid 4821 is the process T3 started for this port.",
    pid: 4821,
    command: "bun run dev",
    address: "0.0.0.0",
    since: iso(-60_000),
    startedBy: "user-1",
    managedId: null,
    canManage: true,
    ...overrides,
  } as EnvironmentService;
}

describe("groupServices", () => {
  it("keeps what T3 started apart from what it did not", () => {
    const groups = groupServices([
      service(),
      service({ port: 5432, ownership: "not-ours", canManage: false }),
    ]);
    expect(groups.ours.map((entry) => entry.port)).toEqual([3000]);
    expect(groups.others.map((entry) => entry.port)).toEqual([5432]);
  });

  it("files an unknown owner with the strangers rather than with ours", () => {
    const groups = groupServices([service({ ownership: "unknown", canManage: false })]);
    expect(groups.ours).toEqual([]);
    expect(groups.others).toHaveLength(1);
  });

  it("shows both halves of a displaced port", () => {
    const groups = groupServices([
      service({ state: "displaced" }),
      service({ ownership: "not-ours", canManage: false, pid: 9102 }),
    ]);
    expect(groups.ours).toHaveLength(1);
    expect(groups.others).toHaveLength(1);
  });
});

describe("liveClaims", () => {
  const claim = (expiresAt: string): PortClaim =>
    ({
      port: 4000,
      claimedBy: "user-1",
      purpose: "the admin server",
      claimedAt: iso(-1_000),
      expiresAt,
    }) as PortClaim;

  it("drops a reservation that lapsed while the page was open", () => {
    expect(liveClaims([claim(iso(-1))], NOW)).toEqual([]);
  });

  it("keeps one that has not", () => {
    expect(liveClaims([claim(iso(60_000))], NOW)).toHaveLength(1);
  });
});

describe("describeSince", () => {
  it.each([
    [-30_000, "just now"],
    [-5 * 60_000, "5m"],
    [-90 * 60_000, "1h"],
    [-3 * 24 * 60 * 60_000, "3d"],
  ])("%s ms ago -> %s", (offset, expected) => {
    expect(describeSince(iso(offset), NOW)).toBe(expected);
  });

  it("says nothing for a process it did not watch start", () => {
    expect(describeSince(null, NOW)).toBeNull();
  });

  it("says nothing rather than NaN for an undateable start", () => {
    expect(describeSince("whenever", NOW)).toBeNull();
  });

  it("does not report a negative age from clock skew", () => {
    expect(describeSince(iso(5_000), NOW)).toBe("just now");
  });
});

describe("describeExposure", () => {
  it.each([
    ["0.0.0.0", "reachable from the network"],
    ["::", "reachable from the network"],
    ["127.0.0.1", "this machine only"],
    ["::1", "this machine only"],
    ["10.0.0.4", "10.0.0.4"],
  ])("%s -> %s", (address, expected) => {
    expect(describeExposure(address)).toBe(expected);
  });

  it("says nothing when there is no address", () => {
    expect(describeExposure(null)).toBeNull();
  });
});

describe("describeState", () => {
  it.each([
    ["listening" as const, "listening on 3000"],
    ["not-listening" as const, "nothing listening on 3000 yet"],
    ["displaced" as const, "started for 3000, but another process holds it"],
  ])("%s", (state, expected) => {
    expect(describeState(service({ state }))).toBe(expected);
  });
});

describe("describeOwnership", () => {
  it.each([
    ["ours" as const, "started by T3"],
    ["not-ours" as const, "not started by T3"],
    ["unknown" as const, "owner unknown"],
  ])("%s", (ownership, expected) => {
    expect(describeOwnership(service({ ownership }))).toBe(expected);
  });
});

describe("describeProbe", () => {
  it("names the tool when there was nothing to qualify", () => {
    expect(describeProbe({ tool: "lsof", processAttribution: true, limitation: "" })).toBe(
      "Read with lsof.",
    );
  });

  it("carries the limitation so a page of unknowns is legible", () => {
    const described = describeProbe({
      tool: "netstat",
      processAttribution: false,
      limitation: "netstat cannot say which process holds a port.",
    });
    expect(described).toContain("netstat");
    expect(described).toContain("cannot say which process");
  });

  it("says nothing was seen rather than that nothing is running", () => {
    expect(describeProbe({ tool: "none", processAttribution: false, limitation: "" })).toContain(
      "not a claim that it is idle",
    );
  });
});
