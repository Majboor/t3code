import { Context } from "effect";
import type { Effect } from "effect";

import type {
  EnvironmentId,
  PortCheckResult,
  PortClaimInput,
  PortClaimResult,
  PortReleaseResult,
  PortNumber,
  ServiceId,
  ServiceRegisterInput,
  ServiceRegistryError,
  ServiceRegistryListResult,
  UserId,
} from "@t3tools/contracts";

/**
 * What the environment will say about itself.
 *
 * Every method takes the asking account rather than reading one from anywhere,
 * because two of them are permission decisions in disguise: only the holder may
 * release a reservation, and only the account a service was started for may see
 * itself as its owner. An agent has no account of its own and always arrives
 * carrying the id of whoever asked for the turn.
 */
export interface ServiceRegistryShape {
  /**
   * Everything running here, reconciled from the live machine and our own start
   * records, with expiry applied to both.
   *
   * Deliberately not cached. The answer is a statement about this instant, and a
   * cached one is a claim that ages into a lie — which for this feature means an
   * agent told a port is free binding it into a collision, or told a process is
   * ours killing a stranger's.
   */
  readonly list: (input: {
    readonly environmentId: EnvironmentId;
  }) => Effect.Effect<ServiceRegistryListResult, ServiceRegistryError>;

  readonly checkPort: (input: {
    readonly environmentId: EnvironmentId;
    readonly port: number;
    readonly asking: UserId;
  }) => Effect.Effect<PortCheckResult, ServiceRegistryError>;

  /** Reserve a port. Refused rather than overwritten when somebody else has it. */
  readonly claimPort: (
    input: PortClaimInput & {
      readonly environmentId: EnvironmentId;
      readonly asking: UserId;
    },
  ) => Effect.Effect<PortClaimResult, ServiceRegistryError>;

  readonly releasePort: (input: {
    readonly environmentId: EnvironmentId;
    readonly port: PortNumber;
    readonly asking: UserId;
  }) => Effect.Effect<PortReleaseResult, ServiceRegistryError>;

  /**
   * Write down that we started something.
   *
   * The one call that creates ownership, which is why it takes a pid it cannot
   * derive: the caller has just spawned the process and is the only thing that
   * knows which one it is.
   */
  readonly register: (
    input: ServiceRegisterInput & {
      readonly environmentId: EnvironmentId;
      readonly asking: UserId;
    },
  ) => Effect.Effect<ServiceRegistryListResult, ServiceRegistryError>;

  /**
   * Stop believing in a record. Refused for anything not started here — the
   * refusal is the feature, not an inconvenience.
   */
  readonly release: (input: {
    readonly environmentId: EnvironmentId;
    readonly serviceId: ServiceId;
    readonly asking: UserId;
  }) => Effect.Effect<PortReleaseResult, ServiceRegistryError>;
}

export class ServiceRegistry extends Context.Service<ServiceRegistry, ServiceRegistryShape>()(
  "t3/environment/Services/ServiceRegistry",
) {}
