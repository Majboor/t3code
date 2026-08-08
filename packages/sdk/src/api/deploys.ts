/**
 * Deploy targets and the runs they produce.
 *
 * @module api/deploys
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3DeploysApi {
  readonly listTargets: (
    input: RpcInput<typeof WS_METHODS.deployListTargets>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployListTargets>>;
  readonly createTarget: (
    input: RpcInput<typeof WS_METHODS.deployCreateTarget>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployCreateTarget>>;
  readonly deleteTarget: (input: RpcInput<typeof WS_METHODS.deployDeleteTarget>) => Promise<void>;
  /** Runs a target to completion; the resolved run carries its output. */
  readonly run: (
    input: RpcInput<typeof WS_METHODS.deployRun>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployRun>>;
  readonly listRuns: (
    input: RpcInput<typeof WS_METHODS.deployListRuns>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployListRuns>>;
}

export function makeDeploysApi(transport: T3Transport): T3DeploysApi {
  return {
    listTargets: (input) =>
      transport.request((client) => client[WS_METHODS.deployListTargets](input)),
    createTarget: (input) =>
      transport.request((client) => client[WS_METHODS.deployCreateTarget](input)),
    deleteTarget: (input) =>
      transport.request((client) => client[WS_METHODS.deployDeleteTarget](input)),
    run: (input) => transport.request((client) => client[WS_METHODS.deployRun](input)),
    listRuns: (input) => transport.request((client) => client[WS_METHODS.deployListRuns](input)),
  };
}
