import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import {
  EnvironmentId,
  IsoDateTime,
  PortNumber,
  ServiceId,
  TrimmedNonEmptyString,
  UserId,
} from "@t3tools/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

/**
 * A row in this table is something T3 started, and nothing else.
 *
 * Kept as its own schema rather than reusing the reconciled `EnvironmentService`
 * contract on purpose: that type carries an `ownership` and a `canManage`, which
 * are conclusions drawn from comparing a record against the live machine. Storing
 * a conclusion would let it go stale in the database and be read back later as
 * though it were still true.
 */
export const EnvironmentServiceRow = Schema.Struct({
  id: ServiceId,
  environmentId: EnvironmentId,
  name: TrimmedNonEmptyString,
  port: PortNumber,
  pid: Schema.Int,
  command: TrimmedNonEmptyString,
  startedBy: UserId,
  startedAt: IsoDateTime,
  heartbeatAt: IsoDateTime,
  stoppedAt: Schema.NullOr(IsoDateTime),
});
export type EnvironmentServiceRow = typeof EnvironmentServiceRow.Type;

export const EnvironmentPortClaimRow = Schema.Struct({
  environmentId: EnvironmentId,
  port: PortNumber,
  claimedBy: UserId,
  purpose: TrimmedNonEmptyString,
  claimedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type EnvironmentPortClaimRow = typeof EnvironmentPortClaimRow.Type;

export const ListEnvironmentServicesInput = Schema.Struct({
  environmentId: EnvironmentId,
});
export type ListEnvironmentServicesInput = typeof ListEnvironmentServicesInput.Type;

export const GetEnvironmentServiceInput = Schema.Struct({
  serviceId: ServiceId,
});
export type GetEnvironmentServiceInput = typeof GetEnvironmentServiceInput.Type;

export const HeartbeatEnvironmentServicesInput = Schema.Struct({
  ids: Schema.Array(ServiceId),
  heartbeatAt: IsoDateTime,
});
export type HeartbeatEnvironmentServicesInput = typeof HeartbeatEnvironmentServicesInput.Type;

export const StopEnvironmentServiceInput = Schema.Struct({
  serviceId: ServiceId,
  stoppedAt: IsoDateTime,
});
export type StopEnvironmentServiceInput = typeof StopEnvironmentServiceInput.Type;

export const ReleasePortClaimInput = Schema.Struct({
  environmentId: EnvironmentId,
  port: PortNumber,
  /**
   * Only the holder may release. Passed down rather than checked above so the
   * delete cannot be told to forget whose claim it was.
   */
  claimedBy: UserId,
});
export type ReleasePortClaimInput = typeof ReleasePortClaimInput.Type;

export interface EnvironmentServiceRepositoryShape {
  /**
   * Every start record for a machine, live or not. The TTL sweep is the caller's
   * — it needs a `now`, and a repository that invented one would be deciding
   * liveness in the one place it cannot be tested against a clock.
   */
  readonly list: (
    input: ListEnvironmentServicesInput,
  ) => Effect.Effect<ReadonlyArray<EnvironmentServiceRow>, PersistenceSqlError>;

  readonly get: (
    input: GetEnvironmentServiceInput,
  ) => Effect.Effect<Option.Option<EnvironmentServiceRow>, PersistenceSqlError>;

  /**
   * Record a start. Re-registering a live port replaces its record rather than
   * adding a second: a restarted service is the same service with a new pid, and
   * two rows for one port would make the older pid look like a running process
   * forever.
   */
  readonly register: (input: EnvironmentServiceRow) => Effect.Effect<void, PersistenceSqlError>;

  /** Confirms a batch of records still have living processes behind them. */
  readonly heartbeat: (
    input: HeartbeatEnvironmentServicesInput,
  ) => Effect.Effect<void, PersistenceSqlError>;

  readonly stop: (input: StopEnvironmentServiceInput) => Effect.Effect<void, PersistenceSqlError>;

  readonly listClaims: (
    input: ListEnvironmentServicesInput,
  ) => Effect.Effect<ReadonlyArray<EnvironmentPortClaimRow>, PersistenceSqlError>;

  readonly upsertClaim: (
    input: EnvironmentPortClaimRow,
  ) => Effect.Effect<void, PersistenceSqlError>;

  /** Returns whether a claim of that holder's was actually there to release. */
  readonly releaseClaim: (
    input: ReleasePortClaimInput,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
}

export class EnvironmentServiceRepository extends Context.Service<
  EnvironmentServiceRepository,
  EnvironmentServiceRepositoryShape
>()("t3/persistence/Services/EnvironmentServices/EnvironmentServiceRepository") {}
