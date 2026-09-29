import { beforeEach, describe, expect, it } from "vitest";

import { RELAY_HEARTBEAT_INTERVAL_MS, RELAY_MISSED_BEATS_ALLOWED } from "./decideRelayLink.ts";
import type { RelayFrame, RelayGoodbyeReason } from "./protocol.ts";
import {
  acceptRelayConnection,
  closeRelayChannelFromEnvironment,
  deliverRelayChannelFrame,
  dropRelayConnectionsForAuthSession,
  dropRelayConnectionsForMachine,
  listRelayLinksForUser,
  noteRelayPingSent,
  openRelayChannel,
  recordRelayPong,
  relayConnectionCount,
  relayLinkFor,
  registerRelayConnection,
  resetRelayRegistryForTests,
  unregisterRelayConnection,
  type RelayConnectionHandle,
} from "./registry.ts";

const NOW = 5_000_000;
const DEADLINE = RELAY_HEARTBEAT_INTERVAL_MS * RELAY_MISSED_BEATS_ALLOWED;

/** A stand-in socket that records instead of writing. */
function fakeSocket() {
  const sent: Array<RelayFrame> = [];
  const closed: Array<RelayGoodbyeReason> = [];
  return {
    sent,
    closed,
    send: (frame: RelayFrame) => {
      sent.push(frame);
    },
    close: (reason: RelayGoodbyeReason) => {
      closed.push(reason);
    },
    lastOf: <T extends RelayFrame["type"]>(type: T) =>
      sent.toReversed().find((frame) => frame.type === type) as
        | Extract<RelayFrame, { type: T }>
        | undefined,
  };
}

interface Dialled {
  readonly handle: RelayConnectionHandle;
  readonly socket: ReturnType<typeof fakeSocket>;
}

function dial(
  overrides: Partial<{
    environmentId: string;
    userId: string;
    machineId: string;
    authSessionId: string;
    label: string | null;
  }> = {},
): Dialled {
  const socket = fakeSocket();
  const handle = registerRelayConnection({
    environmentId: overrides.environmentId ?? "env-1",
    userId: overrides.userId ?? "auth:ada",
    machineId: overrides.machineId ?? "machine-a",
    authSessionId: overrides.authSessionId ?? "session-a",
    label: overrides.label ?? "Laptop",
    send: socket.send,
    close: socket.close,
  });
  return { handle, socket };
}

/** Dialled in, identity settled, one ping answered. The healthy baseline. */
function dialHealthy(overrides: Parameters<typeof dial>[0] = {}): Dialled {
  const dialled = dial(overrides);
  acceptRelayConnection(dialled.handle, NOW - 1_000);
  const nonce = noteRelayPingSent(dialled.handle);
  expect(nonce).not.toBeNull();
  recordRelayPong(dialled.handle, {
    nonce: nonce as string,
    state: "ready",
    detail: null,
    nowMs: NOW - 500,
  });
  return dialled;
}

beforeEach(() => {
  resetRelayRegistryForTests();
});

describe("what a link reports before it has proved anything", () => {
  it("is connecting on a fresh socket, however open it is", () => {
    const { handle } = dial();
    const link = relayLinkFor(handle.environmentId, NOW);
    expect(link?.verdict.state).toBe("connecting");
    expect(link?.verdict.reason).toBe("identity-pending");
  });

  it("is still connecting once the identity settles but nothing has answered", () => {
    const { handle } = dial();
    acceptRelayConnection(handle, NOW);
    expect(relayLinkFor(handle.environmentId, NOW)?.verdict.reason).toBe("awaiting-first-health");
  });

  it("becomes connected only after a ping comes back", () => {
    const { handle } = dialHealthy();
    const link = relayLinkFor(handle.environmentId, NOW);
    expect(link?.verdict.state).toBe("connected");
    expect(link?.verdict.acceptsTraffic).toBe(true);
  });

  it("goes unhealthy on its own once the answers stop", () => {
    // Nothing calls anything here. Time passing is the whole event, which is
    // what makes this different from a socket-liveness check.
    const { handle } = dialHealthy();
    expect(relayLinkFor(handle.environmentId, NOW + DEADLINE + 1)?.verdict.state).toBe("unhealthy");
  });

  it("has nothing at all to say about a name that never dialled in", () => {
    // Distinct from "offline" on purpose: a saved environment whose laptop is
    // shut is not a connection this process has ever seen.
    expect(relayLinkFor("env-never", NOW)).toBeNull();
  });
});

