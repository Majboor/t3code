import type {
  PackManifest,
  PackReleaseHistory,
  PackVisibility,
  PackVisibilityScope,
} from "@t3tools/contracts";

import { createLivePackDetailSource } from "./packDetailSource.live";
import { stubPackDetailSource } from "./packDetailSource.stub";
import { readPrimaryEnvironmentDescriptor } from "../../environments/primary/context";

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
 * The seam. It now points at the served registry rather than the stub, which is
 * what makes everything on the pack page a statement about a real pack: a
 * signature badge over stub bytes verifies nothing worth knowing.
 *
 * The stub is kept and still exported, because the browser tests render this
 * page without a server behind it.
 */
export const packDetailSource: PackDetailSource = createLivePackDetailSource(
  () => readPrimaryEnvironmentDescriptor()?.environmentId ?? null,
);

export { stubPackDetailSource };
