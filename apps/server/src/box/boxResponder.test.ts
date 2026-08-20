import { describe, expect, it } from "vitest";

import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";

import {
  BOX_MAX_EXEC_TIMEOUT_MS,
  BOX_MIN_EXEC_TIMEOUT_MS,
  decodeBoxRequest,
  encodeBoxRequest,
} from "./boxProtocol.ts";
import { createBoxResponder, type BoxMachine } from "./boxResponder.ts";
import { BOX_JOURNAL_HEAD_BYTES, BOX_JOURNAL_TAIL_BYTES } from "./decideBoxCommand.ts";
import type { BoxExecOutcome, BoxInspection } from "./Services/BoxSession.ts";

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

interface Recorded {
  readonly signalled: Array<number>;
  readonly executed: Array<{ command: string; detach: boolean; timeoutMs: number; actor: string }>;
  readonly claimed: Array<{ port: number; actor: string }>;
}

const makeMachine = (
  overrides: {
    readonly services?: ReadonlyArray<EnvironmentService>;
    readonly exec?: BoxMachine["exec"];
    readonly readServiceLog?: BoxMachine["readServiceLog"];
  } = {},
): { readonly machine: BoxMachine; readonly recorded: Recorded } => {
  const recorded: Recorded = { signalled: [], executed: [], claimed: [] };
  const inspection: BoxInspection = {
    services: overrides.services ?? [service()],
    claims: [],
    probe: { tool: "lsof", processAttribution: true, limitation: "" },
  };

  const machine: BoxMachine = {
    inspect: () => Promise.resolve(inspection),
    exec:
      overrides.exec ??
      ((input) => {
        recorded.executed.push({
          command: input.command,
          detach: input.detach,
          timeoutMs: input.timeoutMs,
          actor: input.actorUserId,
        });
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: "done",
          stderr: "",
          pid: null,
          timedOut: false,
        } satisfies BoxExecOutcome);
      }),
    signal: (input) => {
      recorded.signalled.push(input.pid);
      return Promise.resolve(true);
    },
    readServiceLog: overrides.readServiceLog ?? (() => Promise.resolve("log line")),
    claimPort: (input) => {
      recorded.claimed.push({ port: input.port, actor: input.actorUserId });
      return Promise.resolve({
        port: input.port,
        claimedBy: input.actorUserId,
        purpose: input.purpose,
        claimedAt: "2026-08-21T00:00:00.000Z",
        expiresAt: "2026-08-21T00:10:00.000Z",
      } satisfies PortClaim);
    },
    releasePort: () => Promise.resolve(true),
  };

  return { machine, recorded };
};

const ask = async (
  machine: BoxMachine,
  method: Parameters<typeof encodeBoxRequest>[0]["method"],
  params: Record<string, unknown>,
  actorUserId = "user-1",
): Promise<Record<string, unknown>> => {
  const reply = await createBoxResponder(machine)(
    encodeBoxRequest({ method, actorUserId, params }),
  );
  expect(reply).not.toBeNull();
  return JSON.parse(reply ?? "{}") as Record<string, unknown>;
};

describe("decodeBoxRequest", () => {
  it("hands back anything that is not addressed to the box protocol", () => {
    // A relay channel carries browser RPC too, and answering somebody else's
    // frame with a box error would break that path by being helpful.
    expect(decodeBoxRequest(JSON.stringify({ id: 1, tag: "Request" })).outcome).toBe("not-box");
    expect(decodeBoxRequest("not json at all").outcome).toBe("not-box");
    expect(decodeBoxRequest("[1,2,3]").outcome).toBe("not-box");
  });

  it("refuses a version of its own protocol it does not speak", () => {
    const decoded = decodeBoxRequest(
      JSON.stringify({ protocol: "box/2", method: "inspect", params: {} }),
    );

    expect(decoded.outcome).toBe("malformed");
    if (decoded.outcome !== "malformed") return;
    expect(decoded.message).toContain("box/1");
  });

  it("clamps a timeout the far end asked for", () => {
    const tiny = decodeBoxRequest(
      encodeBoxRequest({
        method: "exec",
        actorUserId: "user-1",
        params: { command: "ls", detach: false, timeoutMs: 1 },
      }),
    );
    const huge = decodeBoxRequest(
      encodeBoxRequest({
        method: "exec",
        actorUserId: "user-1",
        params: { command: "ls", detach: false, timeoutMs: 365 * 24 * 3_600_000 },
      }),
    );

    expect(tiny.outcome === "request" && tiny.request.call).toMatchObject({
      timeoutMs: BOX_MIN_EXEC_TIMEOUT_MS,
    });
    expect(huge.outcome === "request" && huge.request.call).toMatchObject({
      timeoutMs: BOX_MAX_EXEC_TIMEOUT_MS,
    });
  });

  it("refuses a signal that is not one of the two a box sends", () => {
    const decoded = decodeBoxRequest(
      encodeBoxRequest({
        method: "signal",
        actorUserId: "user-1",
        params: { pid: 4821, signal: "SIGSTOP", acknowledgedTarget: null },
      }),
    );

    expect(decoded.outcome).toBe("malformed");
  });
});

