import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  PromptbarTelemetryRepository,
  type PromptbarTelemetryRepositoryShape,
  RecordPromptbarTelemetryInput,
} from "../Services/PromptbarTelemetry.ts";

const makePromptbarTelemetryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordRow = SqlSchema.void({
    Request: RecordPromptbarTelemetryInput,
    execute: (input) =>
      sql`
        INSERT INTO promptbar_telemetry (id, user_id, event, pack_id, query, created_at)
        VALUES (
          ${input.id}, ${input.userId}, ${input.event}, ${input.packId}, ${input.query}, ${input.createdAt}
        )
      `,
  });

  const record: PromptbarTelemetryRepositoryShape["record"] = (input) =>
    recordRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PromptbarTelemetryRepository.record:query")),
    );

  return { record } satisfies PromptbarTelemetryRepositoryShape;
});

export const PromptbarTelemetryRepositoryLive = Layer.effect(
  PromptbarTelemetryRepository,
  makePromptbarTelemetryRepository,
);
