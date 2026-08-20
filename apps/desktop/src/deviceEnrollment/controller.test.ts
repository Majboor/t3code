import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrollmentClient } from "./client.ts";
import { createDeviceEnrollmentController } from "./controller.ts";
import type { DeviceEnrollmentState } from "./machine.ts";
import type { CollectedEnrollment, EnrollmentStatus } from "./types.ts";

const NOW = 1_700_000_000_000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

const CREATED = {
  code: "ABC123xyz",
  approveUrl: "https://app.logicpacks.io/devices/ABC123xyz",
  expiresAtMs: NOW + TEN_MINUTES_MS,
};

const CREDENTIAL: CollectedEnrollment = {
  sessionToken: "secret-token",
  environmentId: "env-1",
  label: "Atlas",
  httpBaseUrl: "https://app.logicpacks.io",
  wsBaseUrl: "wss://app.logicpacks.io",
};

/**
 * A scripted server. `statuses` is consumed one answer per poll, and the last
 * one repeats — so a test states only the sequence it cares about.
 */
function scriptedClient(options: {
  statuses: readonly (EnrollmentStatus | "throw")[];
  create?: () => Promise<typeof CREATED>;
  collect?: EnrollmentClient["collect"];
}) {
  let index = 0;
  const reads: string[] = [];
  const collects: string[] = [];

  const client: EnrollmentClient = {
    create: options.create ?? (async () => CREATED),
    read: async (code) => {
      reads.push(code);
      const answer = options.statuses[Math.min(index, options.statuses.length - 1)];
      index += 1;
      if (answer === "throw" || answer === undefined) {
        throw new Error("network unreachable");
      }
      return {
        status: answer,
        deviceLabel: null,
        devicePlatform: null,
        requestedIp: null,
        expiresAtMs: CREATED.expiresAtMs,
      };
    },
    collect:
      options.collect ??
      (async (code) => {
        collects.push(code);
        return { outcome: "collected", credential: CREDENTIAL };
      }),
  };

  return { client, reads, collects };
}

function harness(client: EnrollmentClient, overrides: { persist?: () => Promise<void> } = {}) {
  const states: DeviceEnrollmentState[] = [];
  const opened: string[] = [];
  const persisted: CollectedEnrollment[] = [];

  const controller = createDeviceEnrollmentController({
    client,
    deviceLabel: "Waleeds-MacBook",
    devicePlatform: "macos",
    openExternal: (url) => opened.push(url),
    persist:
      overrides.persist ??
      (async (credential) => {
        persisted.push(credential);
      }),
    onState: (state) => states.push(state),
    now: () => Date.now(),
  });

  return { controller, states, opened, persisted };
}

