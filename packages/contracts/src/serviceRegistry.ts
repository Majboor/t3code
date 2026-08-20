/**
 * What is running on an environment, and which of it T3 may touch.
 *
 * Two kinds of row cross this wire and they are deliberately not the same type
 * of fact. A **start record** is something T3 launched: a command, a pid, a
 * port, and the account it was launched for. An **observation** is a socket the
 * machine reported as listening, and says nothing at all about who owns it.
 *
 * `EnvironmentService` is the reconciled view of both, and its `ownership` field
 * is the one every caller must read before acting. `unknown` is a real answer
 * and not a soft `ours`: it means the machine would not name the process behind
 * a port, which happens on any host where only `netstat` is available. The rules
 * that produce it live in `@t3tools/shared/serviceRegistry`, pure and shared, so
 * the browser and the server cannot disagree about whether something is safe to
 * stop.
 *
 * @module serviceRegistry
 */
import { Schema } from "effect";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString, UserId } from "./baseSchemas.ts";

/** A TCP or UDP port. Checked here so a bad number never reaches the registry. */
export const PortNumber = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(65_535),
);
export type PortNumber = typeof PortNumber.Type;

export const ServiceId = TrimmedNonEmptyString.pipe(Schema.brand("ServiceId"));
export type ServiceId = typeof ServiceId.Type;

/**
 * Who started this.
 *
 * `unknown` exists because it is frequently the truth. Treat it as somebody
 * else's: nothing may be stopped, restarted or killed on an `unknown`.
 */
export const ServiceOwnership = Schema.Literals(["ours", "not-ours", "unknown"]);
export type ServiceOwnership = typeof ServiceOwnership.Type;

/**
 * `displaced` is the state a port-keyed registry cannot express: T3 started
 * something for this port and a different process holds it now.
 */
export const ServiceState = Schema.Literals(["listening", "not-listening", "displaced"]);
export type ServiceState = typeof ServiceState.Type;

/** Which tool answered the machine's "what is listening" question. */
export const ListenerProbeTool = Schema.Literals(["lsof", "ss", "netstat", "none"]);
export type ListenerProbeTool = typeof ListenerProbeTool.Type;

export const EnvironmentService = Schema.Struct({
  port: PortNumber,
  /** What we named it, else the process name, else nothing worth printing. */
  name: Schema.NullOr(Schema.String),
  state: ServiceState,
  ownership: ServiceOwnership,
  /** The evidence for `ownership`, in one sentence, so nobody has to infer it. */
  ownershipReason: Schema.String,
  pid: Schema.NullOr(Schema.Int),
  command: Schema.NullOr(Schema.String),
  /** `0.0.0.0` means reachable from off the machine; `127.0.0.1` does not. */
  address: Schema.NullOr(Schema.String),
  /** Only ever set for something T3 watched start. Nothing else has a start we saw. */
  since: Schema.NullOr(IsoDateTime),
  startedBy: Schema.NullOr(Schema.String),
  managedId: Schema.NullOr(ServiceId),
  /** Whether stopping or restarting this is permitted. True only for `ours`. */
  canManage: Schema.Boolean,
});
export type EnvironmentService = typeof EnvironmentService.Type;

export const PortClaim = Schema.Struct({
  port: PortNumber,
  claimedBy: UserId,
  purpose: TrimmedNonEmptyString,
  claimedAt: IsoDateTime,
  /** A claim without a deadline is a leak, so this is never null. */
  expiresAt: IsoDateTime,
});
export type PortClaim = typeof PortClaim.Type;

export const PortAvailability = Schema.Literals([
  "free",
  "in-use",
  "claimed",
  "held",
  "out-of-range",
]);
export type PortAvailability = typeof PortAvailability.Type;

export const PortVerdict = Schema.Struct({
  port: Schema.Int,
  availability: PortAvailability,
  /** The one field a caller should branch on. */
  free: Schema.Boolean,
  headline: Schema.String,
  suggestion: Schema.String,
  service: Schema.NullOr(EnvironmentService),
  claim: Schema.NullOr(PortClaim),
});
export type PortVerdict = typeof PortVerdict.Type;

// ── inputs and results ──────────────────────────────────────────────────────

export const ServiceRegistryListInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
});
export type ServiceRegistryListInput = typeof ServiceRegistryListInput.Type;

export const ServiceRegistryListResult = Schema.Struct({
  services: Schema.Array(EnvironmentService),
  claims: Schema.Array(PortClaim),
  /**
   * How the machine was inspected, and what that inspection could not see.
   *
   * Sent rather than kept server-side because it changes how the whole list
   * should be read: from `netstat`, every row is `unknown` and the list is a
   * statement about ports and not about processes. A reader shown the rows
   * without this would take a screenful of `unknown` for a bug.
   */
  probe: Schema.Struct({
    tool: ListenerProbeTool,
    processAttribution: Schema.Boolean,
    limitation: Schema.String,
  }),
  observedAt: IsoDateTime,
});
export type ServiceRegistryListResult = typeof ServiceRegistryListResult.Type;

export const PortCheckInput = Schema.Struct({
  port: Schema.Int,
});
export type PortCheckInput = typeof PortCheckInput.Type;

export const PortCheckResult = Schema.Struct({
  verdict: PortVerdict,
  /**
   * A port that is actually free, when the asked-for one is not. Null when the
   * search range is exhausted — a suggestion that is not free is worse than
   * none, because the caller will act on it.
   */
  suggestion: Schema.NullOr(PortNumber),
});
export type PortCheckResult = typeof PortCheckResult.Type;

export const PortClaimInput = Schema.Struct({
  port: PortNumber,
  purpose: TrimmedNonEmptyString,
  /** How long the reservation should stand. Defaulted by the service when absent. */
  holdMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000))),
});
export type PortClaimInput = typeof PortClaimInput.Type;

export const PortClaimResult = Schema.Struct({
  /** Null when the port was refused; `verdict` says why. */
  claim: Schema.NullOr(PortClaim),
  verdict: PortVerdict,
});
export type PortClaimResult = typeof PortClaimResult.Type;

export const PortReleaseInput = Schema.Struct({
  port: PortNumber,
});
export type PortReleaseInput = typeof PortReleaseInput.Type;

export const PortReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type PortReleaseResult = typeof PortReleaseResult.Type;

/**
 * Recording something T3 started.
 *
 * `pid` is required and not optional. A start record without one could never be
 * told apart from a port coincidence, and a coincidence that reads as ownership
 * is how an agent ends up killing somebody's database.
 */
export const ServiceRegisterInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  port: PortNumber,
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  command: TrimmedNonEmptyString,
});
export type ServiceRegisterInput = typeof ServiceRegisterInput.Type;

export const ServiceRegisterResult = Schema.Struct({
  service: EnvironmentService,
});
export type ServiceRegisterResult = typeof ServiceRegisterResult.Type;

export const ServiceReleaseInput = Schema.Struct({
  serviceId: ServiceId,
});
export type ServiceReleaseInput = typeof ServiceReleaseInput.Type;

export const ServiceReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type ServiceReleaseResult = typeof ServiceReleaseResult.Type;

export class ServiceRegistryError extends Schema.TaggedErrorClass<ServiceRegistryError>()(
  "ServiceRegistryError",
  {
    code: Schema.Literals([
      "forbidden",
      "invalid-port",
      /** Somebody else holds the reservation, or something is already listening. */
      "port-unavailable",
      "service-not-found",
      /** The record exists but was not started by T3, so it is not ours to touch. */
      "not-ours",
      "execution-failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
