import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ActivityNoteRecord,
  ActivityNoteRepository,
  type ActivityNoteRepositoryShape,
  CreateActivityNoteInput,
  CreateSharedPromptInput,
  GetActivityNoteByIdInput,
  GetSharedPromptByIdInput,
  ListActivityNotesForTargetInput,
  ListDirectMessagesBetweenInput,
  ListSharedPromptsForWorkspaceInput,
  NoteStatus,
  NoteTargetType,
  NoteVisibility,
  ResolveActivityNoteInput,
  SharedPromptRecord,
  SharedPromptRepository,
  type SharedPromptRepositoryShape,
} from "../Services/ActivityNotes.ts";

const ActivityNoteRow = Schema.Struct({
  id: Schema.String,
  authorId: Schema.String,
  targetType: NoteTargetType,
  targetId: Schema.String,
  parentNoteId: Schema.NullOr(Schema.String),
  body: Schema.String,
  status: NoteStatus,
  visibility: NoteVisibility,
  createdAt: Schema.DateTimeUtcFromString,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  resolvedByUserId: Schema.NullOr(Schema.String),
});

const NOTE_COLUMNS = `
  id,
  author_id AS "authorId",
  target_type AS "targetType",
  target_id AS "targetId",
  parent_note_id AS "parentNoteId",
  body,
  status,
  visibility,
  created_at AS "createdAt",
  resolved_at AS "resolvedAt",
  resolved_by_user_id AS "resolvedByUserId"
`;

const makeActivityNoteRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertNoteRow = SqlSchema.findOne({
    Request: CreateActivityNoteInput,
    Result: ActivityNoteRow,
    execute: (input) =>
      sql`
        INSERT INTO activity_notes (
          id, author_id, target_type, target_id, parent_note_id, body, status, visibility, created_at
        )
        VALUES (
          ${input.id}, ${input.authorId}, ${input.targetType}, ${input.targetId},
          ${input.parentNoteId}, ${input.body}, 'open', ${input.visibility}, ${input.createdAt}
        )
        RETURNING ${sql.unsafe(NOTE_COLUMNS)}
      `,
  });

  const getNoteRowById = SqlSchema.findOneOption({
    Request: GetActivityNoteByIdInput,
    Result: ActivityNoteRow,
    execute: ({ id }) => sql`SELECT ${sql.unsafe(NOTE_COLUMNS)} FROM activity_notes WHERE id = ${id}`,
  });

  const listNoteRowsForTarget = SqlSchema.findAll({
    Request: ListActivityNotesForTargetInput,
    Result: ActivityNoteRow,
    execute: ({ targetType, targetId }) =>
      sql`
        SELECT ${sql.unsafe(NOTE_COLUMNS)} FROM activity_notes
        WHERE target_type = ${targetType} AND target_id = ${targetId}
        ORDER BY created_at ASC
      `,
  });

  const listDmRowsBetween = SqlSchema.findAll({
    Request: ListDirectMessagesBetweenInput,
    Result: ActivityNoteRow,
    execute: ({ userIdA, userIdB }) =>
      sql`
        SELECT ${sql.unsafe(NOTE_COLUMNS)} FROM activity_notes
        WHERE target_type = 'user'
          AND (
            (author_id = ${userIdA} AND target_id = ${userIdB})
            OR (author_id = ${userIdB} AND target_id = ${userIdA})
          )
        ORDER BY created_at ASC
      `,
  });

  const resolveNoteRow = SqlSchema.findOneOption({
    Request: ResolveActivityNoteInput,
    Result: ActivityNoteRow,
    execute: (input) =>
      sql`
        UPDATE activity_notes
        SET
          status = 'resolved',
          resolved_at = COALESCE(resolved_at, ${input.resolvedAt}),
          resolved_by_user_id = COALESCE(resolved_by_user_id, ${input.resolvedByUserId})
        WHERE id = ${input.id}
        RETURNING ${sql.unsafe(NOTE_COLUMNS)}
      `,
  });

  const create: ActivityNoteRepositoryShape["create"] = (input) =>
    insertNoteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ActivityNoteRepository.create:query")),
    );

  const getById: ActivityNoteRepositoryShape["getById"] = (input) =>
    getNoteRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("ActivityNoteRepository.getById:query")),
    );

  const listForTarget: ActivityNoteRepositoryShape["listForTarget"] = (input) =>
    listNoteRowsForTarget(input).pipe(
      Effect.mapError(toPersistenceSqlError("ActivityNoteRepository.listForTarget:query")),
    );

  const listDirectMessagesBetween: ActivityNoteRepositoryShape["listDirectMessagesBetween"] = (
    input,
  ) =>
    listDmRowsBetween(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ActivityNoteRepository.listDirectMessagesBetween:query"),
      ),
    );

  const resolve: ActivityNoteRepositoryShape["resolve"] = (input) =>
    resolveNoteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ActivityNoteRepository.resolve:query")),
    );

  return {
    create,
    getById,
    listForTarget,
    listDirectMessagesBetween,
    resolve,
  } satisfies ActivityNoteRepositoryShape;
});

