import type {
  PackManifest,
  PackReleaseHistory,
  PackVisibility,
  PackVisibilityScope,
} from "@t3tools/contracts";

import { stubPackDetailSource } from "./packDetailSource.stub";

export interface PackDetail {
  readonly manifest: PackManifest;
  /**
   * The other releases, and when each became visible to whom. It arrives beside
   * the manifest rather than inside it because both halves of it change after
   * the bytes are frozen: a manifest cannot know about a release cut after it,
   * and a publish time written into a signed artifact would be either wrong or
   * unsigned.
   */
  readonly history: PackReleaseHistory;
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
 * has to. The payload is the manifest itself plus the registry's own release
 * history, so the real call has nothing left to reshape.
 */
export const packDetailSource: PackDetailSource = stubPackDetailSource;
