import type { WorkspaceSource } from "@t3tools/contracts";

import { canBrowserSatisfyAuthGate } from "./components/environments/environmentConnect.logic";
import type { ServerAuthGateState } from "./environments/primary";

const DEFAULT_AUTH_ENTRY_PATH = "/pair";
const ENVIRONMENTS_ENTRY_PATH = "/environments";

/**
 * What a person still needs before the workspace can be shown to them.
 *
 * Signing in and having somewhere to work used to be one condition, because
 * every server hosted its own projects. On a `paired-environment` server they
 * come apart: a session gets you an account, and the projects are on a machine
 * that has to be connected before there is anything to render. Conflating the
 * two is what stranded people on the environments page with no way through —
 * they had done everything asked of them and the shell still checked the wrong
 * fact.
 *
 * `savedEnvironmentCount` counts machines this person has added, not machines
 * answering right now. Liveness is deliberately not the test: connections are
 * established after the shell mounts, so every cold load would read zero and
 * eject someone who has done nothing wrong. Whether an environment is currently
 * reachable is the workspace's job to show, and a closed laptop is an ordinary
 * state rather than grounds for being thrown out of the app.
 */
export function resolveWorkspaceReadiness(input: {
  readonly workspaceSource: WorkspaceSource;
  readonly authenticated: boolean;
  readonly savedEnvironmentCount: number;
}): "ready" | "needs-session" | "needs-environment" {
  if (!input.authenticated) {
    return "needs-session";
  }

  if (input.workspaceSource === "this-server") {
    return "ready";
  }

  return input.savedEnvironmentCount > 0 ? "ready" : "needs-environment";
}

export function resolveAuthGateRedirect(input: {
  readonly authGateState: ServerAuthGateState;
  readonly pathname: string;
}): string | null {
  if (input.authGateState.status !== "authenticated") {
    return null;
  }

  if (input.authGateState.tenantStatus !== "pending-membership") {
    return null;
  }

  // `/share` is exempt alongside `/invite`, and for the same reason turned
  // around: a share recipient who has just created an account has no membership
  // yet, and acquiring one is precisely what the page they are on does. Bouncing
  // them to `/invite` would drop the share token and land them on "invite link
  // is missing" — a dead end at the last step of the flow that was working.
  return input.pathname === "/invite" || input.pathname === "/share" ? null : "/invite";
}

export function resolvePrivateRouteRedirect(input: {
  readonly authGateState: ServerAuthGateState;
  readonly authEntryPath?: string;
  /**
   * Omitted by callers on a server that hosts its own projects, where it cannot
   * change the answer. Defaulting the source to `this-server` keeps every such
   * caller — and the desktop app — on exactly the path they had before.
   */
  readonly workspaceSource?: WorkspaceSource;
  readonly savedEnvironmentCount?: number;
}): string | null {
  if (input.authGateState.status === "authenticated") {
    return resolveWorkspaceReadiness({
      workspaceSource: input.workspaceSource ?? "this-server",
      authenticated: true,
      savedEnvironmentCount: input.savedEnvironmentCount ?? 0,
    }) === "needs-environment"
      ? ENVIRONMENTS_ENTRY_PATH
      : null;
  }

  if (input.authEntryPath !== undefined) {
    return input.authEntryPath;
  }

  // `/pair` asks for a credential. When the environment that served this page
  // admits nothing a browser can produce — `desktop-managed-local` advertises
  // only `desktop-bootstrap` — that screen is a dead end, and the useful
  // answer is to connect a machine of your own instead.
  return canBrowserSatisfyAuthGate(input.authGateState.auth)
    ? DEFAULT_AUTH_ENTRY_PATH
    : ENVIRONMENTS_ENTRY_PATH;
}
