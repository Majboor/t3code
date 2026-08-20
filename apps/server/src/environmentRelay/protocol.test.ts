import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  isEnvironmentReportedState,
  isRelayGoodbyeRetryable,
  RELAY_MAX_PAYLOAD_BYTES,
  RELAY_PROTOCOL_VERSION,
  type RelayFrame,
} from "./protocol.ts";

const everyFrame: ReadonlyArray<RelayFrame> = [
  {
    type: "hello",
    protocolVersion: RELAY_PROTOCOL_VERSION,
    environmentId: "env-1",
    label: "Laptop",
  },
  { type: "hello", protocolVersion: RELAY_PROTOCOL_VERSION, environmentId: "env-1", label: null },
  { type: "welcome", environmentId: "env-1", heartbeatIntervalMs: 15_000 },
  { type: "ping", nonce: "n-1" },
  { type: "pong", nonce: "n-1", state: "ready", detail: null },
  { type: "pong", nonce: "n-1", state: "degraded", detail: "workspace missing" },
  { type: "open", channelId: "c-1" },
  { type: "data", channelId: "c-1", payload: '{"_tag":"Request"}' },
  { type: "data", channelId: "c-1", payload: "" },
  { type: "close", channelId: "c-1", reason: null },
  { type: "close", channelId: "c-1", reason: "browser went away" },
  { type: "bye", reason: "revoked", message: "This machine was disconnected." },
];

describe("a frame that went out and came back", () => {
  for (const frame of everyFrame) {
    it(`survives the round trip: ${frame.type}/${"reason" in frame ? frame.reason : "state" in frame ? frame.state : ""}`, () => {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    });
  }
});

describe("decoding is total", () => {
  it("answers null rather than throwing on anything that is not JSON", () => {
    // A frame arrives from a machine the hub does not run. Malformed input is
    // an ordinary event, and one stray byte must not drop a whole workspace.
    // The NUL is written as an escape rather than typed: a literal one in a
    // source file makes git treat the whole file as binary, and it is exactly
    // the kind of byte a frame off a wire can carry.
    for (const raw of ["", "{", "not json", "   ", "][", "\u0000"]) {
      expect(decodeFrame(raw)).toBeNull();
    }
  });

  it("refuses JSON that is not an object", () => {
    for (const raw of ["null", "1", '"hello"', "true", "[]", '[{"type":"ping","nonce":"n"}]']) {
      expect(decodeFrame(raw)).toBeNull();
    }
  });

  it("refuses a type it has never heard of", () => {
    expect(decodeFrame(JSON.stringify({ type: "shutdown" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: 7 }))).toBeNull();
    expect(decodeFrame(JSON.stringify({}))).toBeNull();
  });

  it("refuses a payload larger than the relay will copy", () => {
    const oversized = JSON.stringify({
      type: "data",
      channelId: "c-1",
      payload: "x".repeat(RELAY_MAX_PAYLOAD_BYTES),
    });
    expect(oversized.length).toBeGreaterThan(RELAY_MAX_PAYLOAD_BYTES);
    expect(decodeFrame(oversized)).toBeNull();
  });
});

describe("every field a frame will later be trusted for", () => {
  it("refuses a data frame with no channel", () => {
    // The one that matters: an undefined channel id used as a map key is one
    // browser's traffic arriving on another's connection.
    expect(decodeFrame(JSON.stringify({ type: "data", payload: "x" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "data", channelId: "", payload: "x" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "data", channelId: 12, payload: "x" }))).toBeNull();
  });

  it("refuses a data frame whose payload is not a string", () => {
    expect(
      decodeFrame(JSON.stringify({ type: "data", channelId: "c", payload: { a: 1 } })),
    ).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "data", channelId: "c" }))).toBeNull();
  });

  it("refuses a hello without a whole identity", () => {
    expect(decodeFrame(JSON.stringify({ type: "hello", protocolVersion: 1 }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "hello", environmentId: "e" }))).toBeNull();
    expect(
      decodeFrame(JSON.stringify({ type: "hello", protocolVersion: 1.5, environmentId: "e" })),
    ).toBeNull();
    expect(
      decodeFrame(JSON.stringify({ type: "hello", protocolVersion: "1", environmentId: "e" })),
    ).toBeNull();
  });

  it("refuses a hello whose label is not a string", () => {
    expect(
      decodeFrame(
        JSON.stringify({ type: "hello", protocolVersion: 1, environmentId: "e", label: 5 }),
      ),
    ).toBeNull();
  });

  it("refuses an over-long identifier, label or reason", () => {
    const long = "x".repeat(1_000);
    expect(
      decodeFrame(
        JSON.stringify({ type: "hello", protocolVersion: 1, environmentId: long, label: null }),
      ),
    ).toBeNull();
    expect(
      decodeFrame(
        JSON.stringify({ type: "hello", protocolVersion: 1, environmentId: "e", label: long }),
      ),
    ).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "close", channelId: "c", reason: long }))).toBeNull();
  });

  it("refuses a pong that reports a state nobody defined", () => {
    expect(decodeFrame(JSON.stringify({ type: "pong", nonce: "n", state: "fine" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "pong", nonce: "n" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "pong", state: "ready" }))).toBeNull();
  });

  it("refuses a welcome without a usable heartbeat interval", () => {
    expect(decodeFrame(JSON.stringify({ type: "welcome", environmentId: "e" }))).toBeNull();
    expect(
      decodeFrame(JSON.stringify({ type: "welcome", environmentId: "e", heartbeatIntervalMs: 0 })),
    ).toBeNull();
    expect(
      decodeFrame(JSON.stringify({ type: "welcome", environmentId: "e", heartbeatIntervalMs: -1 })),
    ).toBeNull();
  });

  it("refuses a goodbye with a reason the dialer could not act on", () => {
    expect(decodeFrame(JSON.stringify({ type: "bye", reason: "because" }))).toBeNull();
    expect(decodeFrame(JSON.stringify({ type: "bye" }))).toBeNull();
  });

  it("lets a goodbye arrive without a message", () => {
    expect(decodeFrame(JSON.stringify({ type: "bye", reason: "restarting" }))).toEqual({
      type: "bye",
      reason: "restarting",
      message: "",
    });
  });

  it("ignores fields it was not expecting rather than refusing the frame", () => {
    // Version skew in the additive direction: a newer environment sending a
    // field this hub has never heard of must not lose its connection over it.
    expect(decodeFrame(JSON.stringify({ type: "ping", nonce: "n", futureField: true }))).toEqual({
      type: "ping",
      nonce: "n",
    });
  });
});

describe("which goodbyes are worth retrying", () => {
  it("keeps the terminal ones terminal", () => {
    // A dialer that retried a revocation would hammer the hub forever with a
    // credential that is never coming back.
    expect(isRelayGoodbyeRetryable("revoked")).toBe(false);
    expect(isRelayGoodbyeRetryable("rejected")).toBe(false);
  });

  it("comes back for the hub's own housekeeping", () => {
    expect(isRelayGoodbyeRetryable("superseded")).toBe(true);
    expect(isRelayGoodbyeRetryable("restarting")).toBe(true);
  });
});

describe("the reported-state guard", () => {
  it("admits exactly the five states and nothing else", () => {
    for (const state of ["starting", "ready", "busy", "degraded", "stopping"]) {
      expect(isEnvironmentReportedState(state)).toBe(true);
    }
    for (const state of ["", "READY", "ok", null, undefined, 1, {}]) {
      expect(isEnvironmentReportedState(state)).toBe(false);
    }
  });
});
