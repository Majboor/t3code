import {
  IsoDateTime,
  PackHandle,
  PackId,
  PackName,
  PackTag,
  PackVersion,
  PackVisibility,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  FindPackEntryInput,
  FindPackVersionInput,
  InsertPackEntryInput,
  InsertPackVersionInput,
  ListPackVersionsInput,
  PackRepository,
  type PackRepositoryShape,
  SearchPackEntriesInput,
  UpdatePackEntryIndexInput,
  UpdatePackEntryVisibilityInput,
} from "../Services/PackRepository.ts";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

const PackEntryRow = Schema.Struct({
  packId: PackId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  name: PackName,
  publisherHandle: PackHandle,
  displayName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  capabilitySummary: TrimmedNonEmptyString,
  tags: Schema.fromJsonString(Schema.Array(PackTag)),
  visibility: Schema.fromJsonString(PackVisibility),
  latestVersion: PackVersion,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const PackVersionRow = Schema.Struct({
  packId: PackId,
  version: PackVersion,
  capabilitySummary: TrimmedNonEmptyString,
  publishedByUserId: UserId,
  publishedAt: IsoDateTime,
});

const PackVersionRecordRow = Schema.Struct({
  ...PackVersionRow.fields,
  manifestJson: Schema.String,
});

/**
 * The id the scope is keyed to, so every scope can be filtered by the same
 * column. Workspace-private packs are matched on the entry's own workspace
 * instead, which is the boundary that cannot be edited from inside a manifest.
 */
function visibilityOwnerId(visibility: typeof PackVisibility.Encoded): string | null {
  switch (visibility.scope) {
    case "workspace":
      return visibility.workspaceId ?? null;
    case "tenant":
      return visibility.tenantId;
    case "organization":
      return visibility.organizationId;
    case "unlisted":
    case "public":
      return null;
  }
}

/**
 * One lowercase haystack per pack, holding the three things an agent searches
 * by — name, tags, what it does — plus the title it would recognise it from.
 */
function toSearchText(input: {
  readonly name: string;
  readonly displayName: string;
  readonly summary: string;
  readonly capabilitySummary: string;
  readonly tags: ReadonlyArray<string>;
}): string {
  return [input.name, input.displayName, input.summary, input.capabilitySummary, ...input.tags]
    .join(" ")
    .toLowerCase();
}

/** A user's search terms are data, not syntax, so LIKE's wildcards are neutered. */
function toLikePattern(query: string | undefined): string {
  const trimmed = query?.trim().toLowerCase() ?? "";
  if (trimmed.length === 0) {
    return "%";
  }
  return `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

const makePackRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEntryRow = SqlSchema.void({
    Request: InsertPackEntryInput,
    execute: (input) =>
      sql`
        INSERT INTO pack_registry_entries (
          pack_id,
          tenant_id,
          workspace_id,
          name,
          publisher_handle,
          display_name,
          summary,
          capability_summary,
          tags_json,
          search_text,
          visibility_scope,
          visibility_owner_id,
          visibility_json,
          latest_version,
          created_at,
          updated_at
        )
        VALUES (
          ${input.packId},
          ${input.tenantId},
          ${input.workspaceId},
          ${input.name},
          ${input.publisherHandle},
          ${input.displayName},
          ${input.summary},
          ${input.capabilitySummary},
          ${JSON.stringify(input.tags)},
          ${toSearchText(input)},
          ${input.visibility.scope},
          ${visibilityOwnerId(input.visibility)},
          ${JSON.stringify(input.visibility)},
          ${input.latestVersion},
          ${input.createdAt},
          ${input.updatedAt}
        )
      `,
  });

  const updateEntryIndexRow = SqlSchema.void({
    Request: UpdatePackEntryIndexInput,
    execute: (input) =>
      sql`
        UPDATE pack_registry_entries
        SET name = ${input.name},
            display_name = ${input.displayName},
            summary = ${input.summary},
            capability_summary = ${input.capabilitySummary},
            tags_json = ${JSON.stringify(input.tags)},
            search_text = ${toSearchText(input)},
            latest_version = ${input.latestVersion},
            updated_at = ${input.updatedAt}
        WHERE pack_id = ${input.packId}
      `,
  });

  const updateEntryVisibilityRow = SqlSchema.void({
    Request: UpdatePackEntryVisibilityInput,
    execute: (input) =>
      sql`
        UPDATE pack_registry_entries
        SET visibility_scope = ${input.visibility.scope},
            visibility_owner_id = ${visibilityOwnerId(input.visibility)},
            visibility_json = ${JSON.stringify(input.visibility)},
            updated_at = ${input.updatedAt}
        WHERE pack_id = ${input.packId}
      `,
  });

  const findEntryRow = SqlSchema.findOneOption({
    Request: FindPackEntryInput,
    Result: PackEntryRow,
    execute: ({ packId }) =>
      sql`SELECT pack_id AS "packId",
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          name,
          publisher_handle AS "publisherHandle",
          display_name AS "displayName",
          summary,
          capability_summary AS "capabilitySummary",
          tags_json AS "tags",
          visibility_json AS "visibility",
          latest_version AS "latestVersion",
          created_at AS "createdAt",
          updated_at AS "updatedAt" FROM pack_registry_entries WHERE pack_id = ${packId}`,
  });

  const searchEntryRows = SqlSchema.findAll({
    Request: SearchPackEntriesInput,
    Result: PackEntryRow,
    execute: (input) =>
      sql`SELECT pack_id AS "packId",
          tenant_id AS "tenantId",
          workspace_id AS "workspaceId",
          name,
          publisher_handle AS "publisherHandle",
          display_name AS "displayName",
          summary,
          capability_summary AS "capabilitySummary",
          tags_json AS "tags",
          visibility_json AS "visibility",
          latest_version AS "latestVersion",
          created_at AS "createdAt",
          updated_at AS "updatedAt" FROM pack_registry_entries
        WHERE (
            visibility_scope = 'public'
            OR (
              visibility_scope = 'workspace'
              AND tenant_id = ${input.tenantId}
              AND workspace_id = ${input.workspaceId}
            )
            OR (visibility_scope = 'tenant' AND tenant_id = ${input.tenantId})
            OR (
              visibility_scope = 'organization'
              AND visibility_owner_id IN (
                SELECT value FROM json_each(${JSON.stringify(input.organizationIds)})
              )
            )
          )
          AND search_text LIKE ${toLikePattern(input.query)} ESCAPE '\\'
        ORDER BY updated_at DESC
        LIMIT ${Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)}`,
  });

  const insertVersionRow = SqlSchema.void({
    Request: InsertPackVersionInput,
    execute: (input) =>
      // No ON CONFLICT clause: a version that already exists must raise rather
      // than quietly take on new contents.
      sql`
        INSERT INTO pack_registry_versions (
          pack_id,
          version,
          manifest_json,
          capability_summary,
          published_by_user_id,
          published_at
        )
        VALUES (
          ${input.packId},
          ${input.version},
          ${input.manifestJson},
          ${input.capabilitySummary},
          ${input.publishedByUserId},
          ${input.publishedAt}
        )
      `,
  });

  const findVersionRow = SqlSchema.findOneOption({
    Request: FindPackVersionInput,
    Result: PackVersionRecordRow,
    execute: ({ packId, version }) =>
      sql`SELECT pack_id AS "packId",
          version,
          manifest_json AS "manifestJson",
          capability_summary AS "capabilitySummary",
          published_by_user_id AS "publishedByUserId",
          published_at AS "publishedAt" FROM pack_registry_versions
        WHERE pack_id = ${packId} AND version = ${version}`,
  });

  const listVersionRows = SqlSchema.findAll({
    Request: ListPackVersionsInput,
    Result: PackVersionRow,
    execute: ({ packId }) =>
      sql`SELECT pack_id AS "packId",
          version,
          capability_summary AS "capabilitySummary",
          published_by_user_id AS "publishedByUserId",
          published_at AS "publishedAt" FROM pack_registry_versions
        WHERE pack_id = ${packId} ORDER BY published_at DESC`,
  });

  const insertEntry: PackRepositoryShape["insertEntry"] = (input) =>
    insertEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.insertEntry:query")),
    );

  const updateEntryIndex: PackRepositoryShape["updateEntryIndex"] = (input) =>
    updateEntryIndexRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.updateEntryIndex:query")),
    );

  const updateEntryVisibility: PackRepositoryShape["updateEntryVisibility"] = (input) =>
    updateEntryVisibilityRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.updateEntryVisibility:query")),
    );

  const findEntry: PackRepositoryShape["findEntry"] = (input) =>
    findEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.findEntry:query")),
    );

  const searchEntries: PackRepositoryShape["searchEntries"] = (input) =>
    searchEntryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.searchEntries:query")),
    );

  const insertVersion: PackRepositoryShape["insertVersion"] = (input) =>
    insertVersionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.insertVersion:query")),
    );

  const findVersion: PackRepositoryShape["findVersion"] = (input) =>
    findVersionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.findVersion:query")),
    );

  const listVersions: PackRepositoryShape["listVersions"] = (input) =>
    listVersionRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("PackRepository.listVersions:query")),
    );

  return {
    insertEntry,
    updateEntryIndex,
    updateEntryVisibility,
    findEntry,
    searchEntries,
    insertVersion,
    findVersion,
    listVersions,
  } satisfies PackRepositoryShape;
});

export const PackRepositoryLive: Layer.Layer<PackRepository, never, SqlClient.SqlClient> =
  Layer.effect(PackRepository, makePackRepository);
