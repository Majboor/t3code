import { isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

/**
 * Whether this process may run somebody's work on the operator's own provider
 * login.
 *
 * Several paths used to do it by accident — session recovery, and the title,
 * branch and pull-request niceties — by spawning a provider without an explicit
 * environment, so the child inherited the server's `HOME` and signed in as
 * whoever started it. On a desktop that is correct and invisible: the operator
 * is the only person there and the credential genuinely is theirs. On a host
 * with other accounts it means a stranger's prompt is billed to, logged under,
 * and answered by the operator's subscription.
 *
 * The first attempt at a guard asked whether the host looked public, and that
 * question cannot be answered from the bind address:
 *
 *   - `publishedBeyondLoopback` is an opt-in env var that defaults to false, so
 *     a server bound to 127.0.0.1 behind a reverse proxy — an extremely common
 *     deployment — read as a desktop and kept lending. The same defaulting
 *     mistake had already been found in `isSoleOccupantSession`.
 *   - A wildcard bind is not evidence of a crowd either: `t3 serve --host
 *     0.0.0.0` is the documented way to reach your OWN machine from your own
 *     phone, and refusing there breaks pairing for a single user.
 *
 * So this asks the question that actually decides it, the same one
 * `isSoleOccupantSession` settled on: how many accounts can sign in. One
 * account is the operator, and their credential is theirs to spend. Two is a
 * host with guests on it, whatever address it is bound to.
 *
 * `localAccountCount` is required rather than optional on purpose. An optional
 * count is one a caller can forget, and a caller that forgets it gets the
 * lending behaviour silently — the exact failure this exists to prevent.
 */
export function mayUseOperatorProviderCredentials(input: {
  readonly host: string | undefined;
  readonly publishedBeyondLoopback: boolean | undefined;
  /** Accounts that can currently sign in; `Infinity` when it could not be read. */
  readonly localAccountCount: number;
}): boolean {
  if (input.publishedBeyondLoopback === true) {
    // The operator said out loud that strangers reach this process.
    return false;
  }
  if (input.localAccountCount > 1) {
    return false;
  }
  // A single account, and nothing in front of the server carrying other people
  // to it. A wildcard bind is allowed here precisely so LAN pairing keeps
  // working for the one person using it.
  return isLoopbackHost(input.host) || isWildcardHost(input.host) || input.host === undefined;
}
