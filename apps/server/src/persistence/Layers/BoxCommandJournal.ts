import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type BoxCommandJournalRepositoryError,
} from "../Errors.ts";
import {
  BoxCommandEntry,
  BoxCommandJournalRepository,
  type BoxCommandJournalRepositoryShape,
  FinishBoxCommandInput,
  GetBoxCommandInput,
  ListBoxCommandsInput,
  RecordBoxCommandInput,
} from "../Services/BoxCommandJournal.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): BoxCommandJournalRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/** Spelled once, so every read of this table returns the same shape. */
const entryColumns = `
  entry_id AS "entryId",
  environment_id AS "environmentId",
  user_id AS "userId",
  turn_id AS "turnId",
  verb AS "verb",
  command AS "command",
  service_id AS "serviceId",
  outcome AS "outcome",
  refusal_reason AS "refusalReason",
  exit_code AS "exitCode",
  signal AS "signal",
  pid AS "pid",
  unmanaged AS "unmanaged",
  stdout AS "stdout",
  stderr AS "stderr",
  output_bytes AS "outputBytes",
  started_at AS "startedAt",
  finished_at AS "finishedAt"
`;

/**
 * The row as SQLite actually returns it.
 *
 * `unmanaged` is an integer here and a boolean on the record, because SQLite has
 * no boolean type: a 0 arriving at `Schema.Boolean` fails to decode, which would
 * make the audit column the one that breaks every read of the audit table. The
 * conversion is one explicit step in `toEntry` rather than a cast in SQL, so the
 * shape the database holds and the shape callers see are both stated.
 */
const BoxCommandRow = Schema.Struct({
  ...BoxCommandEntry.fields,
  unmanaged: Schema.Int,
});

function toEntry(row: typeof BoxCommandRow.Type): BoxCommandEntry {
  return { ...row, unmanaged: row.unmanaged !== 0 };
}

const makeBoxCommandJournalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEntry = SqlSchema.findOneOption({
    Request: RecordBoxCommandInput,
    Result: BoxCommandRow,
    execute: (input) =>
      sql`
        INSERT INTO box_command_journal (
          entry_id, environment_id, user_id, turn_id, verb, command, service_id,
          outcome, refusal_reason, exit_code, signal, pid, unmanaged,
          stdout, stderr, output_bytes, started_at, finished_at
        )
        VALUES (
          ${input.entryId}, ${input.environmentId}, ${input.userId}, ${input.turnId},
          ${input.verb}, ${input.command}, ${input.serviceId}, ${input.outcome},
          ${input.refusalReason}, ${input.exitCode}, ${input.signal}, ${input.pid},
          ${input.unmanaged ? 1 : 0}, ${input.stdout}, ${input.stderr},
          ${input.outputBytes}, ${input.startedAt}, ${input.finishedAt}
        )
        RETURNING ${sql.literal(entryColumns)}
      `,
  });

  const finishEntry = SqlSchema.findOneOption({
    Request: FinishBoxCommandInput,
    Result: BoxCommandRow,
    execute: (input) =>
      sql`
        UPDATE box_command_journal
        SET outcome = ${input.outcome},
            exit_code = ${input.exitCode},
            signal = ${input.signal},
            stdout = ${input.stdout},
            stderr = ${input.stderr},
            output_bytes = ${input.outputBytes},
            finished_at = ${input.finishedAt}
        WHERE entry_id = ${input.entryId}
          AND environment_id = ${input.environmentId}
          AND finished_at IS NULL
        RETURNING ${sql.literal(entryColumns)}
      `,
  });

  const listRecentRows = SqlSchema.findAll({
    Request: ListBoxCommandsInput,
    Result: BoxCommandRow,
    execute: (input) =>
      sql`
        SELECT ${sql.literal(entryColumns)}
        FROM box_command_journal
        WHERE environment_id = ${input.environmentId}
        ORDER BY started_at DESC, entry_id DESC
        LIMIT ${input.limit}
      `,
  });

  const listUnfinishedRows = SqlSchema.findAll({
    Request: ListBoxCommandsInput,
    Result: BoxCommandRow,
    execute: (input) =>
      sql`
        SELECT ${sql.literal(entryColumns)}
        FROM box_command_journal
        WHERE environment_id = ${input.environmentId}
          AND finished_at IS NULL
          AND pid IS NOT NULL
        ORDER BY started_at DESC, entry_id DESC
        LIMIT ${input.limit}
      `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetBoxCommandInput,
    Result: BoxCommandRow,
    execute: (input) =>
      sql`
        SELECT ${sql.literal(entryColumns)}
        FROM box_command_journal
        WHERE entry_id = ${input.entryId}
          AND user_id = ${input.userId}
      `,
  });

  const record: BoxCommandJournalRepositoryShape["record"] = (input) =>
    insertEntry(input).pipe(
      Effect.flatMap((inserted) =>
        inserted._tag === "Some"
          ? Effect.succeed(toEntry(inserted.value))
          : Effect.fail(new Error("Insert returned no box command journal row.")),
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "BoxCommandJournalRepository.record:query",
          "BoxCommandJournalRepository.record:decodeRow",
        ),
      ),
    );

  const finish: BoxCommandJournalRepositoryShape["finish"] = (input) =>
    finishEntry(input).pipe(
      Effect.map(Option.map(toEntry)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "BoxCommandJournalRepository.finish:query",
          "BoxCommandJournalRepository.finish:decodeRow",
        ),
      ),
    );

  const listRecent: BoxCommandJournalRepositoryShape["listRecent"] = (input) =>
    listRecentRows(input).pipe(
      Effect.map((rows) => rows.map(toEntry)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "BoxCommandJournalRepository.listRecent:query",
          "BoxCommandJournalRepository.listRecent:decodeRows",
        ),
      ),
    );

  const listUnfinished: BoxCommandJournalRepositoryShape["listUnfinished"] = (input) =>
    listUnfinishedRows(input).pipe(
      Effect.map((rows) => rows.map(toEntry)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "BoxCommandJournalRepository.listUnfinished:query",
          "BoxCommandJournalRepository.listUnfinished:decodeRows",
        ),
      ),
    );

  const get: BoxCommandJournalRepositoryShape["get"] = (input) =>
    getRow(input).pipe(
      Effect.map(Option.map(toEntry)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "BoxCommandJournalRepository.get:query",
          "BoxCommandJournalRepository.get:decodeRow",
        ),
      ),
    );

  return {
    record,
    finish,
    listRecent,
    listUnfinished,
    get,
  } satisfies BoxCommandJournalRepositoryShape;
});

export const BoxCommandJournalRepositoryLive: Layer.Layer<
  BoxCommandJournalRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(BoxCommandJournalRepository, makeBoxCommandJournalRepository);
