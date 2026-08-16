/**
 * Which provider accounts a workspace runs on: who contributes one, what the
 * workspace default is, and what each member is granted.
 *
 * @module api/providerSharing
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3ProviderSharingApi {
  /** Everything the sharing panel renders, in one read. */
  readonly getOverview: (
    input: RpcInput<typeof WS_METHODS.providerSharingOverviewGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerSharingOverviewGet>>;
  /** Switch one of the caller's own accounts on or off for a workspace. */
  readonly updateShare: (
    input: RpcInput<typeof WS_METHODS.providerSharingShareUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerSharingShareUpdate>>;
  readonly updatePolicy: (
    input: RpcInput<typeof WS_METHODS.providerSharingPolicyUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerSharingPolicyUpdate>>;
  readonly updateMember: (
    input: RpcInput<typeof WS_METHODS.providerSharingMemberUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerSharingMemberUpdate>>;
}

export function makeProviderSharingApi(transport: T3Transport): T3ProviderSharingApi {
  return {
    getOverview: (input) =>
      transport.request((client) => client[WS_METHODS.providerSharingOverviewGet](input)),
    updateShare: (input) =>
      transport.request((client) => client[WS_METHODS.providerSharingShareUpdate](input)),
    updatePolicy: (input) =>
      transport.request((client) => client[WS_METHODS.providerSharingPolicyUpdate](input)),
    updateMember: (input) =>
      transport.request((client) => client[WS_METHODS.providerSharingMemberUpdate](input)),
  };
}
