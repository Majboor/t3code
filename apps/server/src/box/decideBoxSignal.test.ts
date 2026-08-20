import { describe, expect, it } from "vitest";

import type { EnvironmentService } from "@t3tools/shared/serviceRegistry";

import { decideBoxSignal } from "./decideBoxSignal.ts";

const service = (overrides: Partial<EnvironmentService> = {}): EnvironmentService => ({
  port: 3000,
  name: "web",
  state: "listening",
  ownership: "ours",
  ownershipReason: "pid 4821 is the process T3 started for this port.",
  pid: 4821,
  command: "npm run dev",
  address: "127.0.0.1",
  since: "2026-08-21T00:00:00.000Z",
  startedBy: "user-1",
  managedId: "service:1",
  canManage: true,
  ...overrides,
});

describe("decideBoxSignal", () => {
  it("ends a process this box started", () => {
    const decision = decideBoxSignal({
      services: [service()],
      pid: 4821,
      acknowledgedTarget: null,
    });

    expect(decision).toEqual({ outcome: "allow", unmanaged: false });
  });

  it("refuses a process this box did not start, whatever the caller decided", () => {
    const decision = decideBoxSignal({
      services: [
        service({
          ownership: "not-ours",
          canManage: false,
          managedId: null,
          name: "postgres",
          port: 5432,
          pid: 991,
          ownershipReason: "pid 991 (postgres) holds this port and is not a process T3 started.",
        }),
      ],
      pid: 991,
      acknowledgedTarget: null,
    });

    expect(decision.outcome).toBe("refuse");
    if (decision.outcome !== "refuse") return;
    expect(decision.refusal.reason).toBe("process-not-ours");
    // The evidence travels with the refusal: a reader deciding whether to
    // override needs to see why the box said no, not just that it did.
    expect(decision.refusal.message).toContain("postgres");
  });

  /**
   * The case the whole file exists for. A caller that skipped `decideBoxCommand`
   * — a different build, a compromised hub, something written by somebody who
   * did not read it — arrives here as an ordinary request, and the box is the
   * only thing left between it and somebody's production database.
   */
  it("refuses a pid it can see nothing about, rather than treating silence as permission", () => {
    const decision = decideBoxSignal({ services: [], pid: 991, acknowledgedTarget: null });

    expect(decision.outcome).toBe("refuse");
    if (decision.outcome !== "refuse") return;
    expect(decision.refusal.reason).toBe("process-not-ours");
    expect(decision.refusal.message).toContain("991");
  });

  it("refuses when the machine will not name the process holding the port", () => {
    // An `unknown` row carries no pid at all, so it can never be matched by one.
    // That is the safe direction and it must stay that way: a probe that cannot
    // attribute a socket has produced no evidence of ownership either way.
    const decision = decideBoxSignal({
      services: [service({ ownership: "unknown", canManage: false, pid: null })],
      pid: 4821,
      acknowledgedTarget: null,
    });

    expect(decision.outcome).toBe("refuse");
  });

  it("allows a stranger's process only when the override names that exact pid", () => {
    const stranger = service({
      ownership: "not-ours",
      canManage: false,
      managedId: null,
      pid: 991,
    });

    expect(
      decideBoxSignal({ services: [stranger], pid: 991, acknowledgedTarget: "pid:991" }),
    ).toEqual({ outcome: "allow", unmanaged: true });
  });

  it("refuses an override written against a process that has since restarted", () => {
    const decision = decideBoxSignal({
      services: [service({ ownership: "not-ours", canManage: false, managedId: null, pid: 991 })],
      pid: 991,
      acknowledgedTarget: "pid:4821",
    });

    expect(decision.outcome).toBe("refuse");
    if (decision.outcome !== "refuse") return;
    expect(decision.refusal.reason).toBe("override-mismatch");
  });

  /**
   * Ownership and `canManage` are the registry's own derivation of one another.
   * They can only disagree if the reconciliation changed under us, and the safe
   * reading of a disagreement is not to kill anything.
   */
  it("refuses when ownership and canManage disagree", () => {
    const decision = decideBoxSignal({
      services: [service({ ownership: "ours", canManage: false })],
      pid: 4821,
      acknowledgedTarget: null,
    });

    expect(decision.outcome).toBe("refuse");
  });

  it("allows when one of several rows on the pid is ours", () => {
    // One process can hold several ports — a dev server and its HMR socket —
    // and every row carrying that pid is as much ours as the recorded one.
    const decision = decideBoxSignal({
      services: [
        service({ port: 3000 }),
        service({ port: 24678, managedId: null, ownership: "ours", canManage: true }),
      ],
      pid: 4821,
      acknowledgedTarget: null,
    });

    expect(decision).toEqual({ outcome: "allow", unmanaged: false });
  });
});
