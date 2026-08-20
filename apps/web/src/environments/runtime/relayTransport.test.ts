import { describe, expect, it } from "vitest";

import {
  chooseEnvironmentTransport,
  describeEnvironmentTransport,
  isRelayAttachWsUrl,
  relayAttachWsBaseUrl,
  type DirectEnvironmentTarget,
  type DirectReachability,
  type RelayEnvironmentTarget,
} from "./relayTransport";

const direct: DirectEnvironmentTarget = {
  httpBaseUrl: "http://192.168.1.20:3000",
  wsBaseUrl: "ws://192.168.1.20:3000/ws",
};

const relay: RelayEnvironmentTarget = {
  hubHttpBaseUrl: "https://hub.example",
  environmentId: "env-1",
};

const everyReachability: ReadonlyArray<DirectReachability> = [
  "reachable",
  "unreachable",
  "unknown",
];

describe("when there is only one way in", () => {
  it("uses the direct address when there is no relay", () => {
    for (const directReachability of everyReachability) {
      expect(chooseEnvironmentTransport({ direct, relay: null, directReachability })).toEqual({
        outcome: "connect",
        transport: "direct",
        reason: "only-transport",
      });
    }
  });

  it("uses the relay when there is no direct address", () => {
    // The case the feature exists for: a laptop behind NAT has no address to
    // offer, and never will.
    for (const directReachability of everyReachability) {
      expect(chooseEnvironmentTransport({ direct: null, relay, directReachability })).toEqual({
        outcome: "connect",
        transport: "relayed",
        reason: "only-transport",
      });
    }
  });

  it("says so when there is neither", () => {
    for (const directReachability of everyReachability) {
      expect(chooseEnvironmentTransport({ direct: null, relay: null, directReachability })).toEqual(
        { outcome: "unreachable" },
      );
    }
  });
});

describe("when both are on offer", () => {
  it("prefers direct when the environment answered on its own address", () => {
    // A relay in the middle of a connection to a box on the same desk is pure
    // cost and one more thing that can be down.
    expect(chooseEnvironmentTransport({ direct, relay, directReachability: "reachable" })).toEqual({
      outcome: "connect",
      transport: "direct",
      reason: "direct-reachable",
    });
  });

  it("falls back to the relay once direct is known to have failed", () => {
    expect(
      chooseEnvironmentTransport({ direct, relay, directReachability: "unreachable" }),
    ).toEqual({ outcome: "connect", transport: "relayed", reason: "direct-unreachable" });
  });

  it("still tries direct first when nothing has been probed yet", () => {
    // Trying it is how anything is ever learned about it. A preference that only
    // applies after a successful probe is a preference that never applies.
    expect(chooseEnvironmentTransport({ direct, relay, directReachability: "unknown" })).toEqual({
      outcome: "connect",
      transport: "direct",
      reason: "direct-untried",
    });
  });

  it("never answers relayed while direct is reachable or untried", () => {
    for (const directReachability of ["reachable", "unknown"] as const) {
      const result = chooseEnvironmentTransport({ direct, relay, directReachability });
      expect(result.outcome).toBe("connect");
      if (result.outcome === "connect") {
        expect(result.transport).toBe("direct");
      }
    }
  });
});

describe("where a relayed browser points", () => {
  it("names the environment in the path and upgrades the scheme", () => {
    expect(relayAttachWsBaseUrl(relay)).toBe(
      "wss://hub.example/api/environments/relay/attach/env-1",
    );
  });

  it("keeps a plain-http hub on ws", () => {
    expect(
      relayAttachWsBaseUrl({ hubHttpBaseUrl: "http://127.0.0.1:3000", environmentId: "env-1" }),
    ).toBe("ws://127.0.0.1:3000/api/environments/relay/attach/env-1");
  });

  it("escapes an environment name that would otherwise change the path", () => {
    expect(
      relayAttachWsBaseUrl({ hubHttpBaseUrl: "https://hub.example", environmentId: "a/../b" }),
    ).toBe("wss://hub.example/api/environments/relay/attach/a%2F..%2Fb");
  });

  it("recognises its own URLs and nothing else", () => {
    expect(isRelayAttachWsUrl(relayAttachWsBaseUrl(relay))).toBe(true);
    expect(isRelayAttachWsUrl("wss://hub.example/ws")).toBe(false);
    expect(isRelayAttachWsUrl("wss://hub.example/api/environments/relay")).toBe(false);
    expect(isRelayAttachWsUrl("not a url")).toBe(false);
    expect(isRelayAttachWsUrl("")).toBe(false);
  });
});

describe("what to tell the person", () => {
  it("names both transports distinctly", () => {
    const directWords = describeEnvironmentTransport("direct");
    const relayedWords = describeEnvironmentTransport("relayed");
    expect(directWords.label).not.toBe(relayedWords.label);
    expect(directWords.detail).not.toBe(relayedWords.detail);
    expect(directWords.label.length).toBeGreaterThan(0);
    expect(relayedWords.detail.length).toBeGreaterThan(0);
  });
});
