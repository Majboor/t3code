import type { ServerAuthGateState } from "./environments/primary";

const DEFAULT_AUTH_ENTRY_PATH = "/pair";

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

  return input.authEntryPath ?? DEFAULT_AUTH_ENTRY_PATH;
}
