/**
 * Asking a workspace for provider usage, and answering: the other half of
 * `api/providerSharing.ts`, which only lets someone who already has a
 * credential offer it.
 *
 * @module api/providerUsage
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3ProviderUsageApi {
  /** The session is the requester; the input never names one. */
  readonly createRequest: (
    input: RpcInput<typeof WS_METHODS.providerUsageRequestCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerUsageRequestCreate>>;
  /** The caller's own requests, plus the pending ones they may answer. */
  readonly listRequests: (
    input: RpcInput<typeof WS_METHODS.providerUsageRequestList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerUsageRequestList>>;
  readonly respondToRequest: (
    input: RpcInput<typeof WS_METHODS.providerUsageRequestRespond>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerUsageRequestRespond>>;
  readonly withdrawRequest: (
    input: RpcInput<typeof WS_METHODS.providerUsageRequestWithdraw>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerUsageRequestWithdraw>>;
}

export function makeProviderUsageApi(transport: T3Transport): T3ProviderUsageApi {
  return {
    createRequest: (input) =>
      transport.request((client) => client[WS_METHODS.providerUsageRequestCreate](input)),
    listRequests: (input) =>
      transport.request((client) => client[WS_METHODS.providerUsageRequestList](input)),
    respondToRequest: (input) =>
      transport.request((client) => client[WS_METHODS.providerUsageRequestRespond](input)),
    withdrawRequest: (input) =>
      transport.request((client) => client[WS_METHODS.providerUsageRequestWithdraw](input)),
  };
}
