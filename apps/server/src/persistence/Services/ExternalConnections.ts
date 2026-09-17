import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import { UserId } from "@t3tools/contracts";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const ExternalConnectionProvider = Schema.Literals(["github", "cloudflare"]);
export type ExternalConnectionProvider = typeof ExternalConnectionProvider.Type;

export const ExternalConnectionRecord = Schema.Struct({
  userId: UserId,
  provider: ExternalConnectionProvider,
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  accountId: Schema.NullOr(Schema.String),
  accountLabel: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type ExternalConnectionRecord = typeof ExternalConnectionRecord.Type;

export const UpsertExternalConnectionInput = ExternalConnectionRecord;
export type UpsertExternalConnectionInput = typeof UpsertExternalConnectionInput.Type;

export const GetExternalConnectionInput = Schema.Struct({
  userId: UserId,
  provider: ExternalConnectionProvider,
});
export type GetExternalConnectionInput = typeof GetExternalConnectionInput.Type;

export const DeleteExternalConnectionInput = GetExternalConnectionInput;
export type DeleteExternalConnectionInput = typeof DeleteExternalConnectionInput.Type;

export const OAuthStateRecord = Schema.Struct({
  state: Schema.String,
  userId: UserId,
  provider: ExternalConnectionProvider,
  createdAt: Schema.DateTimeUtcFromString,
});
export type OAuthStateRecord = typeof OAuthStateRecord.Type;

export const InsertOAuthStateInput = OAuthStateRecord;
export type InsertOAuthStateInput = typeof InsertOAuthStateInput.Type;

export const ConsumeOAuthStateInput = Schema.Struct({ state: Schema.String });
export type ConsumeOAuthStateInput = typeof ConsumeOAuthStateInput.Type;

export interface ExternalConnectionRepositoryShape {
  readonly upsert: (
    input: UpsertExternalConnectionInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getByUserAndProvider: (
    input: GetExternalConnectionInput,
  ) => Effect.Effect<Option.Option<ExternalConnectionRecord>, AuthSessionRepositoryError>;
  readonly delete: (
    input: DeleteExternalConnectionInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  /** One-time CSRF state for an in-flight OAuth authorize round-trip. */
  readonly insertOAuthState: (
    input: InsertOAuthStateInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  /** Reads and deletes the state row atomically-enough for this use (single read then delete;
   * a race just means a replayed callback fails to find its state, which is the safe failure mode). */
  readonly consumeOAuthState: (
    input: ConsumeOAuthStateInput,
  ) => Effect.Effect<Option.Option<OAuthStateRecord>, AuthSessionRepositoryError>;
}

export class ExternalConnectionRepository extends Context.Service<
  ExternalConnectionRepository,
  ExternalConnectionRepositoryShape
>()("t3/persistence/Services/ExternalConnections/ExternalConnectionRepository") {}
