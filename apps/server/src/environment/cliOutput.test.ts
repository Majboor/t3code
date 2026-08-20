import { describe, expect, it } from "vitest";

import type {
  EnvironmentService,
  PortCheckResult,
  ServiceRegistryListResult,
} from "@t3tools/contracts";

import {
  formatPortCheck,
  formatPortClaimed,
  formatPortRefused,
  formatServiceLine,
  formatServiceList,
  formatServiceRegistered,
  ownershipLabel,
  serviceJson,
} from "./cliOutput.ts";

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
    since: "2026-08-21T11:00:00.000Z",
    startedBy: "user-1",
    managedId: null,
    canManage: true,
    ...overrides,
  } as EnvironmentService;
}

function result(overrides: Partial<ServiceRegistryListResult> = {}): ServiceRegistryListResult {
  return {
    services: [],
    claims: [],
    probe: { tool: "lsof", processAttribution: true, limitation: "" },
    observedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  } as ServiceRegistryListResult;
}

describe("ownershipLabel", () => {
  it.each([
    ["ours" as const, "ours"],
    ["not-ours" as const, "not ours"],
    // Shouted, because it is the one an agent must not round down to "probably
    // mine" while scanning a column.
    ["unknown" as const, "UNKNOWN"],
  ])("%s -> %s", (ownership, expected) => {
    expect(ownershipLabel(service({ ownership }))).toBe(expected);
  });
});

describe("formatServiceLine", () => {
  it("puts the port, the ownership and the name where they can be scanned", () => {
    const line = formatServiceLine(service());
    expect(line).toContain("3000");
    expect(line).toContain("ours");
    expect(line).toContain("hello");
    expect(line).toContain("0.0.0.0:3000");
    expect(line).toContain("pid 4821");
  });

  it("says a process is nameless rather than leaving a blank", () => {
    expect(formatServiceLine(service({ name: null, ownership: "unknown", pid: null }))).toContain(
      "(unnamed)",
    );
  });

  it("omits a pid it does not have", () => {
    expect(formatServiceLine(service({ pid: null }))).not.toContain("pid");
  });

  it("names the displaced state rather than an address it does not have", () => {
    expect(formatServiceLine(service({ state: "displaced", address: null }))).toContain(
      "displaced",
    );
  });
});

describe("formatServiceList", () => {
  it("says how the machine was read", () => {
    expect(formatServiceList(result())).toContain("with lsof");
  });

  it("carries the probe's limitation so a wall of unknowns is legible", () => {
    const output = formatServiceList(
      result({
        probe: {
          tool: "netstat",
          processAttribution: false,
          limitation: "netstat cannot say which process holds a port.",
        },
      }),
    );
    expect(output).toContain("cannot say which process");
  });

  it("keeps what T3 started apart from what it did not", () => {
    const output = formatServiceList(
      result({
        services: [service(), service({ port: 5432, name: "postgres", ownership: "not-ours" })],
      }),
    );
    const ourHeading = output.indexOf("Started by T3");
    const theirHeading = output.indexOf("Already running here");
    expect(ourHeading).toBeGreaterThanOrEqual(0);
    expect(theirHeading).toBeGreaterThan(ourHeading);
    expect(output.indexOf("hello")).toBeGreaterThan(ourHeading);
    expect(output.indexOf("hello")).toBeLessThan(theirHeading);
    expect(output.indexOf("postgres")).toBeGreaterThan(theirHeading);
  });

  it("lists an unknown owner with the strangers and not with ours", () => {
    const output = formatServiceList(
      result({ services: [service({ ownership: "unknown", name: null, pid: null })] }),
    );
    expect(output).toContain("Started by T3 (0)");
    expect(output).toContain("Already running here (1)");
  });

  it("prints the evidence under every row it did not start", () => {
    const output = formatServiceList(
      result({
        services: [
          service({ port: 5432, ownership: "not-ours", ownershipReason: "pid 812 is not ours." }),
        ],
      }),
    );
    expect(output).toContain("pid 812 is not ours.");
  });

  it("warns once, at the end, when there is anything not to touch", () => {
    const output = formatServiceList(
      result({ services: [service({ port: 5432, ownership: "not-ours" })] }),
    );
    expect(output).toContain("has no record of and cannot bring back");
  });

  it("does not warn about strangers when there are none", () => {
    expect(formatServiceList(result({ services: [service()] }))).not.toContain("cannot bring back");
  });

  it("says nothing rather than nothing-is-running for an empty machine", () => {
    const output = formatServiceList(result());
    expect(output).toContain("nothing observed");
  });

  it("lists reservations separately from listeners", () => {
    const output = formatServiceList(
      result({
        claims: [
          {
            port: 4000,
            claimedBy: "user-1",
            purpose: "the admin server",
            claimedAt: "2026-08-21T11:59:00.000Z",
            expiresAt: "2026-08-21T12:09:00.000Z",
          },
        ] as never,
      }),
    );
    expect(output).toContain("Reserved, nothing listening yet (1)");
    expect(output).toContain("the admin server");
  });
});

