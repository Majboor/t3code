import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { AccountMachineRepositoryError } from "../Errors.ts";

/**
 * The account's own list of the machines holding a credential for it.
 *
 * Written at `/collect` and read by Settings. See migration 060 for why the
 * link to `auth_sessions` is the load-bearing column: without it a Disconnect
 * button can only delete a row, and the machine keeps working.
 *
 * @module AccountMachines
 */

/**
 * One machine, in primitives only — the same reasoning as
 * `Services/DeviceEnrollments.ts`. Nothing here is a credential: the session id
 * names a row in `auth_sessions`, it is not the token, and holding it grants
 * nothing.
 */
export const AccountMachineRecord = Schema.Struct({
  machineId: Schema.String,
  userId: Schema.String,
  authSessionId: Schema.String,
  label: Schema.NullOr(Schema.String),
  platform: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});
export type AccountMachineRecord = typeof AccountMachineRecord.Type;

/**
 * What `/collect` knows at the moment it hands over a session.
 *
 * `nowIso` is passed in rather than read here so that one request writes one
 * time — a repository that reached for its own clock would let `first_seen_at`
 * and `last_seen_at` disagree on a row created in a single call, and would put
 * a second, hidden clock in front of every test.
 */
export const RegisterAccountMachineInput = Schema.Struct({
  userId: Schema.String,
  authSessionId: Schema.String,
  label: Schema.NullOr(Schema.String),
  platform: Schema.NullOr(Schema.String),
  nowIso: Schema.String,
});
export type RegisterAccountMachineInput = typeof RegisterAccountMachineInput.Type;

export const ListAccountMachinesInput = Schema.Struct({
  userId: Schema.String,
});
export type ListAccountMachinesInput = typeof ListAccountMachinesInput.Type;

/**
 * Reading a machine is always "this machine, of mine".
 *
 * The owner is part of the lookup rather than something the caller checks
 * afterwards, because a forgotten check is a route that answers questions about
 * somebody else's laptop. A machine that exists but belongs to another account
 * comes back as nothing, which is also the answer that discloses least.
 */
export const GetAccountMachineInput = Schema.Struct({
  machineId: Schema.String,
  userId: Schema.String,
});
export type GetAccountMachineInput = typeof GetAccountMachineInput.Type;

export const RevokeAccountMachineInput = Schema.Struct({
  machineId: Schema.String,
  userId: Schema.String,
  revokedAt: Schema.String,
});
export type RevokeAccountMachineInput = typeof RevokeAccountMachineInput.Type;

export const TouchAccountMachineInput = Schema.Struct({
  authSessionId: Schema.String,
  lastSeenAt: Schema.String,
});
export type TouchAccountMachineInput = typeof TouchAccountMachineInput.Type;

export interface AccountMachineRepositoryShape {
  /**
   * Files a machine under an account, against the credential it just took.
   *
   * Creates a row, or revives the one this machine left behind — see the live
   * layer for exactly when reviving is safe. Either way the row that comes back
   * is the one now pointing at `authSessionId`.
   */
  readonly register: (
    input: RegisterAccountMachineInput,
  ) => Effect.Effect<AccountMachineRecord, AccountMachineRepositoryError>;
  /**
   * The machines still holding a credential, most recently seen first.
   *
   * Revoked rows are kept in the table and left out of this answer: the list is
   * "what is connected", and a cut-off machine on it invites a person to press
   * Disconnect a second time and wonder why nothing happened.
   */
  readonly listActiveForUser: (
    input: ListAccountMachinesInput,
  ) => Effect.Effect<ReadonlyArray<AccountMachineRecord>, AccountMachineRepositoryError>;
  readonly getForUser: (
    input: GetAccountMachineInput,
  ) => Effect.Effect<Option.Option<AccountMachineRecord>, AccountMachineRepositoryError>;
  /**
   * Marks a machine cut off. This is bookkeeping — it is not what ends the
   * machine's access, and must never be mistaken for it. The credential dies
   * when its session is revoked; this row records that it happened.
   */
  readonly markRevoked: (
    input: RevokeAccountMachineInput,
  ) => Effect.Effect<Option.Option<AccountMachineRecord>, AccountMachineRepositoryError>;
  /** Moves `last_seen_at` for whichever machine holds this session, if any. */
  readonly touchByAuthSession: (
    input: TouchAccountMachineInput,
  ) => Effect.Effect<void, AccountMachineRepositoryError>;
}

export class AccountMachineRepository extends Context.Service<
  AccountMachineRepository,
  AccountMachineRepositoryShape
>()("t3/persistence/Services/AccountMachines/AccountMachineRepository") {}
