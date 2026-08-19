import type { DesktopWorkspaceShareState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createHttpLiveShareRegistrar,
  isUsableLiveShareEndpoint,
  LiveShareCoordinator,
  type LiveShareRegistrar,
  type LiveShareTunnel,
} from "./liveShare.ts";

const TUNNEL_URL = "https://tiny-fox-42.trycloudflare.com";

const shareState = (
  overrides: Partial<DesktopWorkspaceShareState> = {},
): DesktopWorkspaceShareState => ({
  status: "not-shared",
  url: null,
  failureReason: null,
  diagnostics: null,
  ...overrides,
});

/** A tunnel whose state the test moves by hand, like cloudflared taking its time. */
class FakeTunnel implements LiveShareTunnel {
  state: DesktopWorkspaceShareState = shareState();
  startedOn: number | null = null;
  stops = 0;

  async start(port: number): Promise<DesktopWorkspaceShareState> {
    this.startedOn = port;
    this.state = shareState({ status: "starting" });
    return this.state;
  }

  publish(url: string): void {
    this.state = shareState({ status: "live", url });
  }

  stop(): DesktopWorkspaceShareState {
    this.stops += 1;
    this.state = shareState();
    return this.state;
  }

  getState(): DesktopWorkspaceShareState {
    return this.state;
  }
}

class FakeRegistrar implements LiveShareRegistrar {
  readonly registrations: Array<string | null> = [];
  handoffs = 0;
  failWith: Error | null = null;

  async registerLiveCopy(url: string | null): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.registrations.push(url);
  }

  async registerHandoff(): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.handoffs += 1;
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Intervals shrunk to nothing; every one of them is injectable for this reason. */
const fast = { heartbeatMs: 5, startupPollMs: 1, handoffGraceMs: 1 };

describe("publishing a live copy beside the sync", () => {
  it("registers the tunnel as soon as it has an address, and not before", async () => {
    const tunnel = new FakeTunnel();
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    const begun = await coordinator.begin(4317);
    expect(tunnel.startedOn).toBe(4317);
    expect(begun.phase).toBe("starting");
    // The first heartbeat goes out before cloudflared has said anything. It is
    // what proves a laptop is behind this sync at all, which is the difference
    // between "still uploading" and "they closed their laptop".
    expect(registrar.registrations).toEqual([null]);

    tunnel.publish(TUNNEL_URL);
    await waitFor(() => coordinator.getState().phase === "live", "the tunnel to be registered");
    expect(coordinator.getState().url).toBe(TUNNEL_URL);
    expect(registrar.registrations).toContain(TUNNEL_URL);

    await coordinator.stop();
  });

  it("keeps re-registering while it lives, because a registration goes stale on purpose", async () => {
    const tunnel = new FakeTunnel();
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    await coordinator.begin(4317);
    tunnel.publish(TUNNEL_URL);
    await waitFor(
      () => registrar.registrations.filter((url) => url === TUNNEL_URL).length >= 3,
      "the heartbeat to repeat",
    );

    await coordinator.stop();
    // Stopping withdraws rather than leaving the cloud to age it out, so nobody
    // is sent to an address that has already stopped answering.
    expect(registrar.registrations.at(-1)).toBeNull();
    expect(tunnel.stops).toBeGreaterThan(0);
  });

  it("lets the sync go ahead when the tunnel refuses to start", async () => {
    const tunnel = new FakeTunnel();
    // What the preflight does in front of a server that would hand a visitor an
    // owner session, and what a missing cloudflared does. Neither is a reason to
    // stop uploading.
    tunnel.start = async () => {
      tunnel.state = shareState({
        status: "unavailable",
        failureReason: "cloudflared was not found on this computer.",
      });
      return tunnel.state;
    };
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    const state = await coordinator.begin(4317);
    expect(state.phase).toBe("no-live-copy");
    expect(state.reason).toBe("cloudflared was not found on this computer.");
    // Stated rather than implied: a UI reading this must not have to infer from
    // the absence of an error that the upload is still running.
    expect(state.syncProceeds).toBe(true);
    // And the heartbeat continues, so the cloud can still say "still uploading".
    expect(registrar.registrations).toEqual([null]);
    await waitFor(() => registrar.registrations.length >= 2, "the heartbeat to continue");

    await coordinator.stop();
  });

  it("never lets a failed registration stop the share", async () => {
    const tunnel = new FakeTunnel();
    const registrar = new FakeRegistrar();
    registrar.failWith = new Error("the network went away");
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    const state = await coordinator.begin(4317);
    expect(state.lastRegistrationError).toBe("the network went away");
    expect(state.lastRegisteredAt).toBeNull();
    expect(state.syncProceeds).toBe(true);

    // And it recovers on its own rather than needing to be restarted.
    registrar.failWith = null;
    tunnel.publish(TUNNEL_URL);
    await waitFor(
      () => coordinator.getState().lastRegistrationError === null,
      "the heartbeat to recover",
    );
    expect(coordinator.getState().lastRegisteredAt).not.toBeNull();

    await coordinator.stop();
  });

  it("refuses to register an address the cloud would not redirect to", async () => {
    const tunnel = new FakeTunnel();
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    await coordinator.begin(4317);
    tunnel.publish("http://tiny-fox-42.example.com");
    await waitFor(
      () => coordinator.getState().phase === "no-live-copy",
      "the unusable address to be rejected",
    );
    expect(registrar.registrations.every((url) => url === null)).toBe(true);

    await coordinator.stop();
  });
});