describe("formatPortCheck", () => {
  const free: PortCheckResult = {
    verdict: {
      port: 4100,
      availability: "free",
      free: true,
      headline: "Nothing is listening on 4100 and nobody has reserved it.",
      suggestion: "Claim it before you start.",
      service: null,
      claim: null,
    },
    suggestion: null,
  } as PortCheckResult;

  it("tells the caller how to claim a free port", () => {
    expect(formatPortCheck(4100, free)).toContain("t3 env port claim 4100");
  });

  it("offers the alternative when the answer was no", () => {
    const taken = {
      verdict: {
        ...free.verdict,
        port: 5432,
        availability: "in-use",
        free: false,
        headline: "5432 is taken by something T3 did not start.",
        suggestion: "Pick another port. Do not stop it.",
      },
      suggestion: 4000,
    } as PortCheckResult;
    const output = formatPortCheck(5432, taken);
    expect(output).toContain("Do not stop it");
    expect(output).toContain("4000 is free");
    expect(output).not.toContain("t3 env port claim 5432");
  });
});

describe("formatPortClaimed", () => {
  it("says when it lapses, every time", () => {
    const output = formatPortClaimed({
      port: 4000,
      claimedBy: "user-1",
      purpose: "the admin server",
      claimedAt: "2026-08-21T11:59:00.000Z",
      expiresAt: "2026-08-21T12:09:00.000Z",
    } as never);
    expect(output).toContain("Reserved 4000");
    expect(output).toContain("2026-08-21T12:09:00.000Z");
    expect(output).toContain("lapses on its own");
  });
});

describe("formatPortRefused", () => {
  it("says why and where to go instead", () => {
    const output = formatPortRefused({
      verdict: {
        port: 4000,
        availability: "claimed",
        free: false,
        headline: "4000 is reserved by user-2.",
        suggestion: "Pick another port rather than racing for this one.",
        service: null,
        claim: null,
      },
      suggestion: 4001,
    } as PortCheckResult);
    expect(output).toContain("reserved by user-2");
    expect(output).toContain("4001 is free");
  });
});

describe("formatServiceRegistered", () => {
  it("warns that a restart needs re-registering", () => {
    const output = formatServiceRegistered({ name: "hello", port: 3000, pid: 4821 });
    expect(output).toContain("pid 4821");
    expect(output).toContain("register the new pid");
    expect(output).toContain("port match alone will not make the replacement ours");
  });
});

describe("serviceJson", () => {
  it("carries the ownership and its reason, so an agent need not parse prose", () => {
    const json = serviceJson(service({ ownership: "unknown", canManage: false }));
    expect(json.ownership).toBe("unknown");
    expect(json.canManage).toBe(false);
    expect(json.ownershipReason).not.toBe("");
  });
});