/** Runs the loop forward far enough for any scheduled poll to have fired. */
async function settle(ms = 60_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("createDeviceEnrollmentController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for a code, sends the person to the browser, then polls to the credential", async () => {
    const { client, collects } = scriptedClient({ statuses: ["pending", "pending", "approved"] });
    const { controller, opened, persisted } = harness(client);

    controller.start();
    await settle();

    expect(opened).toEqual([CREATED.approveUrl]);
    expect(collects).toEqual([CREATED.code]);
    expect(persisted).toEqual([CREDENTIAL]);
    expect(controller.getState().phase).toBe("connected");
  });

  /*
   * The credential is spent by the time `persist` runs. If storing it fails
   * there is nothing to retry, so the flow must say so rather than sit in
   * "collecting" forever.
   */
  it("reports a failure to store rather than claiming to have connected", async () => {
    const { client } = scriptedClient({ statuses: ["approved"] });
    const { controller } = harness(client, {
      persist: async () => {
        throw new Error("keychain unavailable");
      },
    });

    controller.start();
    await settle();

    const state = controller.getState();
    expect(state.phase).toBe("failed");
    expect(state.canRetry).toBe(true);
  });

  it("stops polling the moment the request is denied", async () => {
    const { client, reads } = scriptedClient({ statuses: ["pending", "denied"] });
    const { controller } = harness(client);

    controller.start();
    await settle();
    const readsAtDenial = reads.length;
    await settle();

    expect(controller.getState().phase).toBe("denied");
    expect(reads.length).toBe(readsAtDenial);
  });

  /*
   * The failure this whole feature was asked to avoid. With the server
   * unreachable there is never a response to notice the deadline in, so only an
   * independent timer can end the flow — otherwise "waiting for approval" stays
   * on screen forever.
   */
  it("expires on its own when the server never answers at all", async () => {
    const { client } = scriptedClient({ statuses: ["throw"] });
    const { controller } = harness(client);

    controller.start();
    await settle(TEN_MINUTES_MS + 1_000);

    expect(["expired", "failed"]).toContain(controller.getState().phase);
    expect(controller.getState().canRetry).toBe(true);
  });

  it("expires on its own while the server keeps answering pending", async () => {
    const { client } = scriptedClient({ statuses: ["pending"] });
    const { controller } = harness(client);

    controller.start();
    await settle(TEN_MINUTES_MS + 1_000);

    expect(controller.getState().phase).toBe("expired");
  });

  it("stops making requests once it has expired", async () => {
    const { client, reads } = scriptedClient({ statuses: ["pending"] });
    const { controller } = harness(client);

    controller.start();
    await settle(TEN_MINUTES_MS + 1_000);
    const readsAtExpiry = reads.length;
    await settle(TEN_MINUTES_MS);

    expect(reads.length).toBe(readsAtExpiry);
  });

  /*
   * Anything can hand this app a `logicpacks://` URL. Only a link naming the
   * code this process asked for describes this machine.
   */
  it("ignores a deep link naming somebody else's code", async () => {
    const { client } = scriptedClient({ statuses: ["pending"] });
    const { controller } = harness(client);

    controller.start();
    await settle(2_000);

    expect(controller.handleApprovalCallback("someone-elses-code")).toBe(false);
    expect(controller.getState().phase).toBe("waiting");
  });

  it("acts on a deep link naming the code in flight, without waiting out the backoff", async () => {
    const { client, reads } = scriptedClient({ statuses: ["pending", "approved"] });
    const { controller, persisted } = harness(client);

    controller.start();
    await settle(2_000);
    const readsBeforeLink = reads.length;

    expect(controller.handleApprovalCallback(CREATED.code)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(reads.length).toBeGreaterThan(readsBeforeLink);
    expect(persisted).toEqual([CREDENTIAL]);
  });

  it("has nothing to act on when a link arrives before anything was started", () => {
    const { client } = scriptedClient({ statuses: ["pending"] });
    const { controller } = harness(client);
    expect(controller.handleApprovalCallback(CREATED.code)).toBe(false);
  });

  /*
   * A second click while a code is live would abandon one the person may be
   * mid-way through approving in another window.
   */
  it("does not abandon a live run when Connect is clicked again", async () => {
    let creates = 0;
    const { client } = scriptedClient({
      statuses: ["pending"],
      create: async () => {
        creates += 1;
        return CREATED;
      },
    });
    const { controller } = harness(client);

    controller.start();
    await settle(2_000);
    controller.start();
    await settle(2_000);

    expect(creates).toBe(1);
  });

  it("asks for a fresh code when the person starts over", async () => {
    let creates = 0;
    const { client } = scriptedClient({
      statuses: ["denied"],
      create: async () => {
        creates += 1;
        return { ...CREATED, code: `code-${creates}` };
      },
    });
    const { controller } = harness(client);

    controller.start();
    await settle();
    expect(controller.getState().phase).toBe("denied");

    controller.restart();
    await vi.advanceTimersByTimeAsync(0);

    expect(creates).toBe(2);
    expect(controller.getState().code).toBe("code-2");
  });

  it("surfaces a failure to get a code at all, with a way to retry", async () => {
    const { client } = scriptedClient({
      statuses: ["pending"],
      create: async () => {
        throw new Error("the service is unreachable");
      },
    });
    const { controller } = harness(client);

    controller.start();
    await settle();

    const state = controller.getState();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe("the service is unreachable");
    expect(state.canRetry).toBe(true);
  });

  it("keeps waiting through a collect that arrives before the approval settles", async () => {
    let collectCalls = 0;
    const { client } = scriptedClient({
      statuses: ["approved"],
      collect: async () => {
        collectCalls += 1;
        return collectCalls === 1
          ? { outcome: "not-ready" }
          : { outcome: "collected", credential: CREDENTIAL };
      },
    });
    const { controller, persisted } = harness(client);

    controller.start();
    await settle();

    expect(collectCalls).toBeGreaterThan(1);
    expect(persisted).toEqual([CREDENTIAL]);
  });

  it("stops everything when disposed, so a closed window leaves no loop running", async () => {
    const { client, reads } = scriptedClient({ statuses: ["pending"] });
    const { controller } = harness(client);

    controller.start();
    await settle(3_000);
    const readsAtDispose = reads.length;
    controller.dispose();
    await settle(30_000);

    expect(reads.length).toBe(readsAtDispose);
  });
});
