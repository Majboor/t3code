import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import { PackEnablement, PackId, ProjectId } from "@t3tools/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

export const UpsertPackEnablementInput = PackEnablement;
export type UpsertPackEnablementInput = typeof UpsertPackEnablementInput.Type;

export const ListPackEnablementsInput = Schema.Struct({
  projectId: ProjectId,
  /** Disabled rows are kept so re-enabling remembers what was configured. */
  includeDisabled: Schema.optional(Schema.Boolean),
});
export type ListPackEnablementsInput = typeof ListPackEnablementsInput.Type;

export const FindPackEnablementInput = Schema.Struct({
  projectId: ProjectId,
  packId: PackId,
});
export type FindPackEnablementInput = typeof FindPackEnablementInput.Type;

export interface PackEnablementRepositoryShape {
  readonly upsert: (input: UpsertPackEnablementInput) => Effect.Effect<void, PersistenceSqlError>;
  readonly list: (
    input: ListPackEnablementsInput,
  ) => Effect.Effect<ReadonlyArray<PackEnablement>, PersistenceSqlError>;
  readonly find: (
    input: FindPackEnablementInput,
  ) => Effect.Effect<Option.Option<PackEnablement>, PersistenceSqlError>;
}

export class PackEnablementRepository extends Context.Service<
  PackEnablementRepository,
  PackEnablementRepositoryShape
>()("t3/persistence/Services/PackEnablement/PackEnablementRepository") {}
