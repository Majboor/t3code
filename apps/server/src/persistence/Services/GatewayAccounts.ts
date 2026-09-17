import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import { UserId } from "@t3tools/contracts";

import type { AuthSessionRepositoryError } from "../Errors.ts";

export const GatewayAccountRecord = Schema.Struct({
  userId: UserId,
  externalId: Schema.String,
  gatewayUserId: Schema.NullOr(Schema.String),
  apiKey: Schema.String,
  status: Schema.Literals(["active", "suspended"]),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type GatewayAccountRecord = typeof GatewayAccountRecord.Type;

export const UpsertGatewayAccountInput = GatewayAccountRecord;
export type UpsertGatewayAccountInput = typeof UpsertGatewayAccountInput.Type;

export const GetGatewayAccountByUserIdInput = Schema.Struct({
  userId: UserId,
});
export type GetGatewayAccountByUserIdInput = typeof GetGatewayAccountByUserIdInput.Type;

export interface GatewayAccountRepositoryShape {
  readonly upsert: (
    input: UpsertGatewayAccountInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getByUserId: (
    input: GetGatewayAccountByUserIdInput,
  ) => Effect.Effect<Option.Option<GatewayAccountRecord>, AuthSessionRepositoryError>;
}

export class GatewayAccountRepository extends Context.Service<
  GatewayAccountRepository,
  GatewayAccountRepositoryShape
>()("t3/persistence/Services/GatewayAccounts/GatewayAccountRepository") {}
