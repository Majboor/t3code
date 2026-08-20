import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { parseAccountMachines, type AccountMachine } from "./accountMachines.logic";

/**
 * The two calls Settings makes about connected machines.
 *
 * Plain HTTP against the primary environment, matching the enrollment client
 * next door: both are about the session itself rather than about anything
 * inside a workspace, and routing them through the environment RPC would put a
 * WebSocket handshake in front of the one screen somebody opens when they think
 * a machine has been stolen.
 *
 * Mirrors the routes in the server's account-machines HTTP module; change both
 * or neither.
 */

const ACCOUNT_MACHINES_PATH = "/api/devices/machines";

export class AccountMachineError extends Error {
  /** True when the server said "sign in", which the page reports rather than
   * retries — a stale session is fixed by signing in, not by asking again. */
  readonly signedOut: boolean;

  constructor(message: string, signedOut = false) {
    super(message);
    this.name = "AccountMachineError";
    this.signedOut = signedOut;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

async function failureFor(response: Response, fallback: string): Promise<AccountMachineError> {
  return new AccountMachineError(
    await readErrorMessage(response, fallback),
    response.status === 401,
  );
}

/** Every machine still holding a credential for this account. */
export async function fetchAccountMachines(): Promise<ReadonlyArray<AccountMachine>> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(ACCOUNT_MACHINES_PATH), {
    credentials: "include",
    method: "GET",
  }).catch(() => {
    throw new AccountMachineError(
      "Could not reach the server to list your machines. Check your connection and try again.",
    );
  });

  if (!response.ok) {
    throw await failureFor(response, "Could not list the machines connected to your account.");
  }

  return parseAccountMachines(await response.json().catch(() => null));
}

/**
 * Cut one machine off.
 *
 * The server revokes the session behind the machine before it marks the row, so
 * a reply of `ok` here means the credential is already dead — the page is not
 * reporting an intention, it is reporting a fact.
 */
export async function disconnectAccountMachine(machineId: string): Promise<void> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl(
      `${ACCOUNT_MACHINES_PATH}/${encodeURIComponent(machineId)}/revoke`,
    ),
    {
      credentials: "include",
      method: "POST",
    },
  ).catch(() => {
    throw new AccountMachineError(
      "Could not reach the server. That machine was not disconnected — try again.",
    );
  });

  if (!response.ok) {
    throw await failureFor(response, "Could not disconnect that machine.");
  }
}
