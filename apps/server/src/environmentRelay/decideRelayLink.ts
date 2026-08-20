/**
 * When an outbound environment connection counts as connected, and when it
 * counts as somebody else's.
 *
 * Two separate rule sets live here because they are the two ways a relay lies.
 *
 * The first is the green dot. A relayed environment holds a socket open for
 * days across sleeps, NAT rebinds and process restarts, so the socket outlives
 * almost everything that could go wrong behind it: the server can be wedged,
 * the workspace unmounted, the machine swapped out from under it, and the TCP
 * connection is still perfectly open. This codebase has already shipped a
 * health check that believed a dead process was alive because something was
 * listening (`docs/`), and a relay makes that mistake cheaper to make and much
 * more expensive to notice — a person stares at a green dot and waits for a
 * turn that will never start. So `connected` here is a claim about a *recent
 * exchange* plus what the far end says about itself, and never about whether a
 * file descriptor is open.
 *
 * The second is identity. An environment names itself when it dials in, and a
 * name that could be claimed by whoever asks would let one machine take over
 * the routing entry for another — the browser would keep talking to the saved
 * environment it has always talked to, and reach a different computer.
 *
 * Pure and total, like `decideEnrollment.ts`, and for the same reason: these
 * are the rules that decide whose machine a browser is about to reach, and they
 * should be readable and testable without a socket, a clock or a database.
 *
 * @module EnvironmentRelay
 */

import type { EnvironmentReportedState } from "./protocol.ts";

/**
 * How often the hub asks, and how many unanswered asks it tolerates.
 *
 * Fifteen seconds matches the presence heartbeat in `filePresence.ts`, which is
 * the same shape of problem — a claim that has to die on its own because the
 * thing making it may never get to say goodbye. Three missed beats before the
 * link is called unhealthy: one missed beat is a garbage-collection pause or a
 * train going into a tunnel, and demoting a working environment for that would
 * make the indicator flicker and therefore make it worthless.
 *
 * Forty-five seconds of silence, though, is not a pause. Nothing that can serve
 * a turn goes that long without answering a one-byte question.
 */
export const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const RELAY_MISSED_BEATS_ALLOWED = 3;

export interface RelayHealthWindow {
  readonly intervalMs?: number;
  readonly missedBeatsAllowed?: number;
}

export function relayHealthDeadlineMs(window?: RelayHealthWindow): number {
  const intervalMs = window?.intervalMs ?? RELAY_HEARTBEAT_INTERVAL_MS;
  const missed = window?.missedBeatsAllowed ?? RELAY_MISSED_BEATS_ALLOWED;
  return intervalMs * missed;
}

/**
 * Everything the hub knows about one outbound connection, and nothing it does
 * not.
 *
 * All three timestamps are the *hub's* clock, taken when a frame arrived, so
 * there is no skew to forgive: the environment never tells the hub what time it
 * is. That is deliberate. A far end that reported its own timestamps could keep
 * itself looking fresh forever by lying, which is precisely the failure mode
 * this module exists to refuse.
 */
export interface RelayLinkObservation {
  /** Whether the transport is up. Necessary, and nowhere near sufficient. */
  readonly socketOpen: boolean;
  /**
   * Whether the credential behind this connection has been cut off. Checked
   * first and separately from everything else, because a revoked machine must
   * stop carrying traffic in the same instant, not at the next heartbeat.
   */
  readonly revoked: boolean;
  /** When the hub accepted the environment's claim to its own identity. */
  readonly acceptedAtMs: number | null;
  /** When a ping the hub sent last came back. The load-bearing field. */
  readonly lastHealthAtMs: number | null;
  /** What the environment said about itself in that answer. */
  readonly reportedState: EnvironmentReportedState | null;
  readonly reportedDetail: string | null;
}

/**
 * `connecting` is not a transient the caller can ignore: an environment whose
 * socket is up but which has not yet answered a ping sits here, and it is the
 * honest answer for the whole of that window.
 *
 * `unhealthy` and `offline` are kept apart because they need different words in
 * front of a person. `offline` means the machine is not there — close the lid,
 * lose the wifi. `unhealthy` means it is there and cannot work, which is the
 * one worth showing a detail line for.
 */
export type RelayLinkState = "offline" | "connecting" | "connected" | "unhealthy" | "revoked";

