import { canBrowserSatisfyAuthGate } from "./components/environments/environmentConnect.logic";
import type { ServerAuthGateState } from "./environments/primary";

const DEFAULT_AUTH_ENTRY_PATH = "/pair";
const ENVIRONMENTS_ENTRY_PATH = "/environments";

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
}): string | null {
  if (input.authGateState.status === "authenticated") {
    return null;
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
