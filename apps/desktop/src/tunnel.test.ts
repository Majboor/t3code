import type { ServerAuthPolicy } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildQuickTunnelArgs,
  canStopWorkspaceShare,
  createWorkspaceShareState,
  evaluateWorkspaceSharePreflight,
  formatQuickTunnelTimeoutReason,
  interpretCloudflaredVersionProbe,
  parseCloudflaredVersion,
  parseQuickTunnelUrl,
  probeServerAuthPolicy,
  QuickTunnelController,
  QuickTunnelOutputCollector,
  reduceWorkspaceShareOnFailure,
  reduceWorkspaceShareOnStartRequested,
  reduceWorkspaceShareOnStopped,
  reduceWorkspaceShareOnStopRequested,
  reduceWorkspaceShareOnUnavailable,
  reduceWorkspaceShareOnUrlDetected,
} from "./tunnel.ts";

const CLOUDFLARED_BANNER = [
  "2024-08-15T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2024-08-15T10:00:01Z INF +----------------------------------------------------+",
  "2024-08-15T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at:   |",
  "2024-08-15T10:00:01Z INF |  https://polite-otter-runs-fast.trycloudflare.com   |",
  "2024-08-15T10:00:01Z INF +----------------------------------------------------+",
].join("\n");

describe("parseQuickTunnelUrl", () => {
  it("extracts the public URL from the cloudflared startup banner", () => {
    expect(parseQuickTunnelUrl(CLOUDFLARED_BANNER)).toBe(
      "https://polite-otter-runs-fast.trycloudflare.com",
    );
  });

  it("ignores the api.trycloudflare.com control-plane host", () => {
    expect(
      parseQuickTunnelUrl(
        'ERR failed to request quick Tunnel error=Post "https://api.trycloudflare.com/tunnel": timeout',
      ),
    ).toBeNull();
  });

  it("prefers the real hostname even when the control-plane host is logged first", () => {
    expect(
      parseQuickTunnelUrl(
        [
          "INF talking to https://api.trycloudflare.com/tunnel",
          "INF |  https://brave-mango-9x.trycloudflare.com  |",
        ].join("\n"),
      ),
    ).toBe("https://brave-mango-9x.trycloudflare.com");
  });

  it("returns null when no URL has been printed yet", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel\nINF Registered tunnel connection")).toBeNull();
  });

  it("normalises the URL to lower case", () => {
    expect(parseQuickTunnelUrl("visit HTTPS://Loud-Fox.TryCloudflare.com now")).toBe(
      "https://loud-fox.trycloudflare.com",
    );
  });
});

describe("QuickTunnelOutputCollector", () => {
  it("finds a URL split across two chunks", () => {
    const collector = new QuickTunnelOutputCollector();

    expect(collector.push("INF |  https://split-badger")).toBeNull();
    expect(collector.push(".trycloudflare.com  |\n")).toBe(
      "https://split-badger.trycloudflare.com",
    );
    expect(collector.getUrl()).toBe("https://split-badger.trycloudflare.com");
  });

  it("merges stdout and stderr chunks and accepts Buffers", () => {
    const collector = new QuickTunnelOutputCollector();

    collector.push(Buffer.from("INF booting\n"));
    expect(collector.push(Buffer.from("INF https://buffered-eel.trycloudflare.com\n"))).toBe(
      "https://buffered-eel.trycloudflare.com",
    );
  });

  it("keeps the first URL once found", () => {
    const collector = new QuickTunnelOutputCollector();

    collector.push("https://first-one.trycloudflare.com");
    collector.push("https://second-one.trycloudflare.com");
    expect(collector.getUrl()).toBe("https://first-one.trycloudflare.com");
  });

  it("retains a bounded tail of output for failure diagnostics", () => {
    const collector = new QuickTunnelOutputCollector();

    collector.push("x".repeat(20_000));
    collector.push("\nERR could not reach the edge");

    const diagnostics = collector.getDiagnostics();
    expect(diagnostics.length).toBeLessThanOrEqual(8_192);
    expect(diagnostics).toContain("ERR could not reach the edge");
  });
});

describe("buildQuickTunnelArgs", () => {
  it("points cloudflared at the loopback server and disables config and autoupdate", () => {
    expect(buildQuickTunnelArgs(3773)).toEqual([
      "--config",
      "/dev/null",
      "--no-autoupdate",
      "tunnel",
      "--url",
      "http://127.0.0.1:3773",
    ]);
  });
});

