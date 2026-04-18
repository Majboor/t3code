import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_RELATIVE_PATH_MAX_LENGTH = 512;
const ProjectRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROJECT_RELATIVE_PATH_MAX_LENGTH),
);
const ProjectFileEncoding = Schema.Literals(["utf-8", "base64"]);
export type ProjectFileEncoding = typeof ProjectFileEncoding.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectListDirectoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  directoryPath: Schema.optional(ProjectRelativePath),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: ProjectRelativePath,
  kind: ProjectEntryKind,
});
export type ProjectDirectoryEntry = typeof ProjectDirectoryEntry.Type;

export const ProjectListDirectoryResult = Schema.Struct({
  directoryPath: Schema.optional(ProjectRelativePath),
  entries: Schema.Array(ProjectDirectoryEntry),
});
export type ProjectListDirectoryResult = typeof ProjectListDirectoryResult.Type;

export class ProjectListDirectoryError extends Schema.TaggedErrorClass<ProjectListDirectoryError>()(
  "ProjectListDirectoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  contents: Schema.String,
  isBinary: Schema.Boolean,
  tooLarge: Schema.Boolean,
  sizeBytes: NonNegativeInt,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
  contents: Schema.String,
  encoding: Schema.optional(ProjectFileEncoding),
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: ProjectRelativePath,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectCreateEntryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: ProjectRelativePath,
  kind: ProjectEntryKind,
});
export type ProjectCreateEntryInput = typeof ProjectCreateEntryInput.Type;

export const ProjectCreateEntryResult = Schema.Struct({
  relativePath: ProjectRelativePath,
  kind: ProjectEntryKind,
});
export type ProjectCreateEntryResult = typeof ProjectCreateEntryResult.Type;

export class ProjectCreateEntryError extends Schema.TaggedErrorClass<ProjectCreateEntryError>()(
  "ProjectCreateEntryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