describe("createBoxResponder", () => {
  it("answers null for a frame that is not its own", async () => {
    const { machine } = makeMachine();
    const reply = await createBoxResponder(machine)(JSON.stringify({ id: 1, tag: "Request" }));

    expect(reply).toBeNull();
  });

  it("reports what is running from the box's own inspection", async () => {
    const { machine } = makeMachine();
    const reply = await ask(machine, "inspect", {});

    expect(reply["result"]).toMatchObject({ probe: { tool: "lsof" } });
  });

  it("runs a command and reports its exit code", async () => {
    const { machine, recorded } = makeMachine();
    const reply = await ask(machine, "exec", {
      command: "ls -la",
      detach: false,
      timeoutMs: 5_000,
    });

    expect(reply["result"]).toMatchObject({ exitCode: 0, stdout: "done" });
    expect(recorded.executed).toEqual([
      { command: "ls -la", detach: false, timeoutMs: 5_000, actor: "user-1" },
    ]);
  });

  /**
   * The reply travels through a hub carrying it between two machines it does not
   * control, so an unbounded stream is an unbounded allocation anyone with a
   * session can trigger. The bound applied here is the journal's, not the tight
   * one — the caller cuts to a screenful *after* writing the generous copy down.
   */
  it("bounds a stream before it goes on the wire", async () => {
    const noise = "x".repeat(BOX_JOURNAL_HEAD_BYTES + BOX_JOURNAL_TAIL_BYTES + 10_000);
    const { machine } = makeMachine({
      exec: () =>
        Promise.resolve({
          exitCode: 0,
          signal: null,
          stdout: noise,
          stderr: "",
          pid: null,
          timedOut: false,
        }),
    });

    const reply = await ask(machine, "exec", { command: "noisy", detach: false, timeoutMs: 5_000 });
    const stdout = (reply["result"] as { readonly stdout: string }).stdout;

    expect(stdout.length).toBeLessThan(noise.length);
    expect(stdout).toContain("bytes omitted");
  });

  it("ends a process the box started", async () => {
    const { machine, recorded } = makeMachine();
    const reply = await ask(machine, "signal", {
      pid: 4821,
      signal: "SIGTERM",
      acknowledgedTarget: null,
    });

    expect(reply["result"]).toEqual({ signalled: true, unmanaged: false });
    expect(recorded.signalled).toEqual([4821]);
  });

  /**
   * The property the whole box side exists for. The caller has already decided
   * — this request is what a caller that decided "yes" sends — and the box
   * decides again from its own registry and signals nothing.
   */
  it("refuses to end a process the box did not start, and signals nothing", async () => {
    const { machine, recorded } = makeMachine({
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
    });

    const reply = await ask(machine, "signal", {
      pid: 991,
      signal: "SIGTERM",
      acknowledgedTarget: null,
    });

    expect(reply["error"]).toContain("not T3's to stop");
    expect(recorded.signalled).toEqual([]);
  });

  it("ends a stranger's process when the override names that exact pid", async () => {
    const { machine, recorded } = makeMachine({
      services: [
        service({ ownership: "not-ours", canManage: false, managedId: null, pid: 991, port: 5432 }),
      ],
    });

    const reply = await ask(machine, "signal", {
      pid: 991,
      signal: "SIGTERM",
      acknowledgedTarget: "pid:991",
    });

    expect(reply["result"]).toEqual({ signalled: true, unmanaged: true });
    expect(recorded.signalled).toEqual([991]);
  });

  it("carries the asking account into a reservation", async () => {
    const { machine, recorded } = makeMachine();
    const reply = await ask(machine, "claimPort", { port: 4001, purpose: "dev server" }, "user-7");

    expect(reply["result"]).toMatchObject({ claim: { claimedBy: "user-7", port: 4001 } });
    expect(recorded.claimed).toEqual([{ port: 4001, actor: "user-7" }]);
  });

  it("answers a failure instead of going quiet", async () => {
    // A channel that stops answering costs the caller a fifteen-minute timeout
    // for something that already failed, which is the least useful true sentence
    // available about a box that answered immediately and badly.
    const { machine } = makeMachine({
      readServiceLog: () => Promise.reject(new Error("no such service here")),
    });

    const reply = await ask(machine, "readServiceLog", { managedId: "service:nope" });

    expect(reply["error"]).toContain("no such service here");
  });

  it("refuses a request it cannot read, rather than acting on part of it", async () => {
    const { machine } = makeMachine();
    const reply = await createBoxResponder(machine)(
      JSON.stringify({ protocol: "box/1", method: "exec", params: { detach: true } }),
    );

    expect(JSON.parse(reply ?? "{}")["error"]).toContain("command");
  });
});
