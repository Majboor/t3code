import type { EnvironmentService, PortClaim, ServiceRegistryListResult } from "@t3tools/contracts";
import { livePortClaims } from "@t3tools/shared/serviceRegistry";

/**
 * Turning the machine's answer into something a person can act on.
 *
 * The one rule the page inherits from the registry: what T3 started and what was
 * already here are drawn apart, never in one list sorted by port. A single table
 * makes them look like one kind of thing, and the kind of thing they look like
 * is "rows this app is responsible for" — which is exactly the belief that gets
 * somebody's database stopped.
 *
 * Expiry is applied again here rather than trusted from the response. A page
 * left open for an hour would otherwise draw an hour-old reservation as though
 * it still held a port.
 */

export interface EnvironmentServiceGroups {
  /** Started by T3, and the only rows offering anything to press. */
  readonly ours: ReadonlyArray<EnvironmentService>;
  /** Observed on the machine. Nothing here is ours to stop. */
  readonly others: ReadonlyArray<EnvironmentService>;
}

export function groupServices(
  services: ReadonlyArray<EnvironmentService>,
): EnvironmentServiceGroups {
  return {
    ours: services.filter((service) => service.ownership === "ours"),
    // `unknown` sits with the strangers deliberately. It is not a weaker "ours",
    // and putting it under the heading that offers a stop button would make it
    // one.
    others: services.filter((service) => service.ownership !== "ours"),
  };
}

/**
 * The reservations still standing at the moment of the render.
 *
 * Filtered with the shared rule rather than reimplementing the comparison, but
 * item by item so the branded ids survive: the shared rules are branding-free on
 * purpose, and mapping through them would strip a `UserId` back to a string.
 */
export function liveClaims(
  claims: ReadonlyArray<PortClaim>,
  nowMs: number,
): ReadonlyArray<PortClaim> {
  return claims.filter((claim) => livePortClaims([claim], nowMs).length > 0);
}

/**
 * How long something has been up.
 *
 * Returns null rather than a placeholder when the start is unknown, which is
 * every observed process: we did not watch it start, and the machine's uptime is
 * not its uptime. A "0 minutes" or an em dash both read as a measurement.
 */
export function describeSince(since: string | null, nowMs: number): string | null {
  if (since === null) return null;
  const startedAt = Date.parse(since);
  if (Number.isNaN(startedAt)) return null;

  const elapsed = Math.max(0, nowMs - startedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Who can reach it.
 *
 * Worth a line of its own because it is the difference between a dev server and
 * something the internet can see, and the address alone does not say so to
 * anybody who has not memorised what `0.0.0.0` means.
 */
export function describeExposure(address: string | null): string | null {
  if (address === null) return null;
  if (address === "0.0.0.0" || address === "::" || address === "*") {
    return "reachable from the network";
  }
  if (address.startsWith("127.") || address === "::1" || address === "localhost") {
    return "this machine only";
  }
  return address;
}

/** The one-line state, in words rather than a status token. */
export function describeState(service: EnvironmentService): string {
  switch (service.state) {
    case "listening":
      return `listening on ${service.port}`;
    case "not-listening":
      return `nothing listening on ${service.port} yet`;
    case "displaced":
      return `started for ${service.port}, but another process holds it`;
  }
}

/**
 * What the page says above the list about how it was gathered.
 *
 * A screenful of "unknown" from a machine with only `netstat` is a correct
 * answer that reads as a broken feature, so the reason for it is stated where it
 * is read rather than left to be inferred from every row.
 */
export function describeProbe(probe: ServiceRegistryListResult["probe"]): string {
  if (probe.tool === "none") {
    return probe.limitation.length > 0
      ? probe.limitation
      : "Nothing here could inspect this machine, so nothing was observed. This is not a claim that it is idle.";
  }
  const base = `Read with ${probe.tool}.`;
  return probe.limitation.length > 0 ? `${base} ${probe.limitation}` : base;
}

/** The badge word for a row. Short on purpose; `ownershipReason` carries the detail. */
export function describeOwnership(service: EnvironmentService): string {
  switch (service.ownership) {
    case "ours":
      return "started by T3";
    case "not-ours":
      return "not started by T3";
    case "unknown":
      return "owner unknown";
  }
}
