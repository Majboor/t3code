/**
 * PromptbarTestSetRepository - the eval harness's (phrasing -> correct pack)
 * test set, persisted in `promptbar_test_set` (migration 071).
 *
 * This is intentionally a separate corpus from the phrasings indexed by
 * retrieval (`packs/*\/promptbar.json`) -- see that migration's doc comment
 * for why scoring against the indexed phrasings would be training on the
 * test set.
 *
 * @module PromptbarTestSet
 */
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export const PromptbarTestSetSource = Schema.Literals(["manual", "sampled_from_usage"]);
export type PromptbarTestSetSource = typeof PromptbarTestSetSource.Type;

export const PromptbarTestSetRow = Schema.Struct({
  id: Schema.String,
  phrasing: Schema.String,
  /** null means: the correct outcome for this phrasing is abstention. */
  correctPackId: Schema.NullOr(Schema.String),
  source: PromptbarTestSetSource,
  createdAt: Schema.DateTimeUtcFromString,
});
export type PromptbarTestSetRow = typeof PromptbarTestSetRow.Type;

export const InsertPromptbarTestSetRowInput = PromptbarTestSetRow;
export type InsertPromptbarTestSetRowInput = typeof InsertPromptbarTestSetRowInput.Type;

export type PromptbarTestSetRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface PromptbarTestSetRepositoryShape {
  readonly insert: (
    input: InsertPromptbarTestSetRowInput,
  ) => Effect.Effect<void, PromptbarTestSetRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<PromptbarTestSetRow>,
    PromptbarTestSetRepositoryError
  >;
}

export class PromptbarTestSetRepository extends Context.Service<
  PromptbarTestSetRepository,
  PromptbarTestSetRepositoryShape
>()("t3/promptbar/Services/PromptbarTestSetRepository") {}
