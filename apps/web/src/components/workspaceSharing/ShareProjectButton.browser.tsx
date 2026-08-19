import "../../index.css";

import type {
  DesktopBridge,
  DesktopWorkspaceShareState,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ShareProjectButton } from "./ShareProjectButton";

const IDLE: DesktopWorkspaceShareState = {
  status: "not-shared",
  url: null,
  failureReason: null,
  diagnostics: null,
};

const environmentId = "env-local" as EnvironmentId;
const projectId = "proj-42" as ProjectId;

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
    ...overrides,
  } as unknown as DesktopBridge;

  (window as Window & { desktopBridge?: DesktopBridge }).desktopBridge = bridge;
  return bridge;
}

function pushShareState(state: DesktopWorkspaceShareState): void {
  for (const listener of listeners) listener(state);
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

describe("ShareProjectButton", () => {
  it("shows whether the machine is published without opening anything", async () => {
    stubBridge();
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    const trigger = page.getByTestId("project-share-trigger");
    await expect.element(trigger).toHaveAttribute("data-share-status", "not-shared");

    pushShareState({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });

    await expect.element(trigger).toHaveAttribute("data-share-status", "live");
    await expect.element(page.getByTestId("project-share-badge")).toHaveTextContent("Live");
  });

  it("states the exposure and waits for confirmation before starting", async () => {
    const bridge = stubBridge();
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    await page.getByTestId("project-share-trigger").click();
    await page.getByTestId("project-share-primary-action").click();
    expect(bridge.startWorkspaceShare).not.toHaveBeenCalled();

    await expect
      .element(page.getByTestId("project-share-confirm"))
      .toHaveTextContent(/public internet/i);
    await page.getByTestId("project-share-confirm-start").click();

    await vi.waitFor(() => {
      expect(bridge.startWorkspaceShare).toHaveBeenCalled();
    });
  });

  it("hands out a public address pointing at this project, with one copy action", async () => {
    stubBridge();
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    pushShareState({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });
    await page.getByTestId("project-share-trigger").click();

    await expect
      .element(page.getByTestId("project-share-url"))
      .toHaveTextContent("https://calm-otter.trycloudflare.com/project/env-local/proj-42");
    await expect.element(page.getByTestId("project-share-copy")).toBeInTheDocument();
  });

  it("names the durable kinds of link beside the one that dies with the laptop", async () => {
    stubBridge();
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    await page.getByTestId("project-share-trigger").click();

    await expect
      .element(page.getByTestId("project-share-tunnel"))
      .toHaveTextContent(/Ends when you stop sharing/i);
    await expect.element(page.getByTestId("project-share-kind-cloud")).toHaveTextContent(/synced/i);
    await expect
      .element(page.getByTestId("project-share-kind-share-link"))
      .toHaveTextContent(/revoke/i);
  });

  it("stops without a second confirmation while live", async () => {
    const bridge = stubBridge();
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    pushShareState({ ...IDLE, status: "live", url: "https://calm-otter.trycloudflare.com" });
    await page.getByTestId("project-share-trigger").click();
    await page.getByTestId("project-share-primary-action").click();

    await vi.waitFor(() => {
      expect(bridge.stopWorkspaceShare).toHaveBeenCalled();
    });
  });

  it("explains a missing cloudflared instead of failing silently", async () => {
    stubBridge({
      getWorkspaceShareState: vi.fn().mockResolvedValue({
        ...IDLE,
        status: "unavailable",
        failureReason: "cloudflared was not found on this computer.",
      }),
    } as Partial<DesktopBridge>);
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    await expect
      .element(page.getByTestId("project-share-trigger"))
      .toHaveAttribute("data-share-status", "unavailable");
    await page.getByTestId("project-share-trigger").click();
    await expect
      .element(page.getByTestId("project-share-tunnel-problem"))
      .toHaveTextContent("cloudflared was not found on this computer.");
  });

  it("is disabled in the browser build rather than offering an action it cannot run", async () => {
    mounted = await render(
      <ShareProjectButton environmentId={environmentId} projectId={projectId} />,
    );

    const trigger = page.getByTestId("project-share-trigger");
    await expect.element(trigger).toBeDisabled();
    await expect.element(trigger).toHaveAttribute("data-share-status", "unsupported");
  });
});
