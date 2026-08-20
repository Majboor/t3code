import { describe, expect, it } from "vitest";

import { RELAY_DIAL_BASE_DELAY_MS, RELAY_DIAL_MAX_DELAY_MS } from "./decideRelayLink.ts";
import {
  createEnvironmentDialer,
  createLoopbackRelaySessionFactory,
  relayDialUrl,
  type RelaySocketLike,
} from "./dialer.ts";
import { decodeFrame, encodeFrame, RELAY_PROTOCOL_VERSION, type RelayFrame } from "./protocol.ts";

/**
 * A socket the test plays the hub's part on.
 *
 * Everything about time in this file is an argument — the sleep, the
 * randomness, the socket itself — so the reconnection behaviour can be asserted
 * exactly instead of waited for.
 */
class FakeHubSocket implements RelaySocketLike {
  readonly sent: Array<RelayFrame> = [];
  /** Everything written, decodable or not — a bridged RPC frame is not one. */
  readonly sentRaw: Array<string> = [];
  private readonly handlers = new Map<string, Array<(event: never) => void>>();
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sentRaw.push(data);
    const frame = decodeFrame(data);
    if (frame !== null) {
      this.sent.push(frame);
    }
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.emit("close", undefined);
  }

  addEventListener(type: string, handler: (event: never) => void): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) {
      (handler as (event: unknown) => void)(event);
    }
  }

  /** The hub accepting the connection. */
  open(): void {
    this.emit("open", undefined);
  }

  /** The hub saying something. */
  deliver(frame: RelayFrame): void {
    this.emit("message", { data: encodeFrame(frame) });
  }

  /** The network going away, as opposed to the hub refusing. */
  drop(): void {
    this.emit("close", undefined);
  }

  lastOf<T extends RelayFrame["type"]>(type: T): Extract<RelayFrame, { type: T }> | undefined {
    return this.sent.toReversed().find((frame) => frame.type === type) as
      | Extract<RelayFrame, { type: T }>
      | undefined;
  }
}

interface Harness {
  readonly sockets: Array<FakeHubSocket>;
  readonly delays: Array<number>;
  readonly dialer: ReturnType<typeof createEnvironmentDialer>;
  readonly states: Array<string>;
  readonly nextSocket: () => Promise<FakeHubSocket>;
}

function makeHarness(
  overrides: Partial<Parameters<typeof createEnvironmentDialer>[0]> = {},
): Harness {
  const sockets: Array<FakeHubSocket> = [];
  const delays: Array<number> = [];
  const states: Array<string> = [];

  const dialer = createEnvironmentDialer({
    hubBaseUrl: "https://hub.example",
    environmentId: "env-1",
    label: "Test laptop",
    issueWebSocketToken: () => Promise.resolve("ws-token"),
    reportHealth: () => ({ state: "ready", detail: null }),
    openLocalSession: async (handlers) => ({
      send: (payload) => handlers.onData(payload.toUpperCase()),
      close: () => handlers.onClose(),
    }),
    connect: () => {
      const socket = new FakeHubSocket();
      sockets.push(socket);
      return socket;
    },
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    // Fixed, so the spread is exact rather than approximate.
    random: () => 1,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });

  // A cursor, not a length comparison: each call hands back the next socket the
  // dialer opened, so a reconnect that happened while the test was elsewhere is
  // still returned rather than waited for a second time.
  let cursor = 0;
  const nextSocket = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (cursor < sockets.length) {
        return sockets[cursor++]!;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("no socket was opened");
  };

  return { sockets, delays, dialer, states, nextSocket };
}

