import type { Pack, PackRequirements, PackScope } from "./packMode.logic";
import { stubPackDirectory } from "./packDirectory.stub";

export interface PackSearchRequest {
  /** What the person is about to ask the agent to build. */
  readonly query: string;
  readonly scope: PackScope;
  /**
   * Sent with the request rather than filtered afterwards: the directory holds
   * the signals, so it is the only side that can rank on them.
   */
  readonly requirements: PackRequirements;
}

export interface PackDirectory {
  searchPacks(request: PackSearchRequest): Promise<readonly Pack[]>;
}

/**
 * The seam. There is no pack RPC yet, so this points at the stub; when the
 * served directory exists, this binding is what changes and nothing above it
 * has to.
 */
export const packDirectory: PackDirectory = stubPackDirectory;
