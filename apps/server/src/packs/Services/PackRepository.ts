import {
  IsoDateTime,
  OrganizationId,
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
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * A published pack as the registry knows it: the identity it was published
 * under, the workspace it came from, who may see it, and a projection of the
 * most recently published version so a search never has to open a manifest.
 */
export const PackRegistryEntry = Schema.Struct({
  packId: PackId,
  /** The publishing workspace. Also the boundary a workspace-private pack lives in. */
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  name: PackName,
  publisherHandle: PackHandle,
  displayName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  capabilitySummary: TrimmedNonEmptyString,
  tags: Schema.Array(PackTag),
  visibility: PackVisibility,
  /** Newest by publish time rather than by semver, which is what a listing means by latest. */
  latestVersion: PackVersion,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PackRegistryEntry = typeof PackRegistryEntry.Type;

/** One immutable release. Nothing here is ever rewritten. */
export const PackRegistryVersion = Schema.Struct({
  packId: PackId,
  version: PackVersion,
  capabilitySummary: TrimmedNonEmptyString,
  publishedByUserId: UserId,
  publishedAt: IsoDateTime,
});
export type PackRegistryVersion = typeof PackRegistryVersion.Type;

/**
 * A version together with the bytes that were published. The manifest travels
 * as text so the store never has to understand the format it is holding.
 */
export const PackRegistryVersionRecord = Schema.Struct({
  ...PackRegistryVersion.fields,
  manifestJson: Schema.String,
});
export type PackRegistryVersionRecord = typeof PackRegistryVersionRecord.Type;

export const InsertPackEntryInput = PackRegistryEntry;
export type InsertPackEntryInput = typeof InsertPackEntryInput.Type;

/**
 * Only what a newly published version changes about the entry. The name is in
 * here because identity is the id: a pack may be renamed and everything already
 * installed still resolves.
 */
export const UpdatePackEntryIndexInput = Schema.Struct({
  packId: PackId,
  name: PackName,
  displayName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  capabilitySummary: TrimmedNonEmptyString,
  tags: Schema.Array(PackTag),
  latestVersion: PackVersion,
  updatedAt: IsoDateTime,
});
export type UpdatePackEntryIndexInput = typeof UpdatePackEntryIndexInput.Type;

export const UpdatePackEntryVisibilityInput = Schema.Struct({
  packId: PackId,
  visibility: PackVisibility,
  updatedAt: IsoDateTime,
});
export type UpdatePackEntryVisibilityInput = typeof UpdatePackEntryVisibilityInput.Type;

export const FindPackEntryInput = Schema.Struct({
  packId: PackId,
});
export type FindPackEntryInput = typeof FindPackEntryInput.Type;

/**
 * What a caller may see, as the store needs it: the workspace they are asking
 * from, plus the organizations they hold a membership in. Both are resolved by
 * the caller, because a read that has to load the tenancy snapshot first is not
 * cheap enough to run on every keystroke.
 */
export const SearchPackEntriesInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  organizationIds: Schema.Array(OrganizationId),
  /** Matched against name, tags, capability summary and title together. */
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});
export type SearchPackEntriesInput = typeof SearchPackEntriesInput.Type;

export const InsertPackVersionInput = Schema.Struct({
  packId: PackId,
  version: PackVersion,
  manifestJson: Schema.String,
  capabilitySummary: TrimmedNonEmptyString,
  publishedByUserId: UserId,
  publishedAt: IsoDateTime,
});
export type InsertPackVersionInput = typeof InsertPackVersionInput.Type;

export const FindPackVersionInput = Schema.Struct({
  packId: PackId,
  version: PackVersion,
});
export type FindPackVersionInput = typeof FindPackVersionInput.Type;

export const ListPackVersionsInput = Schema.Struct({
  packId: PackId,
});
export type ListPackVersionsInput = typeof ListPackVersionsInput.Type;

/**
 * The store deliberately offers no way to change a version row. Immutability is
 * not a rule the service remembers to follow — there is no statement for it.
 */
export interface PackRepositoryShape {
  readonly insertEntry: (input: InsertPackEntryInput) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateEntryIndex: (
    input: UpdatePackEntryIndexInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly updateEntryVisibility: (
    input: UpdatePackEntryVisibilityInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly findEntry: (
    input: FindPackEntryInput,
  ) => Effect.Effect<Option.Option<PackRegistryEntry>, PersistenceSqlError>;
  readonly searchEntries: (
    input: SearchPackEntriesInput,
  ) => Effect.Effect<ReadonlyArray<PackRegistryEntry>, PersistenceSqlError>;
  readonly insertVersion: (
    input: InsertPackVersionInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly findVersion: (
    input: FindPackVersionInput,
  ) => Effect.Effect<Option.Option<PackRegistryVersionRecord>, PersistenceSqlError>;
  readonly listVersions: (
    input: ListPackVersionsInput,
  ) => Effect.Effect<ReadonlyArray<PackRegistryVersion>, PersistenceSqlError>;
}

export class PackRepository extends Context.Service<PackRepository, PackRepositoryShape>()(
  "t3/packs/Services/PackRepository",
) {}
