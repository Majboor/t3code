import type { PackManifest, PackVisibility } from "@t3tools/contracts";

import { stubPackDetailSource } from "./packDetailSource.stub";

/** The five boundaries `PackVisibility` can draw, without their ids. */
export type PackVisibilityScope = PackVisibility["scope"];

/**
 * One release in the pack's history. The manifest describes exactly one
 * release, so the list of the others has to arrive alongside it — a version
 * history assembled from a single manifest would only ever have one row.
 */
export interface PackRelease {
  readonly version: string;
  readonly publishedAt: string;
  readonly visibilityScope: PackVisibilityScope;
  /** One line on what changed, in the words of what it now gets right. */
  readonly note: string;
}

export interface PackDetail {
  readonly manifest: PackManifest;
  /** Newest first. */
  readonly releases: readonly PackRelease[];
}

export interface PackDetailRequest {
  readonly packId: string;
  /** Absent means the newest release. */
  readonly version?: string;
}

/**
 * The scope is all the caller sends. Every scope except `unlisted` and `public`
 * needs an id the page has no business inventing, so the source is the side
 * that names the workspace, tenant or organization the pack is being pinned to.
 */
export interface PackVisibilityChangeRequest {
  readonly packId: string;
  readonly scope: PackVisibilityScope;
}

export interface PackDetailSource {
  loadPack(request: PackDetailRequest): Promise<PackDetail | null>;
  setVisibility(request: PackVisibilityChangeRequest): Promise<PackVisibility>;
}

/**
 * The seam. There is no pack RPC yet, so this points at the stub; when the
 * served registry exists, this binding is what changes and nothing above it
 * has to. The payload is the manifest itself rather than a flattened view
 * model, so the real call has nothing left to reshape.
 */
export const packDetailSource: PackDetailSource = stubPackDetailSource;