describe("the health question and its answer", () => {
  it("puts a ping on the wire and believes the answer that names it", () => {
    const { handle, socket } = dial();
    acceptRelayConnection(handle, NOW);
    const nonce = noteRelayPingSent(handle);
    expect(socket.lastOf("ping")?.nonce).toBe(nonce);
    expect(
      recordRelayPong(handle, { nonce: nonce as string, state: "ready", detail: null, nowMs: NOW }),
    ).toBe(true);
  });

  it("refuses a pong that answers a question nobody asked", () => {
    // Otherwise an environment could keep itself green by emitting pongs on a
    // timer — the socket-liveness lie, told one layer up.
    const { handle } = dial();
    acceptRelayConnection(handle, NOW);
    noteRelayPingSent(handle);
    expect(
      recordRelayPong(handle, { nonce: "made-up", state: "ready", detail: null, nowMs: NOW }),
    ).toBe(false);
    expect(relayLinkFor(handle.environmentId, NOW)?.verdict.reason).toBe("awaiting-first-health");
  });

  it("refuses the same pong twice, so one answer cannot cover two silences", () => {
    const { handle } = dial();
    acceptRelayConnection(handle, NOW);
    const nonce = noteRelayPingSent(handle) as string;
    expect(recordRelayPong(handle, { nonce, state: "ready", detail: null, nowMs: NOW })).toBe(true);
    expect(
      recordRelayPong(handle, { nonce, state: "ready", detail: null, nowMs: NOW + 60_000 }),
    ).toBe(false);
  });

  it("carries the environment's own words through to the verdict", () => {
    const { handle } = dial();
    acceptRelayConnection(handle, NOW);
    const nonce = noteRelayPingSent(handle) as string;
    recordRelayPong(handle, {
      nonce,
      state: "degraded",
      detail: "workspace root is missing",
      nowMs: NOW,
    });
    const link = relayLinkFor(handle.environmentId, NOW);
    expect(link?.verdict.state).toBe("unhealthy");
    expect(link?.verdict.detail).toBe("workspace root is missing");
  });
});

describe("one name, one connection", () => {
  it("replaces an earlier connection and tells it why", () => {
    const first = dialHealthy();
    const second = dial();
    expect(first.socket.lastOf("bye")?.reason).toBe("superseded");
    expect(first.socket.closed).toEqual(["superseded"]);
    expect(relayConnectionCount()).toBe(1);
    expect(relayLinkFor("env-1", NOW)?.verdict.reason).toBe("identity-pending");
    void second;
  });

  it("ignores anything the displaced connection says afterwards", () => {
    // Its loop keeps running until it notices. Without the identity check, its
    // last frames would land on its replacement.
    const first = dial();
    acceptRelayConnection(first.handle, NOW);
    const stale = noteRelayPingSent(first.handle) as string;
    const second = dial();
    expect(
      recordRelayPong(first.handle, { nonce: stale, state: "ready", detail: null, nowMs: NOW }),
    ).toBe(false);
    acceptRelayConnection(first.handle, NOW);
    expect(relayLinkFor("env-1", NOW)?.verdict.reason).toBe("identity-pending");
    void second;
  });

  it("lets a displaced connection unregister without taking its replacement with it", () => {
    const first = dial();
    const second = dialHealthy();
    unregisterRelayConnection(first.handle);
    expect(relayLinkFor("env-1", NOW)?.verdict.state).toBe("connected");
    void second;
  });

  it("keeps two different environments apart", () => {
    dialHealthy({ environmentId: "env-1" });
    dialHealthy({ environmentId: "env-2" });
    expect(relayConnectionCount()).toBe(2);
    expect(listRelayLinksForUser("auth:ada", NOW).map((link) => link.environmentId)).toEqual([
      "env-1",
      "env-2",
    ]);
  });
});