export type RelayLinkReason =
  | "socket-closed"
  | "machine-revoked"
  | "identity-pending"
  | "awaiting-first-health"
  | "health-stale"
  | "environment-degraded"
  | "environment-starting"
  | "environment-stopping"
  | "healthy";

export interface RelayLinkVerdict {
  readonly state: RelayLinkState;
  readonly reason: RelayLinkReason;
  /**
   * How long ago the last answered ping was, or `null` if there has never been
   * one. Surfaced rather than kept private because "connected, last heard from
   * 2s ago" is a different sentence from "connected", and only one of them is
   * checkable by the person reading it.
   */
  readonly healthAgeMs: number | null;
  /**
   * Whether the hub may open a browser channel on this link right now.
   *
   * Only ever true for `connected`. Attaching a browser to a link that is not
   * demonstrably healthy produces a socket that opens and then hangs, which
   * reads to the person as the app being broken rather than the environment
   * being asleep — a refusal at attach time can at least say which.
   */
  readonly acceptsTraffic: boolean;
  /** The environment's own words, when it has any. Never invented here. */
  readonly detail: string | null;
}

/**
 * The whole green-dot rule, stated once.
 *
 * Order is the argument. Revocation outranks everything including an open
 * socket, because the question "may this carry traffic" must not be answerable
 * by a machine that has been cut off. Liveness of the transport comes next
 * because nothing else is meaningful without it. Only then does the recency of
 * the health exchange get consulted, and only then what the environment claims
 * — a claim of `ready` from a process that stopped answering forty seconds ago
 * is exactly the stale reassurance this is built to discard.
 */
export function decideRelayLink(input: {
  readonly observation: RelayLinkObservation;
  readonly nowMs: number;
  readonly window?: RelayHealthWindow;
}): RelayLinkVerdict {
  const { observation, nowMs } = input;

  const healthAgeMs =
    observation.lastHealthAtMs === null
      ? null
      : // Clamped at zero rather than allowed negative. The two timestamps come
        // from the same clock so this should be impossible; if a test or a
        // future caller passes a `nowMs` behind the observation, "0ms ago" is a
        // less misleading answer than a negative age that compares as fresh.
        Math.max(0, nowMs - observation.lastHealthAtMs);

  const verdict = (
    state: RelayLinkState,
    reason: RelayLinkReason,
    acceptsTraffic: boolean,
  ): RelayLinkVerdict => ({
    state,
    reason,
    healthAgeMs,
    acceptsTraffic,
    detail: observation.reportedDetail,
  });

  if (observation.revoked) {
    return verdict("revoked", "machine-revoked", false);
  }
  if (!observation.socketOpen) {
    return verdict("offline", "socket-closed", false);
  }
  if (observation.acceptedAtMs === null) {
    return verdict("connecting", "identity-pending", false);
  }
  if (observation.lastHealthAtMs === null || healthAgeMs === null) {
    return verdict("connecting", "awaiting-first-health", false);
  }
  if (healthAgeMs > relayHealthDeadlineMs(input.window)) {
    return verdict("unhealthy", "health-stale", false);
  }

  switch (observation.reportedState) {
    case "ready":
    case "busy":
      // `busy` is connected on purpose. An environment running a turn is the
      // healthiest thing this system produces, and a UI that greyed it out
      // mid-turn would be telling people their working machine had failed.
      return verdict("connected", "healthy", true);
    case "degraded":
      return verdict("unhealthy", "environment-degraded", false);
    case "starting":
      return verdict("connecting", "environment-starting", false);
    case "stopping":
      return verdict("unhealthy", "environment-stopping", false);
    case null:
      // Answered a ping without saying what it is. Treated as not-yet-known
      // rather than assumed well: an environment that cannot describe itself is
      // not one to route a browser into.
      return verdict("connecting", "awaiting-first-health", false);
  }
}

/**
 * Whether an environment may claim the name it dialled in under.
 *
 * The binding is what makes a relayed environment survive a reboot: the browser
 * has a saved record naming an environment, and the reconnecting machine has to
 * land back on that same name or it appears as a stranger and every saved
 * thread points at nothing.
 *
 * That same durability is what makes the name worth stealing, so the rule is
 * strict in exactly one direction. A name already bound to another *account* is
 * never handed over — not on a tie-break, not by recency, never — because the
 * result would be a browser reaching a machine belonging to somebody else while
 * showing the label it has always shown. Within one account it is permissive:
 * people do move a workspace to a new laptop, re-enrol it, and expect their
 * environment to still be their environment.
 */
