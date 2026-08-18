import "../../index.css";

import type { DesktopBridge, DesktopWorkspaceShareState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { WorkspaceSharingPanel } from "./WorkspaceSharingPanel";

const IDLE: DesktopWorkspaceShareState = {
  status: "not-shared",
  url: null,
  failureReason: null,
  diagnostics: null,
};

type ShareListener = (state: DesktopWorkspaceShareState) => void;

let listeners: ShareListener[] = [];

function stubBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  const bridge = {
    getWorkspaceShareState: vi.fn().mockResolvedValue(IDLE),
    startWorkspaceShare: vi.fn().mockResolvedValue({ ...IDLE, status: "starting" }),
    stopWorkspaceShare: vi.fn().mockResolvedValue(IDLE),
    onWorkspaceShareState: vi.fn().mockImplementation((listener: ShareListener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    }),
    getServerExposureState: vi.fn().mockResolvedValue({
      mode: "network-accessible",
      endpointUrl: "http://192.168.1.44:3773",
      advertisedHost: "192.168.1.44",
    }),
    ...overrides,
  } as unknown as DesktopBridge;

  (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge = bridge;
  return bridge;
}

let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  listeners = [];
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  Reflect.deleteProperty(window, "desktopBridge");
  vi.restoreAllMocks();
});

describe("WorkspaceSharingPanel", () => {
  it("states that sharing is public before the user can start it", async () => {
    stubBridge();
    mounted = await render(<WorkspaceSharingPanel />);

    await expect
      .element(page.getByTestId("workspace-sharing-headline"))
      .toHaveTextContent("Not shared");
    await expect
      .element(page.getByTestId("workspace-sharing-description"))
      .toHaveTextContent(/public internet/i);
  });

  it("requires confirmation before opening the tunnel", async () => {
    const bridge = stubBridge();
    mounted = await render(<WorkspaceSharingPanel />);

    await page.getByTestId("workspace-sharing-primary-action").click();
    expect(bridge.startWorkspaceShare).not.toHaveBeenCalled();

    await expect.element(page.getByTestId("workspace-sharing-confirm")).toBeInTheDocument();
    await page.getByTestId("workspace-sharing-confirm-start").click();

    await vi.waitFor(() => {
      expect(bridge.startWorkspaceShare).toHaveBeenCalled();
    });
  });

  it("shows the public URL with a copy action once live", async () => {
    stubBridge();
    mounted = await render(<WorkspaceSharingPanel />);
    await expect.element(page.getByTestId("workspace-sharing-headline")).toBeInTheDocument();

    for (const listener of listeners) {
      listener({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });
    }

    await expect
      .element(page.getByTestId("workspace-sharing-url"))
      .toHaveTextContent("https://calm-otter.trycloudflare.com");
    await expect.element(page.getByTestId("workspace-sharing-copy")).toBeInTheDocument();
  });

  it("stops immediately, without a confirmation, while live", async () => {
    const bridge = stubBridge();
    mounted = await render(<WorkspaceSharingPanel />);
    await expect.element(page.getByTestId("workspace-sharing-headline")).toBeInTheDocument();

    for (const listener of listeners) {
      listener({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });
    }

    await page.getByTestId("workspace-sharing-primary-action").click();
    await vi.waitFor(() => {
      expect(bridge.stopWorkspaceShare).toHaveBeenCalled();
    });
  });

  it("explains that cloudflared is missing and keeps a retry available", async () => {
    stubBridge({
      getWorkspaceShareState: vi.fn().mockResolvedValue({
        ...IDLE,
        status: "unavailable",
        failureReason: "cloudflared was not found on this computer.",
      }),
    } as Partial<DesktopBridge>);
    mounted = await render(<WorkspaceSharingPanel />);

    await expect.element(page.getByTestId("workspace-sharing-install-hint")).toBeInTheDocument();
    await expect
      .element(page.getByTestId("workspace-sharing-primary-action"))
      .toHaveTextContent("Try again");
  });

  it("attaches cloudflared output to a failure", async () => {
    stubBridge({
      getWorkspaceShareState: vi.fn().mockResolvedValue({
        ...IDLE,
        status: "failed",
        failureReason: "cloudflared did not publish a public URL within 25s.",
        diagnostics: "ERR failed to dial edge",
      }),
    } as Partial<DesktopBridge>);
    mounted = await render(<WorkspaceSharingPanel />);

    await expect
      .element(page.getByTestId("workspace-sharing-description"))
      .toHaveTextContent("cloudflared did not publish a public URL within 25s.");
    await expect
      .element(page.getByTestId("workspace-sharing-diagnostics"))
      .toHaveTextContent("ERR failed to dial edge");
  });

  it("warns that a guest cannot sign in while the server is loopback-only", async () => {
    stubBridge({
      getServerExposureState: vi.fn().mockResolvedValue({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      }),
    } as Partial<DesktopBridge>);
    mounted = await render(<WorkspaceSharingPanel />);
    await expect.element(page.getByTestId("workspace-sharing-headline")).toBeInTheDocument();

    for (const listener of listeners) {
      listener({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });
    }

    await expect
      .element(page.getByTestId("workspace-sharing-network-hint"))
      .toHaveTextContent(/Network access/);
  });
});