describe("who can see which links", () => {
  it("lists only this person's", () => {
    dialHealthy({ environmentId: "env-mine", userId: "auth:ada" });
    dialHealthy({ environmentId: "env-theirs", userId: "auth:grace" });
    expect(listRelayLinksForUser("auth:ada", NOW).map((link) => link.environmentId)).toEqual([
      "env-mine",
    ]);
  });
});

describe("carrying a browser's traffic", () => {
  it("opens a channel on a healthy link and moves frames both ways", () => {
    const { handle, socket } = dialHealthy();
    const received: Array<string> = [];
    const closes: Array<string | null> = [];
    const result = openRelayChannel({
      environmentId: "env-1",
      userId: "auth:ada",
      nowMs: NOW,
      sink: {
        onData: (payload) => received.push(payload),
        onClose: (reason) => closes.push(reason),
      },
    });
    expect(result.outcome).toBe("opened");
    if (result.outcome !== "opened") {
      return;
    }

    expect(socket.lastOf("open")?.channelId).toBe(result.channel.channelId);

    result.channel.send('{"_tag":"Request"}');
    expect(socket.lastOf("data")).toEqual({
      type: "data",
      channelId: result.channel.channelId,
      payload: '{"_tag":"Request"}',
    });

    expect(
      deliverRelayChannelFrame(handle, {
        type: "data",
        channelId: result.channel.channelId,
        payload: '{"_tag":"Exit"}',
      }),
    ).toBe(true);
    expect(received).toEqual(['{"_tag":"Exit"}']);

    expect(
      closeRelayChannelFromEnvironment(handle, {
        channelId: result.channel.channelId,
        reason: "done",
      }),
    ).toBe(true);
    expect(closes).toEqual(["done"]);
  });

  it("refuses a link this process has never heard of", () => {
    expect(
      openRelayChannel({
        environmentId: "env-never",
        userId: "auth:ada",
        nowMs: NOW,
        sink: { onData: () => {}, onClose: () => {} },
      }),
    ).toEqual({ outcome: "refused", reason: "not-connected" });
  });

  it("refuses somebody else's environment", () => {
    dialHealthy({ environmentId: "env-1", userId: "auth:ada" });
    expect(
      openRelayChannel({
        environmentId: "env-1",
        userId: "auth:grace",
        nowMs: NOW,
        sink: { onData: () => {}, onClose: () => {} },
      }),
    ).toEqual({ outcome: "refused", reason: "not-yours" });
  });

  it("refuses a link whose health has gone stale, rather than hanging the browser", () => {
    dialHealthy();
    expect(
      openRelayChannel({
        environmentId: "env-1",
        userId: "auth:ada",
        nowMs: NOW + DEADLINE + 1,
        sink: { onData: () => {}, onClose: () => {} },
      }),
    ).toEqual({ outcome: "refused", reason: "not-healthy" });
  });

  it("refuses a link that has not answered a ping yet", () => {
    const { handle } = dial();
    acceptRelayConnection(handle, NOW);
    expect(
      openRelayChannel({
        environmentId: "env-1",
        userId: "auth:ada",
        nowMs: NOW,
        sink: { onData: () => {}, onClose: () => {} },
      }),
    ).toEqual({ outcome: "refused", reason: "not-healthy" });
  });

  it("drops a frame for a channel that has gone, without failing", () => {
    const { handle } = dialHealthy();
    expect(
      deliverRelayChannelFrame(handle, {
        type: "data",
        channelId: "no-such-channel",
        payload: "x",
      }),
    ).toBe(false);
  });

  it("stops writing into a socket that is no longer this environment", () => {
    const first = dialHealthy();
    const opened = openRelayChannel({
      environmentId: "env-1",
      userId: "auth:ada",
      nowMs: NOW,
      sink: { onData: () => {}, onClose: () => {} },
    });
    if (opened.outcome !== "opened") {
      throw new Error("expected a channel");
    }
    const second = dial();
    opened.channel.send("late frame");
    expect(second.socket.sent.some((frame) => frame.type === "data")).toBe(false);
    void first;
  });

  it("counts what a link is carrying", () => {
    dialHealthy();
    openRelayChannel({
      environmentId: "env-1",
      userId: "auth:ada",
      nowMs: NOW,
      sink: { onData: () => {}, onClose: () => {} },
    });
    expect(relayLinkFor("env-1", NOW)?.openChannels).toBe(1);
  });
});