export type RelayBindingOutcome =
  /** No prior binding. This machine takes the name. */
  | "bind"
  /** The same machine, back again. The reconnect case, and the common one. */
  | "resume"
  /** A different machine of the same person. The moved-workspace case. */
  | "rebind"
  /** Somebody else's name. Refused. */
  | "reject";

export interface RelayBindingRecord {
  readonly environmentId: string;
  readonly userId: string;
  readonly machineId: string;
}

export interface RelayBindingClaim {
  readonly environmentId: string;
  readonly userId: string;
  readonly machineId: string;
}

export type RelayBindingRejection = "owned-by-another-account" | "environment-id-mismatch";

export type RelayBindingDecision =
  | { readonly outcome: Exclude<RelayBindingOutcome, "reject"> }
  | { readonly outcome: "reject"; readonly reason: RelayBindingRejection };

export function decideRelayBinding(input: {
  readonly existing: RelayBindingRecord | null;
  readonly claim: RelayBindingClaim;
}): RelayBindingDecision {
  const { existing, claim } = input;

  if (existing === null) {
    return { outcome: "bind" };
  }
  // A caller that looked up the wrong row. Refused rather than trusted, because
  // every check below is about *this* environment id and comparing owners
  // across two different ones proves nothing.
  if (existing.environmentId !== claim.environmentId) {
    return { outcome: "reject", reason: "environment-id-mismatch" };
  }
  if (existing.userId !== claim.userId) {
    return { outcome: "reject", reason: "owned-by-another-account" };
  }
  if (existing.machineId === claim.machineId) {
    return { outcome: "resume" };
  }
  return { outcome: "rebind" };
}

/**
 * How long to wait before dialling again.
 *
 * Bounded, deterministic, and a function of the attempt number so the dialer
 * keeps no state the tests cannot see. The shape: half a second, doubling, to a
 * thirty-second ceiling.
 *
 * The ceiling is the point. An environment that cannot reach the hub is
 * usually one of many — the hub is down, or a whole office lost its uplink —
 * and an unbounded-but-growing backoff still has every one of them arriving in
 * the same instant when it comes back. Thirty seconds keeps a laptop that woke
 * up at 3am from finding its workspace a minute later, while capping the worst
 * case at a couple of dials a minute per machine.
 *
 * There is no jitter here because there is nowhere honest to put it in a pure
 * function; `relayDialDelayMs` is the schedule, and the caller spreads it. See
 * `spreadRelayDialDelayMs`.
 */
export const RELAY_DIAL_BASE_DELAY_MS = 500;
export const RELAY_DIAL_MAX_DELAY_MS = 30_000;

export function relayDialDelayMs(
  attempt: number,
  options?: {
    readonly baseMs?: number;
    readonly maxMs?: number;
  },
): number {
  const baseMs = options?.baseMs ?? RELAY_DIAL_BASE_DELAY_MS;
  const maxMs = options?.maxMs ?? RELAY_DIAL_MAX_DELAY_MS;
  // Attempt 0 is the first retry, not the first dial: a dialer waits nothing
  // before its first attempt and asks for a delay only once something failed.
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return Math.min(baseMs, maxMs);
  }
  // Capped before the shift so a large attempt count cannot overflow into a
  // nonsense delay; 2**31 is already far past the ceiling.
  const exponent = Math.min(Math.floor(attempt), 31);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * The same delay, spread over a window so a fleet does not arrive in lockstep.
 *
 * `random` is an argument rather than a call to `Math.random`, which keeps this
 * function pure and its tests exact. Callers pass `Math.random`.
 */
export function spreadRelayDialDelayMs(delayMs: number, random: number): number {
  const bounded = Math.min(Math.max(random, 0), 1);
  // Full jitter would sometimes return ~0 and undo the ceiling's whole purpose
  // during an outage. Half the delay plus up to half again keeps the average
  // where the schedule says it is while still smearing the herd.
  return Math.round(delayMs / 2 + (delayMs / 2) * bounded);
}
