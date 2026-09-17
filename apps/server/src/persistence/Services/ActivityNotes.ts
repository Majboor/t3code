import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export const NoteTargetType = Schema.Literals(["user", "prompt"]);
export type NoteTargetType = typeof NoteTargetType.Type;

export const NoteStatus = Schema.Literals(["open", "resolved"]);
export type NoteStatus = typeof NoteStatus.Type;

export const NoteVisibility = Schema.Literals(["direct", "public"]);
export type NoteVisibility = typeof NoteVisibility.Type;

export const ActivityNoteRecord = Schema.Struct({
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
export type ActivityNoteRecord = typeof ActivityNoteRecord.Type;

export const CreateActivityNoteInput = Schema.Struct({
  id: Schema.String,
  authorId: Schema.String,
  targetType: NoteTargetType,
  targetId: Schema.String,
  parentNoteId: Schema.NullOr(Schema.String),
  body: Schema.String,
  visibility: NoteVisibility,
  createdAt: Schema.DateTimeUtcFromString,
});
export type CreateActivityNoteInput = typeof CreateActivityNoteInput.Type;

export const ListActivityNotesForTargetInput = Schema.Struct({
  targetType: NoteTargetType,
  targetId: Schema.String,
});
export type ListActivityNotesForTargetInput = typeof ListActivityNotesForTargetInput.Type;

/** Every DM either side of a conversation has sent, in either direction. */
export const ListDirectMessagesBetweenInput = Schema.Struct({
  userIdA: Schema.String,
  userIdB: Schema.String,
});
export type ListDirectMessagesBetweenInput = typeof ListDirectMessagesBetweenInput.Type;

export const ResolveActivityNoteInput = Schema.Struct({
  id: Schema.String,
  resolvedByUserId: Schema.String,
  resolvedAt: Schema.DateTimeUtcFromString,
});
export type ResolveActivityNoteInput = typeof ResolveActivityNoteInput.Type;

export const GetActivityNoteByIdInput = Schema.Struct({
  id: Schema.String,
});
export type GetActivityNoteByIdInput = typeof GetActivityNoteByIdInput.Type;

export interface ActivityNoteRepositoryShape {
  readonly create: (
    input: CreateActivityNoteInput,
  ) => Effect.Effect<ActivityNoteRecord, PersistenceSqlError>;
  readonly getById: (
    input: GetActivityNoteByIdInput,
  ) => Effect.Effect<Option.Option<ActivityNoteRecord>, PersistenceSqlError>;
  /** Every note whose `targetType`/`targetId` matches, oldest first, replies included (unthreaded — the caller nests by `parentNoteId`). */
  readonly listForTarget: (
    input: ListActivityNotesForTargetInput,
  ) => Effect.Effect<ReadonlyArray<ActivityNoteRecord>, PersistenceSqlError>;
  /** Both directions of a `targetType: "user"` conversation between two people. */
  readonly listDirectMessagesBetween: (
    input: ListDirectMessagesBetweenInput,
  ) => Effect.Effect<ReadonlyArray<ActivityNoteRecord>, PersistenceSqlError>;
  /** `none` if no such note. Idempotent: resolving an already-resolved note just returns its existing resolution unchanged. */
  readonly resolve: (
    input: ResolveActivityNoteInput,
  ) => Effect.Effect<Option.Option<ActivityNoteRecord>, PersistenceSqlError>;
}

export class ActivityNoteRepository extends Context.Service<
  ActivityNoteRepository,
  ActivityNoteRepositoryShape
>()("t3/persistence/Services/ActivityNotes/ActivityNoteRepository") {}

// A shared prompt is the durable "post" a public prompt-note thread attaches
// to — independent of `CollaborationService`'s in-memory, ephemeral activity
// feed (`recordSharedPrompt`), which has no stable id a note could reference.
export const SharedPromptRecord = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  sharedByUserId: Schema.String,
  promptText: Schema.String,
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceTurnId: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});
export type SharedPromptRecord = typeof SharedPromptRecord.Type;

export const CreateSharedPromptInput = SharedPromptRecord;
export type CreateSharedPromptInput = typeof CreateSharedPromptInput.Type;

export const ListSharedPromptsForWorkspaceInput = Schema.Struct({
  tenantId: Schema.String,
  workspaceId: Schema.String,
});
export type ListSharedPromptsForWorkspaceInput = typeof ListSharedPromptsForWorkspaceInput.Type;

export const GetSharedPromptByIdInput = Schema.Struct({
  id: Schema.String,
});
export type GetSharedPromptByIdInput = typeof GetSharedPromptByIdInput.Type;

export interface SharedPromptRepositoryShape {
  readonly create: (
    input: CreateSharedPromptInput,
  ) => Effect.Effect<SharedPromptRecord, PersistenceSqlError>;
  readonly getById: (
    input: GetSharedPromptByIdInput,
  ) => Effect.Effect<Option.Option<SharedPromptRecord>, PersistenceSqlError>;
  readonly listForWorkspace: (
    input: ListSharedPromptsForWorkspaceInput,
  ) => Effect.Effect<ReadonlyArray<SharedPromptRecord>, PersistenceSqlError>;
}

export class SharedPromptRepository extends Context.Service<
  SharedPromptRepository,
  SharedPromptRepositoryShape
>()("t3/persistence/Services/ActivityNotes/SharedPromptRepository") {}
