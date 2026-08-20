import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { EnvironmentRelayBindingRepositoryError } from "../Errors.ts";

/**
 * Which account and which machine an outbound environment's name belongs to.
 *
 * See migration 061 for why the name is claimed rather than issued, and why the
 * binding points at a machine instead of at the credential the machine holds.
 * The rules for whether a claim may be honoured are not here — they are in
 * `environmentRelay/decideRelayLink.ts` (`decideRelayBinding`), so that the
 * decision can be stated once and tested without a database.
 *
 * @module EnvironmentRelayBindings
 */

/** Primitives only, like every other repository record in this directory. */
export const EnvironmentRelayBindingRecord = Schema.Struct({
  environmentId: Schema.String,
  userId: Schema.String,
  machineId: Schema.String,
  label: Schema.NullOr(Schema.String),
  firstBoundAt: Schema.String,
  lastConnectedAt: Schema.String,
});
export type EnvironmentRelayBindingRecord = typeof EnvironmentRelayBindingRecord.Type;

/**
 * What the hub knows at the moment an environment finishes dialling in.
 *
 * `nowIso` is an argument for the same reason it is on `AccountMachines`: one
 * connection writes one time, and a repository reaching for its own clock would
 * put a second, hidden one in front of every test.
 */
export const BindEnvironmentRelayInput = Schema.Struct({
  environmentId: Schema.String,
  userId: Schema.String,
  machineId: Schema.String,
  label: Schema.NullOr(Schema.String),
  nowIso: Schema.String,
});
export type BindEnvironmentRelayInput = typeof BindEnvironmentRelayInput.Type;

export const GetEnvironmentRelayBindingInput = Schema.Struct({
  environmentId: Schema.String,
});
export type GetEnvironmentRelayBindingInput = typeof GetEnvironmentRelayBindingInput.Type;

export const ListEnvironmentRelayBindingsInput = Schema.Struct({
  userId: Schema.String,
});
export type ListEnvironmentRelayBindingsInput = typeof ListEnvironmentRelayBindingsInput.Type;

export const ReleaseEnvironmentRelayBindingsInput = Schema.Struct({
  machineId: Schema.String,
});
export type ReleaseEnvironmentRelayBindingsInput = typeof ReleaseEnvironmentRelayBindingsInput.Type;

export interface EnvironmentRelayBindingRepositoryShape {
  /**
   * Records that this machine now answers to this environment id.
   *
   * Writes unconditionally: the caller has already asked `decideRelayBinding`
   * whether the claim is allowed, and putting the ownership rule in two places
   * is how the two copies come to disagree. What this does guarantee is that
   * `first_bound_at` survives a rebind — the environment is the same
   * environment even when the laptop under it is not.
   */
  readonly bind: (
    input: BindEnvironmentRelayInput,
  ) => Effect.Effect<EnvironmentRelayBindingRecord, EnvironmentRelayBindingRepositoryError>;
  /**
   * The current owner of a name, whoever they are.
   *
   * Deliberately not scoped to a user, unlike every other `get` in this
   * directory: the whole question being asked is "does this belong to somebody
   * else", and a lookup that filtered by the asker would answer "no such
   * binding" and let them take it.
   */
  readonly getByEnvironmentId: (
    input: GetEnvironmentRelayBindingInput,
  ) => Effect.Effect<
    Option.Option<EnvironmentRelayBindingRecord>,
    EnvironmentRelayBindingRepositoryError
  >;
  /** My environments, most recently connected first. */
  readonly listForUser: (
    input: ListEnvironmentRelayBindingsInput,
  ) => Effect.Effect<
    ReadonlyArray<EnvironmentRelayBindingRecord>,
    EnvironmentRelayBindingRepositoryError
  >;
  /**
   * Drops every binding a machine held, and answers with what it dropped.
   *
   * Called when a machine is revoked. A delete rather than a flag, because a
   * revoked machine's binding has no readers left and keeping it would let the
   * name block a rebind from the replacement laptop — the person would press
   * Disconnect on a stolen machine and find they could not reconnect the new
   * one under the name all their saved threads point at.
   */
  readonly releaseForMachine: (
    input: ReleaseEnvironmentRelayBindingsInput,
  ) => Effect.Effect<
    ReadonlyArray<EnvironmentRelayBindingRecord>,
    EnvironmentRelayBindingRepositoryError
  >;
}

export class EnvironmentRelayBindingRepository extends Context.Service<
  EnvironmentRelayBindingRepository,
  EnvironmentRelayBindingRepositoryShape
>()("t3/persistence/Services/EnvironmentRelayBindings/EnvironmentRelayBindingRepository") {}
