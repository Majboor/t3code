import type { DesktopWorkspaceShareState, DesktopWorkspaceShareStatus } from "@t3tools/contracts";

/**
 * Shown before the user can start, never only afterwards: once the link exists it
 * is already public, so consent has to be informed up front.
 */
export const WORKSPACE_SHARE_EXPOSURE_WARNING =
  "Sharing puts this computer's workspace on the public internet through Cloudflare. Anyone who has the link reaches the same workspace you see here — treat it like a password, and stop sharing when you are done.";

export const WORKSPACE_SHARE_INSTALL_HINT =
  "Sharing uses Cloudflare's cloudflared tool. Install it, then reopen this panel.";

export type WorkspaceShareTone = "idle" | "pending" | "live" | "warning" | "error";

export type WorkspaceSharePrimaryAction = "start" | "stop";

export interface WorkspaceSharePresentation {
  readonly headline: string;
  readonly description: string;
  readonly tone: WorkspaceShareTone;
  readonly primaryAction: WorkspaceSharePrimaryAction | null;
  readonly primaryActionLabel: string;
  readonly isPrimaryActionDisabled: boolean;
  readonly isBusy: boolean;
  readonly url: string | null;
  readonly showExposureWarning: boolean;
  readonly showInstallHint: boolean;
}

export function createIdleWorkspaceShareState(): DesktopWorkspaceShareState {
  return { status: "not-shared", url: null, failureReason: null, diagnostics: null };
}

export function isWorkspaceShareLive(status: DesktopWorkspaceShareStatus): boolean {
  return status === "live";
}

export function isWorkspaceShareTransitioning(status: DesktopWorkspaceShareStatus): boolean {
  return status === "starting" || status === "stopping";
}

export function describeWorkspaceShare(
  state: DesktopWorkspaceShareState,
): WorkspaceSharePresentation {
  switch (state.status) {
    case "starting":
      return {
        headline: "Starting the tunnel…",
        description: "Waiting for Cloudflare to hand back a public address.",
        tone: "pending",
        primaryAction: "stop",
        primaryActionLabel: "Cancel",
        isPrimaryActionDisabled: false,
        isBusy: true,
        url: null,
        showExposureWarning: false,
        showInstallHint: false,
      };

    case "live":
      return {
        headline: "This workspace is shared",
        description: WORKSPACE_SHARE_EXPOSURE_WARNING,
        tone: "live",
        primaryAction: "stop",
        primaryActionLabel: "Stop sharing",
        isPrimaryActionDisabled: false,
        isBusy: false,
        url: state.url,
        showExposureWarning: false,
        showInstallHint: false,
      };

    case "stopping":
      return {
        headline: "Stopping…",
        description: "Closing the tunnel and revoking the public address.",
        tone: "pending",
        primaryAction: null,
        primaryActionLabel: "Stopping…",
        isPrimaryActionDisabled: true,
        isBusy: true,
        url: null,
        showExposureWarning: false,
        showInstallHint: false,
      };

    case "unavailable":
      return {
        headline: "cloudflared is not installed",
        description: state.failureReason ?? WORKSPACE_SHARE_INSTALL_HINT,
        tone: "warning",
        primaryAction: "start",
        primaryActionLabel: "Try again",
        isPrimaryActionDisabled: false,
        isBusy: false,
        url: null,
        showExposureWarning: false,
        showInstallHint: true,
      };

    case "failed":
      return {
        headline: "Sharing failed",
        description: state.failureReason ?? "The tunnel stopped unexpectedly.",
        tone: "error",
        primaryAction: "start",
        primaryActionLabel: "Try again",
        isPrimaryActionDisabled: false,
        isBusy: false,
        url: null,
        showExposureWarning: true,
        showInstallHint: false,
      };

    default:
      return {
        headline: "Not shared",
        description: WORKSPACE_SHARE_EXPOSURE_WARNING,
        tone: "idle",
        primaryAction: "start",
        primaryActionLabel: "Share workspace",
        isPrimaryActionDisabled: false,
        isBusy: false,
        url: null,
        showExposureWarning: true,
        showInstallHint: false,
      };
  }
}

/**
 * cloudflared can print thousands of lines; only the tail explains a failure, and an
 * unbounded blob in the DOM makes the actionable message impossible to find.
 */
export function formatWorkspaceShareDiagnostics(
  diagnostics: string | null,
  maxLines = 6,
): string | null {
  const trimmed = diagnostics?.trim();
  if (!trimmed) return null;
  return trimmed.split("\n").slice(-maxLines).join("\n");
}

export function formatWorkspaceShareHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
