import type { DesktopWorkspaceShareState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createIdleWorkspaceShareState,
  describeWorkspaceShare,
  formatWorkspaceShareDiagnostics,
  formatWorkspaceShareHost,
  isWorkspaceShareLive,
  isWorkspaceShareTransitioning,
  WORKSPACE_SHARE_EXPOSURE_WARNING,
} from "./workspaceSharing.logic";

const state = (patch: Partial<DesktopWorkspaceShareState>): DesktopWorkspaceShareState => ({
  ...createIdleWorkspaceShareState(),
  ...patch,
});

describe("describeWorkspaceShare", () => {
  it("warns about public exposure before anything is shared", () => {
    const view = describeWorkspaceShare(createIdleWorkspaceShareState());

    expect(view.showExposureWarning).toBe(true);
    expect(view.description).toBe(WORKSPACE_SHARE_EXPOSURE_WARNING);
    expect(view.primaryAction).toBe("start");
    expect(view.primaryActionLabel).toBe("Share workspace");
    expect(view.url).toBeNull();
  });

  it("offers cancelling while starting", () => {
    const view = describeWorkspaceShare(state({ status: "starting" }));

    expect(view.tone).toBe("pending");
    expect(view.isBusy).toBe(true);
    expect(view.primaryAction).toBe("stop");
    expect(view.primaryActionLabel).toBe("Cancel");
  });

  it("surfaces the URL and a stop action while live", () => {
    const view = describeWorkspaceShare(
      state({ status: "live", url: "https://calm-otter.trycloudflare.com" }),
    );

    expect(view.tone).toBe("live");
    expect(view.url).toBe("https://calm-otter.trycloudflare.com");
    expect(view.primaryAction).toBe("stop");
    expect(view.primaryActionLabel).toBe("Stop sharing");
    expect(view.description).toContain("Anyone who has the link");
  });

  it("blocks the action and hides the URL while stopping", () => {
    const view = describeWorkspaceShare(state({ status: "stopping" }));

    expect(view.primaryAction).toBeNull();
    expect(view.isPrimaryActionDisabled).toBe(true);
    expect(view.url).toBeNull();
  });

  it("explains a missing cloudflared and still allows a retry", () => {
    const view = describeWorkspaceShare(
      state({
        status: "unavailable",
        failureReason: "cloudflared was not found on this computer.",
      }),
    );

    expect(view.tone).toBe("warning");
    expect(view.showInstallHint).toBe(true);
    expect(view.description).toBe("cloudflared was not found on this computer.");
    expect(view.primaryAction).toBe("start");
  });

  it("shows the failure reason and re-states the warning before a retry", () => {
    const view = describeWorkspaceShare(
      state({
        status: "failed",
        failureReason: "cloudflared did not publish a public URL within 25s.",
        diagnostics: "ERR no edge",
      }),
    );

    expect(view.tone).toBe("error");
    expect(view.description).toBe("cloudflared did not publish a public URL within 25s.");
    expect(view.showExposureWarning).toBe(true);
    expect(view.primaryActionLabel).toBe("Try again");
  });

  it("falls back to generic copy when a failure carries no reason", () => {
    expect(describeWorkspaceShare(state({ status: "failed" })).description).toBe(
      "The tunnel stopped unexpectedly.",
    );
  });
});

describe("workspace share status predicates", () => {
  it("identifies the live status", () => {
    expect(isWorkspaceShareLive("live")).toBe(true);
    expect(isWorkspaceShareLive("starting")).toBe(false);
  });

  it("identifies the transitional statuses", () => {
    expect(isWorkspaceShareTransitioning("starting")).toBe(true);
    expect(isWorkspaceShareTransitioning("stopping")).toBe(true);
    expect(isWorkspaceShareTransitioning("live")).toBe(false);
    expect(isWorkspaceShareTransitioning("not-shared")).toBe(false);
  });
});

describe("formatWorkspaceShareDiagnostics", () => {
  it("keeps only the trailing lines", () => {
    expect(formatWorkspaceShareDiagnostics("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("returns null for empty or whitespace-only output", () => {
    expect(formatWorkspaceShareDiagnostics(null)).toBeNull();
    expect(formatWorkspaceShareDiagnostics("   \n  ")).toBeNull();
  });
});

describe("formatWorkspaceShareHost", () => {
  it("reduces the URL to its host for compact display", () => {
    expect(formatWorkspaceShareHost("https://calm-otter.trycloudflare.com")).toBe(
      "calm-otter.trycloudflare.com",
    );
  });

  it("passes through values that are not parseable URLs", () => {
    expect(formatWorkspaceShareHost("not a url")).toBe("not a url");
    expect(formatWorkspaceShareHost(null)).toBeNull();
  });
});