/** Lets queued microtasks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("dialling out", () => {
  it("names itself the moment the socket opens", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    await settle();

    expect(socket.lastOf("hello")).toEqual({
      type: "hello",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      environmentId: "env-1",
      label: "Test laptop",
    });
    await harness.dialer.stop();
  });

  it("counts itself connected only once the hub says welcome", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    await settle();
    expect(harness.dialer.state()).toBe("connecting");

    socket.deliver({ type: "welcome", environmentId: "env-1", heartbeatIntervalMs: 15_000 });
    await settle();
    expect(harness.dialer.state()).toBe("connected");
    await harness.dialer.stop();
  });

  it("builds a websocket URL from an https hub", () => {
    expect(relayDialUrl("https://hub.example", "abc")).toBe(
      "wss://hub.example/api/environments/relay?wsToken=abc",
    );
    expect(relayDialUrl("http://127.0.0.1:3000", "a b")).toBe(
      "ws://127.0.0.1:3000/api/environments/relay?wsToken=a+b",
    );
  });

  it("re-mints its token on every dial rather than reusing one", async () => {
    // A laptop that reconnects after a week of sleep would otherwise present a
    // token that expired six days ago.
    let minted = 0;
    const harness = makeHarness({
      issueWebSocketToken: () => Promise.resolve(`token-${++minted}`),
    });
    harness.dialer.start();
    const first = await harness.nextSocket();
    first.open();
    first.drop();
    await harness.nextSocket();
    await settle();
    expect(minted).toBeGreaterThanOrEqual(2);
    await harness.dialer.stop();
  });

  it("treats a token it could not mint as something to retry", async () => {
    // Almost always the hub being unreachable, which is exactly the case that
    // must be retried rather than read as a rejection.
    let attempts = 0;
    const harness = makeHarness({
      issueWebSocketToken: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("hub unreachable"))
          : Promise.resolve("ws-token");
      },
    });
    harness.dialer.start();
    await harness.nextSocket();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(harness.dialer.state()).not.toBe("refused");
    await harness.dialer.stop();
  });
});

describe("answering the health question", () => {
  it("answers each ping from a fresh reading, never a remembered one", async () => {
    // A cached "ready" from startup is the same stale reassurance the hub's
    // health rule exists to reject, told from the side the hub cannot see.
    const readings: Array<{ state: "ready" | "degraded"; detail: string | null }> = [
      { state: "ready", detail: null },
      { state: "degraded", detail: "workspace unmounted" },
    ];
    let index = 0;
    const harness = makeHarness({
      reportHealth: () => readings[Math.min(index++, readings.length - 1)]!,
    });
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "welcome", environmentId: "env-1", heartbeatIntervalMs: 15_000 });

    socket.deliver({ type: "ping", nonce: "n-1" });
    await settle();
    expect(socket.lastOf("pong")).toMatchObject({ nonce: "n-1", state: "ready" });

    socket.deliver({ type: "ping", nonce: "n-2" });
    await settle();
    expect(socket.lastOf("pong")).toMatchObject({
      nonce: "n-2",
      state: "degraded",
      detail: "workspace unmounted",
    });

    await harness.dialer.stop();
  });

  it("echoes the nonce it was asked with, so one answer covers one question", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "ping", nonce: "unique-nonce" });
    await settle();
    expect(socket.lastOf("pong")?.nonce).toBe("unique-nonce");
    await harness.dialer.stop();
  });
});

describe("serving a relayed browser", () => {
  it("opens a local session and moves frames both ways", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "welcome", environmentId: "env-1", heartbeatIntervalMs: 15_000 });

    socket.deliver({ type: "open", channelId: "c-1" });
    await settle();
    socket.deliver({ type: "data", channelId: "c-1", payload: "hello" });
    await settle();

    expect(socket.lastOf("data")).toEqual({
      type: "data",
      channelId: "c-1",
      payload: "HELLO",
    });
    await harness.dialer.stop();
  });

  it("holds frames that arrive before the local session is ready", async () => {
    // The browser's first frame is its RPC handshake. Dropping it leaves a
    // socket that is open and mute, which reads as the app being broken.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness({
      openLocalSession: async (handlers) => {
        await gate;
        return {
          send: (payload) => handlers.onData(payload.toUpperCase()),
          close: () => handlers.onClose(),
        };
      },
    });
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "open", channelId: "c-1" });
    socket.deliver({ type: "data", channelId: "c-1", payload: "early" });
    await settle();
    expect(socket.lastOf("data")).toBeUndefined();

    release!();
    await settle();
    expect(socket.lastOf("data")).toEqual({
      type: "data",
      channelId: "c-1",
      payload: "EARLY",
    });
    await harness.dialer.stop();
  });

  it("tells the hub when it cannot serve a channel at all", async () => {
    const harness = makeHarness({
      openLocalSession: () => Promise.reject(new Error("local server is down")),
    });
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "open", channelId: "c-1" });
    await settle();
    // Refused out loud: a channel the hub thinks is open and nothing is reading
    // is a browser waiting forever on its first reply.
    expect(socket.lastOf("close")?.channelId).toBe("c-1");
    await harness.dialer.stop();
  });

  it("closes every local session when the connection ends", async () => {
    let closed = 0;
    const harness = makeHarness({
      openLocalSession: async () => ({ send: () => {}, close: () => (closed += 1) }),
    });
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "open", channelId: "c-1" });
    socket.deliver({ type: "open", channelId: "c-2" });
    await settle();
    socket.drop();
    await settle();
    expect(closed).toBe(2);
    await harness.dialer.stop();
  });

  it("closes one session when the hub closes one channel", async () => {
    let closed = 0;
    const harness = makeHarness({
      openLocalSession: async () => ({ send: () => {}, close: () => (closed += 1) }),
    });
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "open", channelId: "c-1" });
    await settle();
    socket.deliver({ type: "close", channelId: "c-1", reason: null });
    await settle();
    expect(closed).toBe(1);
    await harness.dialer.stop();
  });
});

describe("coming back", () => {
  it("reconnects after the network goes away", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const first = await harness.nextSocket();
    first.open();
    first.drop();
    const second = await harness.nextSocket();
    expect(second).not.toBe(first);
    await harness.dialer.stop();
  });

  it("keeps the same environment name across a reconnect", async () => {
    // A reconnecting environment that renamed itself would appear as a stranger
    // and leave every saved thread pointing at nothing.
    const harness = makeHarness();
    harness.dialer.start();
    const first = await harness.nextSocket();
    first.open();
    await settle();
    first.drop();
    const second = await harness.nextSocket();
    second.open();
    await settle();
    expect(second.lastOf("hello")?.environmentId).toBe(first.lastOf("hello")?.environmentId);
    await harness.dialer.stop();
  });

  it("backs off further on each failure and stops at the ceiling", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const socket = await harness.nextSocket();
      socket.drop();
      await settle();
    }
    await harness.dialer.stop();

    expect(harness.delays.length).toBeGreaterThanOrEqual(6);
    // Non-decreasing, and never past the ceiling: an outage that takes out a
    // whole office must not have every laptop dialling in lockstep forever.
    for (let index = 1; index < harness.delays.length; index += 1) {
      expect(harness.delays[index]!).toBeGreaterThanOrEqual(harness.delays[index - 1]!);
    }
    for (const delay of harness.delays) {
      expect(delay).toBeGreaterThanOrEqual(RELAY_DIAL_BASE_DELAY_MS / 2);
      expect(delay).toBeLessThanOrEqual(RELAY_DIAL_MAX_DELAY_MS);
    }
  });

  it("starts the backoff over after a connection that actually worked", async () => {
    // A laptop that lost wifi for a moment should not be punished for the last
    // outage, only for this one.
    const harness = makeHarness();
    harness.dialer.start();

    const first = await harness.nextSocket();
    first.drop();
    await settle();
    const second = await harness.nextSocket();
    second.drop();
    await settle();
    const escalated = harness.delays[harness.delays.length - 1]!;

    const third = await harness.nextSocket();
    third.open();
    third.deliver({ type: "welcome", environmentId: "env-1", heartbeatIntervalMs: 15_000 });
    await settle();
    third.drop();
    await settle();

    expect(harness.dialer.failedAttempts()).toBe(0);
    expect(harness.delays[harness.delays.length - 1]!).toBeLessThan(escalated);
    await harness.dialer.stop();
  });
});

describe("giving up", () => {
  it("stops for good when the hub says the name is not theirs", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({
      type: "bye",
      reason: "rejected",
      message: "This environment name belongs to another account.",
    });
    await settle();
    expect(harness.dialer.state()).toBe("refused");
    expect(harness.sockets).toHaveLength(1);
    await harness.dialer.stop();
  });

  it("stops for good when the machine has been revoked", async () => {
    // Retrying a revocation forever would hammer the hub with a credential that
    // is never coming back.
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({ type: "bye", reason: "revoked", message: "This machine was disconnected." });
    await settle();
    expect(harness.dialer.state()).toBe("refused");
    await harness.dialer.stop();
    expect(harness.sockets).toHaveLength(1);
  });

  it("comes back when the hub is only reshuffling", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    socket.deliver({
      type: "bye",
      reason: "superseded",
      message: "Another connection claimed it.",
    });
    await harness.nextSocket();
    expect(harness.dialer.state()).not.toBe("refused");
    await harness.dialer.stop();
  });

  it("stops when it is asked to and opens nothing more", async () => {
    const harness = makeHarness();
    harness.dialer.start();
    const socket = await harness.nextSocket();
    socket.open();
    await settle();
    await harness.dialer.stop();
    const opened = harness.sockets.length;
    await settle();
    expect(harness.sockets).toHaveLength(opened);
    expect(harness.dialer.state()).toBe("stopped");
  });
});

describe("bridging to this server's own websocket", () => {
  it("queues what arrives before the local socket is up", async () => {
    const local = new FakeHubSocket();
    const factory = createLoopbackRelaySessionFactory({
      localWebSocketUrl: () => Promise.resolve("ws://127.0.0.1:1/ws?wsToken=x"),
      connect: () => local,
    });
    const received: Array<string> = [];
    const session = await factory({
      onData: (payload) => received.push(payload),
      onClose: () => {},
    });

    session.send('{"_tag":"Request"}');
    expect(local.sentRaw).toHaveLength(0);

    local.open();
    expect(local.sentRaw).toEqual(['{"_tag":"Request"}']);
    expect(received).toHaveLength(0);
  });

  it("reports the local socket closing as the channel closing", async () => {
    const local = new FakeHubSocket();
    const factory = createLoopbackRelaySessionFactory({
      localWebSocketUrl: () => Promise.resolve("ws://127.0.0.1:1/ws"),
      connect: () => local,
    });
    let closed = false;
    await factory({ onData: () => {}, onClose: () => (closed = true) });
    local.close();
    expect(closed).toBe(true);
  });
});
