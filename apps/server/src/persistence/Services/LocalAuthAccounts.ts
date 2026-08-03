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
}

export class LocalAuthAccountRepository extends Context.Service<
  LocalAuthAccountRepository,
  LocalAuthAccountRepositoryShape
>()("t3/persistence/Services/LocalAuthAccounts/LocalAuthAccountRepository") {}
