import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  type CloudSyncConflictRecord,
  type CloudSyncFileRecord,
  CloudSyncRepository,
  type CloudSyncRepositoryShape,
  DeleteCloudSyncBaseFileInput,
  GetProjectCloudSyncInput,
  ListCloudSyncBaseFilesInput,
  ListCloudSyncConflictsInput,
  ListProjectCloudSyncsForWorkspaceInput,
  type ProjectCloudSyncRecord,
  RecordCloudSyncConflictInput,
  RegisterCloudSyncLiveCopyInput,
  ResolveCloudSyncConflictInput,
  UpdateCloudSyncProgressInput,
  UpsertProjectCloudSyncInput,
} from "../Services/CloudSync.ts";

const ProjectCloudSyncRow = Schema.Struct({
  projectId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  mode: Schema.String,
  status: Schema.String,
  lastAgreedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  filesTotal: Schema.Int,
  filesDone: Schema.Int,
  bytesTotal: Schema.Int,
  bytesDone: Schema.Int,
  /** SQLite has no boolean; 0 or 1, mapped at the edge by `toProjectSync`. */
  activelyChanging: Schema.Int,
  conflictCount: Schema.Int,
  liveCopyUrl: Schema.NullOr(Schema.String),
  laptopConfirmedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const CloudSyncFileRow = Schema.Struct({
  projectId: Schema.String,
  path: Schema.String,
  hash: Schema.String,
  sizeBytes: Schema.Int,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});

const CloudSyncConflictRow = Schema.Struct({
  conflictId: Schema.String,
  projectId: Schema.String,
  path: Schema.String,
  conflictedCopyPath: Schema.String,
  detectedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});

const syncColumns = `project_id AS "projectId",
  tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  mode,
  status,
  last_agreed_at AS "lastAgreedAt",
  last_error AS "lastError",
  files_total AS "filesTotal",
  files_done AS "filesDone",
  bytes_total AS "bytesTotal",
  bytes_done AS "bytesDone",
  actively_changing AS "activelyChanging",
  conflict_count AS "conflictCount",
  live_copy_url AS "liveCopyUrl",
  laptop_confirmed_at AS "laptopConfirmedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const fileColumns = `project_id AS "projectId",
  path,
  hash,
  size_bytes AS "sizeBytes",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt"`;

const conflictColumns = `conflict_id AS "conflictId",
  project_id AS "projectId",
  path,
  conflicted_copy_path AS "conflictedCopyPath",
  detected_at AS "detectedAt",
  resolved_at AS "resolvedAt"`;

/**
 * How many base revisions go into one INSERT.
 *
 * SQLite binds parameters per statement, and its limit is 999 on builds before
 * 3.32 and 32766 after. The server runs on whichever of bun:sqlite or
 * node:sqlite is present, so the floor is the number to design against: six
 * columns times 150 rows is 900 parameters, comfortably under the old limit and
 * still cutting twenty thousand statements down to about a hundred and forty.
 * Raising this to chase the newer limit would trade a large win already banked
 * for a small one that breaks on an older build, and it would break at exactly
 * the size where it hurts most.
 */
const BASE_FILE_INSERT_CHUNK_ROWS = 150;

const makeCloudSyncRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectSyncRow = SqlSchema.findOne({
    Request: UpsertProjectCloudSyncInput,
    Result: ProjectCloudSyncRow,
    // This call is "a pass begins", and the reset below is what makes the
    // per-pass counters mean what the schema says they mean. Everything that
    // outlives a pass is deliberately absent from the DO UPDATE list:
    // created_at, so a restart does not make a long-shared project look new;
    // last_agreed_at, because a restart is not a disagreement and the answer to
    // "is my work safe" must not be thrown away by pressing the button again;
    // conflict_count, because the files with two copies on disk are still there
    // and still need a person.
    execute: (input) =>
      sql`
        INSERT INTO project_cloud_sync (
          project_id,
          tenant_id,
          workspace_id,
          mode,
          status,
          last_agreed_at,
          last_error,
          files_total,
          files_done,
          bytes_total,
          bytes_done,
          actively_changing,
          conflict_count,
          created_at,
          updated_at
        )
        VALUES (
          ${input.projectId},
          ${input.tenantId},
          ${input.workspaceId},
          ${input.mode},
          ${input.status},
          NULL,
          NULL,
          0,
          0,
          0,
          0,
          0,
          0,
          ${input.createdAt},
          ${input.updatedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          mode = excluded.mode,
          status = excluded.status,
          last_error = NULL,
          files_total = 0,
          files_done = 0,
          bytes_total = 0,
          bytes_done = 0,
          actively_changing = 0,
          -- A live copy belongs to the run that published it. A quick tunnel
          -- gets a new address every time it starts and the old one is dead, so
          -- carrying a registration across a restart would offer visitors an
          -- address from the last session until it aged out. The heartbeat that
          -- follows this call re-registers within seconds if there is anything
          -- to register.
          live_copy_url = NULL,
          laptop_confirmed_at = NULL,
          updated_at = excluded.updated_at
        RETURNING ${sql.literal(syncColumns)}
      `,
  });

  const getProjectSyncRow = SqlSchema.findOneOption({
    Request: GetProjectCloudSyncInput,
    Result: ProjectCloudSyncRow,
    execute: (input) =>
      sql`SELECT ${sql.literal(syncColumns)} FROM project_cloud_sync
          WHERE project_id = ${input.projectId}
            AND tenant_id = ${input.tenantId}
            AND workspace_id = ${input.workspaceId}`,
  });

  /**
   * The unscoped read, used only from inside a transaction that has already
   * located the row by project. Never reachable from the repository surface,
   * so nothing outside can skip the tenant check by calling it.
   */
  const findSyncRowByProject = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: Schema.String }),
    Result: ProjectCloudSyncRow,
    execute: ({ projectId }) =>
      sql`SELECT ${sql.literal(syncColumns)} FROM project_cloud_sync
          WHERE project_id = ${projectId}`,
  });

  const listProjectSyncsForWorkspaceRows = SqlSchema.findAll({
    Request: ListProjectCloudSyncsForWorkspaceInput,
    Result: ProjectCloudSyncRow,
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(syncColumns)} FROM project_cloud_sync
          WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
          ORDER BY project_id ASC`,
  });

  const updateProgressRow = SqlSchema.findOneOption({
    Request: UpdateCloudSyncProgressInput,
    Result: ProjectCloudSyncRow,
    // COALESCE on everything except last_error, which is assigned outright.
    // A caller that is only pausing sends nulls and must not zero a pass it
    // intends to resume; a caller starting a pass sends explicit numbers,
    // including explicit zeroes. last_error is the exception because clearing
    // it has to be possible: a message that survives the failure it describes
    // leaves a sync that is working again showing red forever.
    //
    // last_agreed_at coalesces in the same direction as everything else, and
    // that is the point — a progress tick can advance it and can never erase
    // it, so the one durable fact on this row cannot be lost to a routine
    // write.
    execute: (input) =>
      sql`
        UPDATE project_cloud_sync
        SET status = COALESCE(${input.status}, status),
            files_total = COALESCE(${input.filesTotal}, files_total),
            files_done = COALESCE(${input.filesDone}, files_done),
            bytes_total = COALESCE(${input.bytesTotal}, bytes_total),
            bytes_done = COALESCE(${input.bytesDone}, bytes_done),
            actively_changing = COALESCE(
              ${input.activelyChanging === null ? null : input.activelyChanging ? 1 : 0},
              actively_changing
            ),
            last_agreed_at = COALESCE(${input.lastAgreedAt}, last_agreed_at),
            last_error = ${input.lastError},
            updated_at = ${input.updatedAt}
        WHERE project_id = ${input.projectId}
          AND tenant_id = ${input.tenantId}
          AND workspace_id = ${input.workspaceId}
        RETURNING ${sql.literal(syncColumns)}
      `,
  });

  const registerLiveCopyRow = SqlSchema.findOneOption({
    Request: RegisterCloudSyncLiveCopyInput,
    Result: ProjectCloudSyncRow,
    // No COALESCE on either column, unlike every field in `updateProgress`.
    // Both are assigned outright because both are statements about *now*: the
    // address, which must be erasable the moment its owner stops serving it,
    // and the timestamp, which is the whole point of the call.
    //
    // `updated_at` is deliberately left alone. A heartbeat is not a change to
    // the sync, and moving that column every thirty seconds would make a
    // stalled transfer look like one that is making progress.
    execute: (input) =>
      sql`
        UPDATE project_cloud_sync
        SET live_copy_url = ${input.liveCopyUrl},
            laptop_confirmed_at = ${input.confirmedAt}
        WHERE project_id = ${input.projectId}
          AND tenant_id = ${input.tenantId}
          AND workspace_id = ${input.workspaceId}
        RETURNING ${sql.literal(syncColumns)}
      `,
  });

  const listBaseFilesRows = SqlSchema.findAll({
    Request: ListCloudSyncBaseFilesInput,
    Result: CloudSyncFileRow,
    // Two shapes rather than one query with `(? IS NULL OR path > ?)`. That
    // form reads more neatly and defeats the index: SQLite cannot turn an OR
    // over a parameter into a range scan, so every page of a twenty-thousand
    // file project would become a full table scan — precisely the cost the
    // primary key was ordered to avoid.
    //
    // No tenant or workspace in the WHERE. These rows carry neither: repeating
    // two ids across every path of every project is a great deal of storage to
    // duplicate an answer project_cloud_sync already holds, and the service
    // resolves the project before it gets here.
    execute: ({ projectId, afterPath, limit }) =>
      afterPath === null
        ? sql`SELECT ${sql.literal(fileColumns)} FROM cloud_sync_files
              WHERE project_id = ${projectId}
              ORDER BY path ASC
              LIMIT ${limit}`
        : sql`SELECT ${sql.literal(fileColumns)} FROM cloud_sync_files
              WHERE project_id = ${projectId} AND path > ${afterPath}
              ORDER BY path ASC
              LIMIT ${limit}`,
  });

  const deleteBaseFileRow = SqlSchema.void({
    Request: DeleteCloudSyncBaseFileInput,
    execute: ({ projectId, path }) =>
      sql`DELETE FROM cloud_sync_files
          WHERE project_id = ${projectId} AND path = ${path}`,
  });

  const bumpConflictCountRow = SqlSchema.findOneOption({
    Request: RecordCloudSyncConflictInput,
    Result: ProjectCloudSyncRow,
    // conflict_count + 1 in SQL rather than read-modify-write above it: a pass
    // detecting several conflicts writes them as fast as it finds them, and two
    // read-modify-writes racing would leave the badge understating how many
    // files have a second copy sitting next to them.
    execute: (input) =>
      sql`
        UPDATE project_cloud_sync
        SET conflict_count = conflict_count + 1,
            updated_at = ${input.detectedAt}
        WHERE project_id = ${input.projectId}
        RETURNING ${sql.literal(syncColumns)}
      `,
  });

  const insertConflictRow = SqlSchema.findOne({
    Request: RecordCloudSyncConflictInput,
    Result: CloudSyncConflictRow,
    // No ON CONFLICT. The unique index on (project_id, conflicted_copy_path)
    // is meant to be unreachable, and a collision on it means two conflicts
    // were told to keep their rescued copy at the same path — one of them
    // having overwritten the other's file. Upserting past that would record a
    // clean sync over a loss, so the INSERT is left to fail and be seen.
    execute: (input) =>
      sql`
        INSERT INTO cloud_sync_conflicts (
          conflict_id,
          project_id,
          path,
          conflicted_copy_path,
          detected_at,
          resolved_at
        )
        VALUES (
          ${input.conflictId},
          ${input.projectId},
          ${input.path},
          ${input.conflictedCopyPath},
          ${input.detectedAt},
          NULL
        )
        RETURNING ${sql.literal(conflictColumns)}
      `,
  });

  const listConflictsRows = SqlSchema.findAll({
    Request: ListCloudSyncConflictsInput,
    Result: CloudSyncConflictRow,
    // The cursor is a conflict id but the order is chronological, so the
    // keyset compares the whole sort key as a row value against the cursor
    // row's. Comparing ids alone would silently skip or repeat rows whenever
    // two conflicts were detected out of id order, which is most of the time —
    // ids come from a generator, detection times come from a tree walk.
    execute: ({ projectId, includeResolved, afterId, limit }) => {
      const clauses = [sql`project_id = ${projectId}`];
      if (!includeResolved) {
        clauses.push(sql`resolved_at IS NULL`);
      }
      if (afterId !== null) {
        clauses.push(
          sql`(detected_at, conflict_id) > (
                SELECT detected_at, conflict_id FROM cloud_sync_conflicts
                WHERE conflict_id = ${afterId}
              )`,
        );
      }
      return sql`SELECT ${sql.literal(conflictColumns)} FROM cloud_sync_conflicts
                 WHERE ${sql.and(clauses)}
                 ORDER BY detected_at ASC, conflict_id ASC
                 LIMIT ${limit}`;
    },
  });

  const resolveConflictRow = SqlSchema.findOneOption({
    Request: ResolveCloudSyncConflictInput,
    Result: CloudSyncConflictRow,
    // Guarded on resolved_at IS NULL so this UPDATE touches an open conflict
    // and nothing else. That guard is what stops a double click decrementing
    // the open count twice and hiding a conflict nobody has looked at.
    execute: (input) =>
      sql`
        UPDATE cloud_sync_conflicts
        SET resolved_at = ${input.resolvedAt}
        WHERE conflict_id = ${input.conflictId}
          AND project_id = ${input.projectId}
          AND resolved_at IS NULL
        RETURNING ${sql.literal(conflictColumns)}
      `,
  });

  const findConflictRow = SqlSchema.findOneOption({
    Request: ResolveCloudSyncConflictInput,
    Result: CloudSyncConflictRow,
    execute: (input) =>
      sql`SELECT ${sql.literal(conflictColumns)} FROM cloud_sync_conflicts
          WHERE conflict_id = ${input.conflictId}
            AND project_id = ${input.projectId}`,
  });

  const decrementConflictCountRow = SqlSchema.findOneOption({
    Request: ResolveCloudSyncConflictInput,
    Result: ProjectCloudSyncRow,
    // MAX(..., 0) so the badge can never go negative. It should be impossible —
    // the guarded UPDATE above means one decrement per conflict — but a count
    // that has drifted should read as "none waiting" rather than as a number no
    // UI knows how to draw.
    execute: (input) =>
      sql`
        UPDATE project_cloud_sync
        SET conflict_count = MAX(conflict_count - 1, 0),
            updated_at = ${input.resolvedAt}
        WHERE project_id = ${input.projectId}
        RETURNING ${sql.literal(syncColumns)}
      `,
  });

  const upsertProjectSync: CloudSyncRepositoryShape["upsertProjectSync"] = (input) =>
    upsertProjectSyncRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.upsertProjectSync:query")),
      Effect.map(toProjectSync),
    );

  const getProjectSync: CloudSyncRepositoryShape["getProjectSync"] = (input) =>
    getProjectSyncRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.getProjectSync:query")),
      Effect.map(Option.map(toProjectSync)),
    );

  const listProjectSyncsForWorkspace: CloudSyncRepositoryShape["listProjectSyncsForWorkspace"] = (
    input,
  ) =>
    listProjectSyncsForWorkspaceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("CloudSyncRepository.listProjectSyncsForWorkspace:query"),
      ),
      Effect.map((rows) => rows.map(toProjectSync)),
    );

  /**
   * One transaction over every chunk, so a pass either advances the agreement
   * or leaves it exactly as it was. A partially written base is worse than no
   * write at all: the next pass would compare half of one agreement against
   * half of another and decide that files nobody had touched had changed on
   * both sides — which is the definition of a conflict, and would manufacture
   * one per file.
   */
  const putBaseFiles: CloudSyncRepositoryShape["putBaseFiles"] = (input) =>
    input.files.length === 0
      ? Effect.succeed(0)
      : sql
          .withTransaction(
            Effect.forEach(chunk(input.files, BASE_FILE_INSERT_CHUNK_ROWS), (batch) => {
              const rows = batch.map((file) => ({
                project_id: input.projectId,
                path: file.path,
                hash: file.hash,
                size_bytes: file.sizeBytes,
                updated_at: file.updatedAt,
                deleted_at: file.deletedAt,
              }));
              // deleted_at is written from the input every time, including back
              // to NULL. A path that was agreed gone and has since come back
              // has to be able to stop being a tombstone, and COALESCE here
              // would make that impossible — the resurrected file would go on
              // reading as deleted and be removed again on the next pass.
              return sql`
                INSERT INTO cloud_sync_files ${sql.insert(rows)}
                ON CONFLICT (project_id, path)
                DO UPDATE SET
                  hash = excluded.hash,
                  size_bytes = excluded.size_bytes,
                  updated_at = excluded.updated_at,
                  deleted_at = excluded.deleted_at
              `;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceSqlError("CloudSyncRepository.putBaseFiles:query")),
            Effect.as(input.files.length),
          );

  const listBaseFiles: CloudSyncRepositoryShape["listBaseFiles"] = (input) =>
    listBaseFilesRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.listBaseFiles:query")),
      Effect.map((rows) => rows.map(toCloudSyncFile)),
    );

  const deleteBaseFile: CloudSyncRepositoryShape["deleteBaseFile"] = (input) =>
    deleteBaseFileRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.deleteBaseFile:query")),
    );

  // One transaction, because the badge and the list are two views of the same
  // collision. A conflict row with no bump understates what is waiting; a bump
  // with no row leaves a count the list can never account for, and a badge
  // nobody can clear because there is nothing to click.
  const recordConflict: CloudSyncRepositoryShape["recordConflict"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const bumped = yield* bumpConflictCountRow(input);
          // No sync, no conflict row. An orphan here would be counted against a
          // project the panel has no way to open.
          if (Option.isNone(bumped)) {
            return Option.none<CloudSyncConflictRecord>();
          }
          const inserted = yield* insertConflictRow(input);
          return Option.some(toCloudSyncConflict(inserted));
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CloudSyncRepository.recordConflict:query")));

  const listConflicts: CloudSyncRepositoryShape["listConflicts"] = (input) =>
    listConflictsRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.listConflicts:query")),
      Effect.map((rows) => rows.map(toCloudSyncConflict)),
    );

  /**
   * Three outcomes told apart without guessing, the same shape `revokeLink`
   * uses: no such conflict, one this call closed, one somebody had already
   * closed. Only the middle case decrements, so the count follows the conflicts
   * and not the clicks.
   */
  const resolveConflict: CloudSyncRepositoryShape["resolveConflict"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const resolved = yield* resolveConflictRow(input);
          if (Option.isSome(resolved)) {
            const sync = yield* decrementConflictCountRow(input);
            return Option.some({
              record: toCloudSyncConflict(resolved.value),
              alreadyResolved: false,
              sync: Option.match(sync, {
                onNone: () => null,
                onSome: toProjectSync,
              }),
            });
          }

          const existing = yield* findConflictRow(input);
          if (Option.isNone(existing)) {
            return Option.none<{
              readonly record: CloudSyncConflictRecord;
              readonly alreadyResolved: boolean;
              readonly sync: ProjectCloudSyncRecord | null;
            }>();
          }

          const sync = yield* findSyncRowByProject({ projectId: input.projectId });
          return Option.some({
            record: toCloudSyncConflict(existing.value),
            alreadyResolved: true,
            sync: Option.match(sync, { onNone: () => null, onSome: toProjectSync }),
          });
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("CloudSyncRepository.resolveConflict:query")));

  const updateProgress: CloudSyncRepositoryShape["updateProgress"] = (input) =>
    updateProgressRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.updateProgress:query")),
      Effect.map(Option.map(toProjectSync)),
    );

  const registerLiveCopy: CloudSyncRepositoryShape["registerLiveCopy"] = (input) =>
    registerLiveCopyRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("CloudSyncRepository.registerLiveCopy:query")),
      Effect.map(Option.map(toProjectSync)),
    );

  return {
    upsertProjectSync,
    getProjectSync,
    listProjectSyncsForWorkspace,
    putBaseFiles,
    listBaseFiles,
    deleteBaseFile,
    recordConflict,
    listConflicts,
    resolveConflict,
    updateProgress,
    registerLiveCopy,
  } satisfies CloudSyncRepositoryShape;
});

function chunk<A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> {
  const chunks: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function toProjectSync(row: typeof ProjectCloudSyncRow.Type): ProjectCloudSyncRecord {
  return {
    projectId: row.projectId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    mode: row.mode,
    status: row.status,
    lastAgreedAt: row.lastAgreedAt,
    lastError: row.lastError,
    filesTotal: row.filesTotal,
    filesDone: row.filesDone,
    bytesTotal: row.bytesTotal,
    bytesDone: row.bytesDone,
    activelyChanging: row.activelyChanging === 1,
    conflictCount: row.conflictCount,
    liveCopyUrl: row.liveCopyUrl,
    laptopConfirmedAt: row.laptopConfirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCloudSyncFile(row: typeof CloudSyncFileRow.Type): CloudSyncFileRecord {
  return {
    projectId: row.projectId,
    path: row.path,
    hash: row.hash,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toCloudSyncConflict(row: typeof CloudSyncConflictRow.Type): CloudSyncConflictRecord {
  return {
    conflictId: row.conflictId,
    projectId: row.projectId,
    path: row.path,
    conflictedCopyPath: row.conflictedCopyPath,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
  };
}

export const CloudSyncRepositoryLive: Layer.Layer<CloudSyncRepository, never, SqlClient.SqlClient> =
  Layer.effect(CloudSyncRepository, makeCloudSyncRepository);
