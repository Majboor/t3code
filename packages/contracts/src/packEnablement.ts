/**
 * Which packs a project has turned on.
 *
 * Enabling is deliberately not installation. Nothing is copied, nothing is run,
 * and no requirement is satisfied by the act — it records that this project
 * intends to use this pack at this version, and that record is what lets a
 * surface show the gap between what the pack needs and what the project has.
 *
 * The distinction matters because the alternative is a button that appears to
 * do something and does not. A pack declares environment it cannot provide and
 * commands it cannot run on your behalf; pretending otherwise would produce a
 * project that reads as ready and fails on first use.
 *
 * @module packEnablement
 */
import { Schema } from "effect";

import { IsoDateTime, ProjectId, TenantId, TrimmedNonEmptyString, WorkspaceId } from "./baseSchemas.ts";
import { PackId, PackVersion } from "./pack.ts";

export const PackEnablementId = Schema.String.pipe(Schema.brand("PackEnablementId"));
export type PackEnablementId = typeof PackEnablementId.Type;

/**
 * A value the project supplies for something the pack asked for. Only the name
 * travels: a pack's secret requirement is satisfied by the server secret store,
 * and putting the value here would move every credential into a projection.
 */
export const PackEnablementSetting = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Whether the project has supplied it at all. */
  provided: Schema.Boolean,
  /** Where it lives, for a secret. Never the secret itself. */
  secretName: Schema.optional(TrimmedNonEmptyString),
});
export type PackEnablementSetting = typeof PackEnablementSetting.Type;

export const PackEnablement = Schema.Struct({
  id: PackEnablementId,
  projectId: ProjectId,
  packId: PackId,
  /** Pinned. A pack that changes under a project is a pack that broke it. */
  version: PackVersion,
  packName: TrimmedNonEmptyString,
  packSummary: TrimmedNonEmptyString,
  settings: Schema.Array(PackEnablementSetting),
  enabledAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
});
export type PackEnablement = typeof PackEnablement.Type;

/** The registry is read as somebody, so enabling carries the same scope reading does. */
const ScopeFields = {
  tenantId: TenantId,
  workspaceId: WorkspaceId,
};

export const PackEnableInput = Schema.Struct({
  ...ScopeFields,
  projectId: ProjectId,
  packId: PackId,
  version: Schema.optional(PackVersion),
});
export type PackEnableInput = typeof PackEnableInput.Type;

export const PackEnableResult = Schema.Struct({
  enablement: PackEnablement,
});
export type PackEnableResult = typeof PackEnableResult.Type;

export const PackDisableInput = Schema.Struct({
  ...ScopeFields,
  projectId: ProjectId,
  packId: PackId,
});
export type PackDisableInput = typeof PackDisableInput.Type;

export const PackListEnablementsInput = Schema.Struct({
  ...ScopeFields,
  projectId: ProjectId,
});
export type PackListEnablementsInput = typeof PackListEnablementsInput.Type;

export const PackListEnablementsResult = Schema.Struct({
  enablements: Schema.Array(PackEnablement),
});
export type PackListEnablementsResult = typeof PackListEnablementsResult.Type;

export const PackEnablementErrorCode = Schema.Literals([
  "pack-not-found",
  "already-enabled",
  "not-enabled",
  "storage-failed",
]);
export type PackEnablementErrorCode = typeof PackEnablementErrorCode.Type;

export class PackEnablementError extends Schema.TaggedErrorClass<PackEnablementError>()(
  "PackEnablementError",
  {
    code: PackEnablementErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
