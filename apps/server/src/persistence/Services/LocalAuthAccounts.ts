import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import { UserId } from "@t3tools/contracts";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const LocalAuthAccountRecord = Schema.Struct({
  userId: UserId,
  email: Schema.String,
  passwordHash: Schema.String,
  passwordSalt: Schema.String,
  displayName: Schema.String,
  avatarInitials: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  disabledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type LocalAuthAccountRecord = typeof LocalAuthAccountRecord.Type;

export const UpsertLocalAuthAccountInput = LocalAuthAccountRecord;
export type UpsertLocalAuthAccountInput = typeof UpsertLocalAuthAccountInput.Type;

export const GetLocalAuthAccountByEmailInput = Schema.Struct({
  email: Schema.String,
});
export type GetLocalAuthAccountByEmailInput = typeof GetLocalAuthAccountByEmailInput.Type;

export const GetLocalAuthAccountByUserIdInput = Schema.Struct({
  userId: UserId,
});
export type GetLocalAuthAccountByUserIdInput = typeof GetLocalAuthAccountByUserIdInput.Type;

export interface LocalAuthAccountRepositoryShape {
  readonly upsert: (
    input: UpsertLocalAuthAccountInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getByEmail: (
    input: GetLocalAuthAccountByEmailInput,
  ) => Effect.Effect<Option.Option<LocalAuthAccountRecord>, AuthSessionRepositoryError>;
  readonly getByUserId: (
    input: GetLocalAuthAccountByUserIdInput,
  ) => Effect.Effect<Option.Option<LocalAuthAccountRecord>, AuthSessionRepositoryError>;
  /**
   * How many local password accounts can currently sign in.
   *
   * Exists for one question — "is the person on this session the only person
   * who could be here" — which is why disabled rows are excluded: an account
   * that cannot sign in is not a second occupant. A count rather than a list
   * because no caller needs to know who they are, and reading the whole table
   * to find out would be a password hash loaded per request.
   */
  readonly countEnabled: () => Effect.Effect<number, AuthSessionRepositoryError>;
}

export class LocalAuthAccountRepository extends Context.Service<
  LocalAuthAccountRepository,
  LocalAuthAccountRepositoryShape
>()("t3/persistence/Services/LocalAuthAccounts/LocalAuthAccountRepository") {}