describe("what happens to browsers when the environment goes", () => {
  it("closes every channel when the connection unregisters", () => {
    const { handle } = dialHealthy();
    const closes: Array<string | null> = [];
    openRelayChannel({
      environmentId: "env-1",
      userId: "auth:ada",
      nowMs: NOW,
      sink: { onData: () => {}, onClose: (reason) => closes.push(reason) },
    });
    unregisterRelayConnection(handle);
    // Told, rather than left waiting on a reply that is never coming.
    expect(closes).toHaveLength(1);
    expect(relayLinkFor("env-1", NOW)).toBeNull();
  });
});

describe("revoking a machine", () => {
  it("cuts the outbound connection it holds", () => {
    // The point of the whole hook: authentication happens once, at dial time,
    // so without this a revoked machine keeps its traffic for months.
    const { socket } = dialHealthy({ machineId: "machine-a" });
    const dropped = dropRelayConnectionsForMachine("machine-a", "Disconnected.");
    expect(dropped).toEqual(["env-1"]);
    expect(socket.lastOf("bye")?.reason).toBe("revoked");
    expect(socket.closed).toEqual(["revoked"]);
    // Kept, and readable as revoked. Forgetting it made this verdict
    // unreachable: the caller could not tell a revoked machine from one that
    // had never dialled in, so the UI settled on "Offline — open the app on
    // that machine", which is the one thing that will not help.
    expect(relayLinkFor("env-1", NOW)?.verdict.state).toBe("revoked");
  });

  it("closes the browsers riding on it", () => {
    dialHealthy({ machineId: "machine-a" });
    const closes: Array<string | null> = [];
    openRelayChannel({
      environmentId: "env-1",
      userId: "auth:ada",
      nowMs: NOW,
      sink: { onData: () => {}, onClose: (reason) => closes.push(reason) },
    });
    dropRelayConnectionsForMachine("machine-a", "Disconnected.");
    expect(closes).toEqual(["Disconnected."]);
  });

  it("leaves every other machine alone", () => {
    dialHealthy({ environmentId: "env-1", machineId: "machine-a" });
    dialHealthy({ environmentId: "env-2", machineId: "machine-b" });
    expect(dropRelayConnectionsForMachine("machine-a", "Disconnected.")).toEqual(["env-1"]);
    expect(relayLinkFor("env-2", NOW)?.verdict.state).toBe("connected");
  });

  it("reaches a connection by the session it authenticated with", () => {
    const { socket } = dialHealthy({ authSessionId: "session-a" });
    expect(dropRelayConnectionsForAuthSession("session-a", "Disconnected.")).toEqual(["env-1"]);
    expect(socket.lastOf("bye")?.reason).toBe("revoked");
  });

  it("says nothing happened when the machine held nothing", () => {
    dialHealthy({ machineId: "machine-a" });
    expect(dropRelayConnectionsForMachine("machine-z", "Disconnected.")).toEqual([]);
    expect(relayConnectionCount()).toBe(1);
  });

  it("refuses to open a channel on a revoked name afterwards", () => {
    dialHealthy({ machineId: "machine-a" });
    dropRelayConnectionsForMachine("machine-a", "Disconnected.");
    expect(
      openRelayChannel({
        environmentId: "env-1",
        userId: "auth:ada",
        nowMs: NOW,
        sink: { onData: () => {}, onClose: () => {} },
      }),
    ).toEqual({ outcome: "refused", reason: "revoked" });
  });
});
