/**
 * WorkspaceEntries - Effect service contract for cached workspace entry search.
 *
 * Owns indexed workspace entry search plus cache invalidation for workspace
 * roots when the underlying filesystem changes.
 *
 * @module WorkspaceEntries
 */
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

export class WorkspaceEntriesError extends Schema.TaggedErrorClass<WorkspaceEntriesError>()(
  "WorkspaceEntriesError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class WorkspaceEntriesBrowseError extends Schema.TaggedErrorClass<WorkspaceEntriesBrowseError>()(
  "WorkspaceEntriesBrowseError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WorkspaceEntriesShape - Service API for workspace entry search and cache
 * invalidation.
 */
export interface WorkspaceEntriesShape {
  /**
   * Browse matching directories for the provided partial path.
   */
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;

  /**
   * Resolves the absolute directory `browse` would actually read, without
   * reading it — so a caller can run a tenant-access check against the real
   * target even when the request has no `cwd` (a `partialPath` like `~/`
   * needs none to resolve, which is exactly the gap a permission check keyed
   * only on `cwd` being present used to miss).
   */
  readonly resolveBrowseTarget: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<string, WorkspaceEntriesBrowseError>;

  /**
   * Read the direct children of a workspace directory.
   */
  readonly listDirectory: (
    input: ProjectListDirectoryInput,
  ) => Effect.Effect<ProjectListDirectoryResult, WorkspaceEntriesError>;

  /**
   * Search indexed workspace entries for files and directories matching the
   * provided query.
   */
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;

  /**
   * Drop any cached workspace entries for the given workspace root.
   */
  readonly invalidate: (cwd: string) => Effect.Effect<void>;
}

/**
 * WorkspaceEntries - Service tag for cached workspace entry search.
 */
export class WorkspaceEntries extends Context.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "t3/workspace/Services/WorkspaceEntries",
) {}
