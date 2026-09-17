import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  InsertPromptbarTestSetRowInput,
  PromptbarTestSetRepository,
  type PromptbarTestSetRepositoryShape,
  PromptbarTestSetRow,
} from "../Services/PromptbarTestSet.ts";

const ListPromptbarTestSetInput = Schema.Struct({});

const makePromptbarTestSetRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: InsertPromptbarTestSetRowInput,
    execute: (input) =>
      sql`
        INSERT INTO promptbar_test_set (
          id,
          phrasing,
          correct_pack_id,
          source,
          created_at
        )
        VALUES (
          ${input.id},
          ${input.phrasing},
          ${input.correctPackId},
          ${input.source},
          ${input.createdAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          phrasing = excluded.phrasing,
          correct_pack_id = excluded.correct_pack_id,
          source = excluded.source
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: ListPromptbarTestSetInput,
    Result: PromptbarTestSetRow,
    execute: () =>
      sql`
        SELECT
          id AS "id",
          phrasing AS "phrasing",
          correct_pack_id AS "correctPackId",
          source AS "source",
          created_at AS "createdAt"
        FROM promptbar_test_set
        ORDER BY created_at ASC
      `,
  });

  const insert: PromptbarTestSetRepositoryShape["insert"] = (input) =>
    insertRow(input).pipe(Effect.mapError(toPersistenceSqlError("PromptbarTestSetRepository.insert:query")));

  const listAll: PromptbarTestSetRepositoryShape["listAll"] = () =>
    listAllRows({}).pipe(
      Effect.mapError(toPersistenceSqlError("PromptbarTestSetRepository.listAll:query")),
    );

  return {
    insert,
    listAll,
  } satisfies PromptbarTestSetRepositoryShape;
});

export const PromptbarTestSetRepositoryLive = Layer.effect(
  PromptbarTestSetRepository,
  makePromptbarTestSetRepository,
);
