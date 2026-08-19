import type {
  DesktopWorkspaceShareState,
  DesktopWorkspaceShareStatus,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildTunnelProjectUrl,
  describeProjectShareTrigger,
  PROJECT_SHARE_LINK_KINDS,
} from "./projectShare.logic";
import { createIdleWorkspaceShareState } from "./workspaceSharing.logic";

const environmentId = "env-local" as EnvironmentId;
const projectId = "proj-42" as ProjectId;

const shareState = (status: DesktopWorkspaceShareStatus): DesktopWorkspaceShareState => ({
  ...createIdleWorkspaceShareState(),
  status,
});

const trigger = (status: DesktopWorkspaceShareStatus) =>
  describeProjectShareTrigger({ state: shareState(status), isDesktop: true });

describe("describeProjectShareTrigger", () => {
  it("stays quiet and offers sharing when nothing is shared", () => {
    const view = trigger("not-shared");

    expect(view.status).toBe("not-shared");
    expect(view.tone).toBe("idle");
    expect(view.badgeLabel).toBeNull();
    expect(view.isDisabled).toBe(false);
  });

  it("announces a live tunnel on the button itself", () => {
    const view = trigger("live");

    expect(view.tone).toBe("live");
    expect(view.badgeLabel).toBe("Live");
    expect(view.isBusy).toBe(false);
  });

  it("marks both transitions as busy without losing which one is running", () => {
    expect(trigger("starting")).toMatchObject({ badgeLabel: "Starting", isBusy: true });
    expect(trigger("stopping")).toMatchObject({ badgeLabel: "Stopping", isBusy: true });
  });

  it("separates a setup problem from a run failure", () => {
    expect(trigger("unavailable")).toMatchObject({ tone: "warning", badgeLabel: "Setup" });
    expect(trigger("failed")).toMatchObject({ tone: "error", badgeLabel: "Failed" });
  });

  it("disables itself in the browser build rather than offering a dead action", () => {
    const view = describeProjectShareTrigger({
      state: shareState("not-shared"),
      isDesktop: false,
    });

    expect(view.status).toBe("unsupported");
    expect(view.isDisabled).toBe(true);
    expect(view.ariaLabel).toMatch(/desktop app/i);
  });

  it("keeps the browser build disabled even if a stale live state is held", () => {
    const view = describeProjectShareTrigger({ state: shareState("live"), isDesktop: false });

    expect(view.isDisabled).toBe(true);
    expect(view.badgeLabel).toBeNull();
  });
});

describe("PROJECT_SHARE_LINK_KINDS", () => {
  it("names all three kinds so none can be mistaken for another", () => {
    expect(PROJECT_SHARE_LINK_KINDS.map((entry) => entry.kind)).toEqual([
      "tunnel",
      "cloud",
      "share-link",
    ]);
  });

  it("states a lifetime for every kind", () => {
    for (const entry of PROJECT_SHARE_LINK_KINDS) {
      expect(entry.lifetime.trim().length).toBeGreaterThan(0);
      expect(entry.source.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("buildTunnelProjectUrl", () => {
  it("points the public address at the project the sender is looking at", () => {
    expect(
      buildTunnelProjectUrl({
        shareUrl: "https://calm-otter.trycloudflare.com",
        environmentId,
        projectId,
      }),
    ).toBe("https://calm-otter.trycloudflare.com/project/env-local/proj-42");
  });

  it("replaces any path the tunnel address already carried", () => {
    expect(
      buildTunnelProjectUrl({
        shareUrl: "https://calm-otter.trycloudflare.com/somewhere/else",
        environmentId,
        projectId,
      }),
    ).toBe("https://calm-otter.trycloudflare.com/project/env-local/proj-42");
  });

  it("escapes ids that would otherwise break the path", () => {
    expect(
      buildTunnelProjectUrl({
        shareUrl: "https://calm-otter.trycloudflare.com",
        environmentId: "env/one" as EnvironmentId,
        projectId: "a b" as ProjectId,
      }),
    ).toBe("https://calm-otter.trycloudflare.com/project/env%2Fone/a%20b");
  });

  it("has nothing to offer while there is no tunnel", () => {
    expect(buildTunnelProjectUrl({ shareUrl: null, environmentId, projectId })).toBeNull();
  });

  it("passes through an address it cannot parse instead of hiding it", () => {
    expect(buildTunnelProjectUrl({ shareUrl: "not a url", environmentId, projectId })).toBe(
      "not a url",
    );
  });
});