export const ActivityNoteRepositoryLive = Layer.effect(
  ActivityNoteRepository,
  makeActivityNoteRepository,
);

const SharedPromptRow = SharedPromptRecord;

const SHARED_PROMPT_COLUMNS = `
  id,
  tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  shared_by_user_id AS "sharedByUserId",
  prompt_text AS "promptText",
  source_thread_id AS "sourceThreadId",
  source_turn_id AS "sourceTurnId",
  created_at AS "createdAt"
`;

const makeSharedPromptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertSharedPromptRow = SqlSchema.findOne({
    Request: CreateSharedPromptInput,
    Result: SharedPromptRow,
    execute: (input) =>
      sql`
        INSERT INTO shared_prompts (
          id, tenant_id, workspace_id, shared_by_user_id, prompt_text, source_thread_id, source_turn_id, created_at
        )
        VALUES (
          ${input.id}, ${input.tenantId}, ${input.workspaceId}, ${input.sharedByUserId},
          ${input.promptText}, ${input.sourceThreadId}, ${input.sourceTurnId}, ${input.createdAt}
        )
        RETURNING ${sql.unsafe(SHARED_PROMPT_COLUMNS)}
      `,
  });

  const getSharedPromptRowById = SqlSchema.findOneOption({
    Request: GetSharedPromptByIdInput,
    Result: SharedPromptRow,
    execute: ({ id }) =>
      sql`SELECT ${sql.unsafe(SHARED_PROMPT_COLUMNS)} FROM shared_prompts WHERE id = ${id}`,
  });

  const listSharedPromptRowsForWorkspace = SqlSchema.findAll({
    Request: ListSharedPromptsForWorkspaceInput,
    Result: SharedPromptRow,
    execute: ({ tenantId, workspaceId }) =>
      sql`
        SELECT ${sql.unsafe(SHARED_PROMPT_COLUMNS)} FROM shared_prompts
        WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
        ORDER BY created_at DESC
      `,
  });

  const create: SharedPromptRepositoryShape["create"] = (input) =>
    insertSharedPromptRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("SharedPromptRepository.create:query")),
    );

  const getById: SharedPromptRepositoryShape["getById"] = (input) =>
    getSharedPromptRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("SharedPromptRepository.getById:query")),
    );

  const listForWorkspace: SharedPromptRepositoryShape["listForWorkspace"] = (input) =>
    listSharedPromptRowsForWorkspace(input).pipe(
      Effect.mapError(toPersistenceSqlError("SharedPromptRepository.listForWorkspace:query")),
    );

  return {
    create,
    getById,
    listForWorkspace,
  } satisfies SharedPromptRepositoryShape;
});

export const SharedPromptRepositoryLive = Layer.effect(
  SharedPromptRepository,
  makeSharedPromptRepository,
);
