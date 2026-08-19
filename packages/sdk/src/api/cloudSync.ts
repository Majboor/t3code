/**
 * Replicating a project between a laptop and a cloud copy: choosing the
 * bargain, watching a pass run, and clearing the conflicts it leaves behind.
 *
 * @module api/cloudSync
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3CloudSyncApi {
  /**
   * `sync` comes back null for a project nobody has ever shared, which is the
   * ordinary answer rather than an error — callers render their default state
   * from it instead of catching `not-found`.
   */
  readonly getStatus: (
    input: RpcInput<typeof WS_METHODS.cloudSyncStatusGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncStatusGet>>;
  /**
   * The mode is required and has no default: the two answers differ in which
   * copy becomes canonical. Re-starting a running sync under a different mode
   * fails with `mode-locked`; that change is `stop` then `start`.
   */
  readonly start: (
    input: RpcInput<typeof WS_METHODS.cloudSyncStart>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncStart>>;
  readonly pause: (
    input: RpcInput<typeof WS_METHODS.cloudSyncPause>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncPause>>;
  /** Both copies survive a stop and diverge from that moment; the reply dates it. */
  readonly stop: (
    input: RpcInput<typeof WS_METHODS.cloudSyncStop>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncStop>>;
  /**
   * Keyset paged over `afterId`, not offset: conflicts appear while the list is
   * being read, and an offset would repeat or drop rows exactly then.
   */
  readonly listConflicts: (
    input: RpcInput<typeof WS_METHODS.cloudSyncConflictsList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncConflictsList>>;
  /**
   * Records that a person dealt with it. There is no side to pick — both
   * versions are already on disk, and choosing one here would be a delete.
   */
  readonly resolveConflict: (
    input: RpcInput<typeof WS_METHODS.cloudSyncConflictsResolve>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.cloudSyncConflictsResolve>>;
}

export function makeCloudSyncApi(transport: T3Transport): T3CloudSyncApi {
  return {
    getStatus: (input) =>
      transport.request((client) => client[WS_METHODS.cloudSyncStatusGet](input)),
    start: (input) => transport.request((client) => client[WS_METHODS.cloudSyncStart](input)),
    pause: (input) => transport.request((client) => client[WS_METHODS.cloudSyncPause](input)),
    stop: (input) => transport.request((client) => client[WS_METHODS.cloudSyncStop](input)),
    listConflicts: (input) =>
      transport.request((client) => client[WS_METHODS.cloudSyncConflictsList](input)),
    resolveConflict: (input) =>
      transport.request((client) => client[WS_METHODS.cloudSyncConflictsResolve](input)),
  };
}
