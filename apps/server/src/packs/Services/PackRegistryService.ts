import type {
  OrganizationId,
  PackError,
  PackId,
  PackManifest,
  PackVersion,
  PackVisibility,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Context, type Effect, type Stream } from "effect";

import type { PackRegistryEntry, PackRegistryVersion } from "./PackRepository.ts";

export interface PackActor {
  readonly userId: UserId;
  readonly displayName: string;
}

export interface PackWorkspaceScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Where a read is being made from. Organizations are supplied rather than
 * looked up, because the caller already knows who it is signed in as and a
 * search an agent runs constantly must not load the tenancy snapshot first.
 */
export interface PackViewerScope extends PackWorkspaceScope {
  readonly organizationIds?: ReadonlyArray<OrganizationId>;
}

export interface PackPublishInput extends PackWorkspaceScope {
  readonly manifest: PackManifest;
}

export interface PackVersionInput extends PackWorkspaceScope {
  readonly packId: PackId;
  readonly manifest: PackManifest;
}

export interface PackSearchInput {
  /** Matched against name, tags and capability summary at once. */
  readonly query?: string;
  readonly limit?: number;
}

export interface PackGetInput {
  readonly packId: PackId;
  /** Omitted means the most recently published version. */
  readonly version?: PackVersion;
}

export interface PackVersionListInput {
  readonly packId: PackId;
}

export interface PackVisibilityInput extends PackWorkspaceScope {
  readonly packId: PackId;
  readonly visibility: PackVisibility;
}

export interface PackPublishResult {
  readonly pack: PackRegistryEntry;
  readonly version: PackRegistryVersion;
}

export interface PackSearchResult {
  readonly packs: ReadonlyArray<PackRegistryEntry>;
}

export interface PackGetResult {
  readonly pack: PackRegistryEntry;
  readonly version: PackRegistryVersion;
  readonly manifest: PackManifest;
}

export interface PackVersionListResult {
  readonly pack: PackRegistryEntry;
  /** Newest first. Pinning one of these is what a rollback is. */
  readonly versions: ReadonlyArray<PackRegistryVersion>;
}

export interface PackVisibilityResult {
  readonly pack: PackRegistryEntry;
}

export type PackRegistryStreamEvent =
  | { readonly type: "pack-published"; readonly pack: PackRegistryEntry }
  | {
      readonly type: "pack-version-recorded";
      readonly pack: PackRegistryEntry;
      readonly version: PackRegistryVersion;
    }
  | { readonly type: "pack-visibility-changed"; readonly pack: PackRegistryEntry };

export interface PackRegistryServiceShape {
  /**
   * Puts a workspace's pack in the registry. Always private to that workspace:
   * cutting a pack and listing it for anyone else are separate decisions, and a
   * manifest that arrives claiming to be public does not get to make the second
   * one on its author's behalf.
   */
  readonly publish: (
    actor: PackActor,
    input: PackPublishInput,
  ) => Effect.Effect<PackPublishResult, PackError>;

  /**
   * Adds a release to a pack that already exists. The versions already
   * published are untouched — a change is always a new version.
   */
  readonly recordVersion: (
    actor: PackActor,
    input: PackVersionInput,
  ) => Effect.Effect<PackPublishResult, PackError>;

  /** Everything the caller may see: their own workspace's packs, plus what is listed. */
  readonly search: (
    viewer: PackViewerScope,
    input: PackSearchInput,
  ) => Effect.Effect<PackSearchResult, PackError>;

  readonly get: (
    viewer: PackViewerScope,
    input: PackGetInput,
  ) => Effect.Effect<PackGetResult, PackError>;

  readonly listVersions: (
    viewer: PackViewerScope,
    input: PackVersionListInput,
  ) => Effect.Effect<PackVersionListResult, PackError>;

  /** The deliberate second act: taking a pack from private to listed, or back. */
  readonly setVisibility: (
    actor: PackActor,
    input: PackVisibilityInput,
  ) => Effect.Effect<PackVisibilityResult, PackError>;

  readonly stream: (viewer: PackViewerScope) => Stream.Stream<PackRegistryStreamEvent, PackError>;
}

export class PackRegistryService extends Context.Service<
  PackRegistryService,
  PackRegistryServiceShape
>()("t3/packs/Services/PackRegistryService") {}
