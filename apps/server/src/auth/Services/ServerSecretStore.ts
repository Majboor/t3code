import { Data, Context } from "effect";
import type { Effect } from "effect";

export class SecretStoreError extends Data.TaggedError("SecretStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  /**
   * The names that are stored, never the values.
   *
   * A deploy target refers to its password by name, so the question "is the
   * secret this target needs actually here" has to be answerable without
   * reading anything back — otherwise the only way to check a target is
   * configured is to run it and see what happens.
   */
  readonly list: () => Effect.Effect<ReadonlyArray<string>, SecretStoreError>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "t3/auth/Services/ServerSecretStore",
) {}