describe("handing visitors over when the first pass completes", () => {
  it("tells this laptop where home is, withdraws itself, then stops the tunnel", async () => {
    const tunnel = new FakeTunnel();
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    await coordinator.begin(4317);
    tunnel.publish(TUNNEL_URL);
    await waitFor(() => coordinator.getState().phase === "live", "the tunnel to be registered");

    const handed = await coordinator.firstPassComplete();
    expect(handed.phase).toBe("handed-off");
    expect(handed.url).toBeNull();
    // The redirect is registered before the address is withdrawn, so a visitor
    // who arrives in between is sent home rather than served a copy that has
    // stopped being canonical.
    expect(registrar.handoffs).toBe(1);
    expect(registrar.registrations.at(-1)).toBeNull();

    // The tunnel survives the moment of handoff and stops shortly after: long
    // enough to redirect whoever is on it, short enough that the public door
    // into this laptop closes while its owner is still at their desk.
    await waitFor(() => tunnel.stops > 0, "the tunnel to be stopped");
    // Nothing keeps beating afterwards; the cloud copy is the answer now.
    const after = registrar.registrations.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registrar.registrations.length).toBe(after);
  });

  it("hands over even when the tunnel never published anything", async () => {
    const tunnel = new FakeTunnel();
    tunnel.start = async () => {
      tunnel.state = shareState({ status: "unavailable", failureReason: "no cloudflared" });
      return tunnel.state;
    };
    const registrar = new FakeRegistrar();
    const coordinator = new LiveShareCoordinator({ tunnel, registrar, ...fast });

    await coordinator.begin(4317);
    const handed = await coordinator.firstPassComplete();
    expect(handed.phase).toBe("handed-off");
    expect(registrar.handoffs).toBe(1);
  });
});

describe("the two calls a share makes", () => {
  it("registers the live copy with the cloud and the handoff with this laptop", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const registrar = createHttpLiveShareRegistrar({
      cloudBaseUrl: "https://app.t3.tools",
      localBaseUrl: "http://127.0.0.1:4317",
      scope: { tenantId: "tenant-atlas", workspaceId: "workspace-platform", projectId: "atlas" },
      authorization: "Bearer token",
      fetchImpl: (async (input: URL | string, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
        return new Response(null, { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });

    await registrar.registerLiveCopy(TUNNEL_URL);
    expect(calls[0]?.url).toBe("https://app.t3.tools/api/cloud-sync/live-copy");
    expect(calls[0]?.body).toMatchObject({ projectId: "atlas", url: TUNNEL_URL });

    await registrar.registerHandoff();
    // Registered against this laptop, because the tunnel published this laptop
    // and this is the only machine that can catch a visitor still on it.
    expect(calls[1]?.url).toBe("http://127.0.0.1:4317/api/cloud-sync/handoff");
    // And the address it sends them to is the cloud's — never the tunnel's,
    // which changes on every restart and dies with the machine.
    expect(calls[1]?.body).toMatchObject({
      canonicalUrl: "https://app.t3.tools/projects/atlas",
    });
  });

  it("will not post anywhere a visitor could not safely be sent", () => {
    expect(isUsableLiveShareEndpoint("https://app.t3.tools")).toBe(true);
    expect(isUsableLiveShareEndpoint("http://127.0.0.1:5173")).toBe(true);
    expect(isUsableLiveShareEndpoint("http://evil.example")).toBe(false);
    expect(isUsableLiveShareEndpoint("javascript:alert(1)")).toBe(false);
    expect(isUsableLiveShareEndpoint(null)).toBe(false);
  });
});
