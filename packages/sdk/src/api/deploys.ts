/**
 * Deploy targets, the runs they produce, and the deployments those runs put
 * live.
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
  /** What a project has live: URL, status, and the streams each reports to. */
  readonly listDeployments: (
    input: RpcInput<typeof WS_METHODS.deployListDeployments>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployListDeployments>>;
  /** Registering the same name twice updates that deployment rather than adding one. */
  readonly registerDeployment: (
    input: RpcInput<typeof WS_METHODS.deployRegisterDeployment>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployRegisterDeployment>>;
  readonly updateDeployment: (
    input: RpcInput<typeof WS_METHODS.deployUpdateDeployment>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.deployUpdateDeployment>>;
  readonly archiveDeployment: (
    input: RpcInput<typeof WS_METHODS.deployArchiveDeployment>,
  ) => Promise<void>;
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
    listDeployments: (input) =>
      transport.request((client) => client[WS_METHODS.deployListDeployments](input)),
    registerDeployment: (input) =>
      transport.request((client) => client[WS_METHODS.deployRegisterDeployment](input)),
    updateDeployment: (input) =>
      transport.request((client) => client[WS_METHODS.deployUpdateDeployment](input)),
    archiveDeployment: (input) =>
      transport.request((client) => client[WS_METHODS.deployArchiveDeployment](input)),
  };
}