describe("interpretCloudflaredVersionProbe", () => {
  it("reports an actionable unavailable reason when the binary is missing", () => {
    const result = interpretCloudflaredVersionProbe({
      spawnError: { code: "ENOENT", message: "spawn cloudflared ENOENT" },
    });

    expect(result.available).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("surfaces other spawn errors verbatim", () => {
    const result = interpretCloudflaredVersionProbe({
      spawnError: { code: "EACCES", message: "spawn cloudflared EACCES" },
    });

    expect(result).toEqual({
      available: false,
      version: null,
      reason: "cloudflared could not be started: spawn cloudflared EACCES",
    });
  });

  it("treats a non-zero exit as unavailable", () => {
    expect(interpretCloudflaredVersionProbe({ exitCode: 127 }).available).toBe(false);
  });

  it("reports the version when the probe succeeds", () => {
    expect(
      interpretCloudflaredVersionProbe({
        exitCode: 0,
        stdout: "cloudflared version 2024.8.2 (built 2024-08-15-1400 UTC)",
      }),
    ).toEqual({ available: true, version: "2024.8.2", reason: null });
  });

  it("stays available when the version string is unrecognised", () => {
    expect(interpretCloudflaredVersionProbe({ exitCode: 0, stdout: "???" })).toEqual({
      available: true,
      version: null,
      reason: null,
    });
  });
});

describe("parseCloudflaredVersion", () => {
  it("pulls the semver-ish version out of the version banner", () => {
    expect(parseCloudflaredVersion("cloudflared version 2025.1.0 (built x)")).toBe("2025.1.0");
  });

  it("returns null for unrelated output", () => {
    expect(parseCloudflaredVersion("command not found")).toBeNull();
  });
});

describe("workspace share state machine", () => {
  it("starts out not shared", () => {
    expect(createWorkspaceShareState()).toEqual({
      status: "not-shared",
      url: null,
      failureReason: null,
      diagnostics: null,
    });
  });

  it("walks the happy path not-shared -> starting -> live -> stopping -> not-shared", () => {
    const starting = reduceWorkspaceShareOnStartRequested(createWorkspaceShareState());
    expect(starting.status).toBe("starting");

    const live = reduceWorkspaceShareOnUrlDetected(starting, "https://a-b-c.trycloudflare.com");
    expect(live).toEqual({
      status: "live",
      url: "https://a-b-c.trycloudflare.com",
      failureReason: null,
      diagnostics: null,
    });

    const stopping = reduceWorkspaceShareOnStopRequested(live);
    expect(stopping).toEqual({
      status: "stopping",
      url: null,
      failureReason: null,
      diagnostics: null,
    });

    expect(reduceWorkspaceShareOnStopped(stopping)).toEqual(createWorkspaceShareState());
  });

  it("refuses to start again while starting or live", () => {
    const starting = reduceWorkspaceShareOnStartRequested(createWorkspaceShareState());
    expect(reduceWorkspaceShareOnStartRequested(starting)).toBe(starting);

    const live = reduceWorkspaceShareOnUrlDetected(starting, "https://x.trycloudflare.com");
    expect(reduceWorkspaceShareOnStartRequested(live)).toBe(live);
  });

  it("allows retrying from failed and unavailable", () => {
    const failedWhileStarting = reduceWorkspaceShareOnFailure(
      reduceWorkspaceShareOnStartRequested(createWorkspaceShareState()),
      "boom",
      "ERR log tail",
    );
    expect(failedWhileStarting).toEqual({
      status: "failed",
      url: null,
      failureReason: "boom",
      diagnostics: "ERR log tail",
    });
    expect(reduceWorkspaceShareOnStartRequested(failedWhileStarting).status).toBe("starting");

    const unavailable = reduceWorkspaceShareOnUnavailable(createWorkspaceShareState(), "missing");
    expect(unavailable.status).toBe("unavailable");
    expect(reduceWorkspaceShareOnStartRequested(unavailable).status).toBe("starting");
  });

  it("treats a process exit during teardown as a clean stop, not a failure", () => {
    const stopping = reduceWorkspaceShareOnStopRequested(
      reduceWorkspaceShareOnUrlDetected(
        reduceWorkspaceShareOnStartRequested(createWorkspaceShareState()),
        "https://x.trycloudflare.com",
      ),
    );

    expect(reduceWorkspaceShareOnFailure(stopping, "cloudflared exited (signal=SIGTERM).")).toEqual(
      createWorkspaceShareState(),
    );
  });

  it("does not go live when a URL arrives after the user asked to stop", () => {
    const stopping = reduceWorkspaceShareOnStopRequested(
      reduceWorkspaceShareOnStartRequested(createWorkspaceShareState()),
    );

    expect(reduceWorkspaceShareOnUrlDetected(stopping, "https://late.trycloudflare.com")).toBe(
      stopping,
    );
  });

  it("makes stopping idempotent and clears stale failure text", () => {
    const failed = reduceWorkspaceShareOnFailure(
      reduceWorkspaceShareOnStartRequested(createWorkspaceShareState()),
      "boom",
      "tail",
    );

    expect(reduceWorkspaceShareOnStopRequested(failed)).toEqual(createWorkspaceShareState());
    expect(reduceWorkspaceShareOnStopRequested(createWorkspaceShareState())).toEqual(
      createWorkspaceShareState(),
    );
    expect(reduceWorkspaceShareOnStopped(createWorkspaceShareState())).toEqual(
      createWorkspaceShareState(),
    );
  });

  it("only permits stopping from starting and live", () => {
    expect(canStopWorkspaceShare("starting")).toBe(true);
    expect(canStopWorkspaceShare("live")).toBe(true);
    expect(canStopWorkspaceShare("stopping")).toBe(false);
    expect(canStopWorkspaceShare("not-shared")).toBe(false);
    expect(canStopWorkspaceShare("failed")).toBe(false);
    expect(canStopWorkspaceShare("unavailable")).toBe(false);
  });
});

describe("formatQuickTunnelTimeoutReason", () => {
  it("states the timeout in seconds", () => {
    expect(formatQuickTunnelTimeoutReason(25_000)).toBe(
      "cloudflared did not publish a public URL within 25s.",
    );
  });
});

describe("evaluateWorkspaceSharePreflight", () => {
  it("lets a desktop-managed server be shared", () => {
    expect(evaluateWorkspaceSharePreflight("desktop-managed-local")).toEqual({ allowed: true });
  });

  it("lets a server that already expects remote visitors be shared", () => {
    expect(evaluateWorkspaceSharePreflight("remote-reachable")).toEqual({ allowed: true });
  });

  it("refuses a loopback-browser server and names the fix", () => {
    const preflight = evaluateWorkspaceSharePreflight("loopback-browser");

    expect(preflight.allowed).toBe(false);
    expect(preflight.allowed === false && preflight.reason).toMatch(/network access/i);
    expect(preflight.allowed === false && preflight.reason).toMatch(/pair/i);
  });

  it("refuses a server started with authentication turned off, and names the fix", () => {
    const preflight = evaluateWorkspaceSharePreflight("unsafe-no-auth");

    expect(preflight.allowed).toBe(false);
    expect(preflight.allowed === false && preflight.reason).toMatch(/unsafe-no-auth/);
    expect(preflight.allowed === false && preflight.reason).toMatch(/network access/i);
  });

  it("refuses when the policy could not be read at all", () => {
    const preflight = evaluateWorkspaceSharePreflight(null);

    expect(preflight.allowed).toBe(false);
    expect(preflight.allowed === false && preflight.reason).toMatch(/could not read/i);
  });
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("probeServerAuthPolicy", () => {
  it("reads the policy without letting the probe mint a session of its own", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ auth: { policy: "loopback-browser" } }));

    await expect(probeServerAuthPolicy(3773, fetchImpl as unknown as typeof fetch)).resolves.toBe(
      "loopback-browser",
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3773/api/auth/session");
    expect((init.headers as Record<string, string>)["x-t3-auth-entry-path"]).toBe("/pair");
  });

  it("reports unknown rather than guessing when the server answers with nonsense", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ auth: { policy: "wide-open" } }));

    await expect(
      probeServerAuthPolicy(3773, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });

  it("reports unknown when the server is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      probeServerAuthPolicy(3773, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

describe("QuickTunnelController security preflight", () => {
  const makeController = (
    policy: ServerAuthPolicy | null,
    overrides?: { readonly resolveServerAuthPolicy?: () => Promise<ServerAuthPolicy | null> },
  ) => {
    const spawn = vi.fn();
    const probeAvailability = vi.fn(async () => ({
      available: true,
      version: "2024.8.2",
      reason: null,
    }));
    const controller = new QuickTunnelController({
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
      probeAvailability,
      resolveServerAuthPolicy: overrides?.resolveServerAuthPolicy ?? (async () => policy),
    });
    return { controller, spawn, probeAvailability };
  };

  it("never spawns cloudflared in front of a server that hands out owner sessions", async () => {
    const { controller, spawn } = makeController("loopback-browser");

    const state = await controller.start(3773);

    expect(spawn).not.toHaveBeenCalled();
    expect(state.status).toBe("unavailable");
    expect(state.url).toBeNull();
    expect(state.failureReason).toMatch(/network access/i);
  });

  it("never spawns cloudflared in front of a server with authentication turned off", async () => {
    const { controller, spawn } = makeController("unsafe-no-auth");

    const state = await controller.start(3773);

    expect(spawn).not.toHaveBeenCalled();
    expect(state.failureReason).toMatch(/unsafe-no-auth/);
  });

  it("refuses when the policy probe throws, rather than publishing an unknown server", async () => {
    const { controller, spawn } = makeController(null, {
      resolveServerAuthPolicy: () => Promise.reject(new Error("socket hang up")),
    });

    const state = await controller.start(3773);

    expect(spawn).not.toHaveBeenCalled();
    expect(state.status).toBe("unavailable");
    expect(state.failureReason).toMatch(/could not read/i);
  });

  it("checks the policy before spending time on cloudflared", async () => {
    const { controller, probeAvailability } = makeController("loopback-browser");

    await controller.start(3773);

    expect(probeAvailability).not.toHaveBeenCalled();
  });

  it("goes ahead for a desktop-managed server", async () => {
    const { controller, spawn } = makeController("desktop-managed-local");
    spawn.mockImplementation(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    }));

    const state = await controller.start(3773);

    expect(spawn).toHaveBeenCalledOnce();
    expect(state.status).toBe("starting");

    controller.disposeSync();
  });
});
