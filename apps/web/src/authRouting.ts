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

  return input.pathname === "/invite" ? null : "/invite";
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
