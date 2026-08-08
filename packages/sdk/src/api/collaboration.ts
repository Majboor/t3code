/**
 * Who else is in the workspace and what they are allowed to do.
 *
 * @module api/collaboration
 */
import { type CollaborationStreamEvent, WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3CollaborationApi {
  readonly upsertPresence: (
    input: RpcInput<typeof WS_METHODS.collaborationPresenceUpsert>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationPresenceUpsert>>;
  readonly listPresence: (
    input: RpcInput<typeof WS_METHODS.collaborationPresenceList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationPresenceList>>;

  readonly createInvite: (
    input: RpcInput<typeof WS_METHODS.collaborationInvitesCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationInvitesCreate>>;
  readonly listInvites: (
    input: RpcInput<typeof WS_METHODS.collaborationInvitesList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationInvitesList>>;
  readonly acceptInvite: (
    input: RpcInput<typeof WS_METHODS.collaborationInvitesAccept>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationInvitesAccept>>;
  readonly revokeInvite: (
    input: RpcInput<typeof WS_METHODS.collaborationInvitesRevoke>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationInvitesRevoke>>;

  readonly listMembers: (
    input: RpcInput<typeof WS_METHODS.collaborationMembersList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationMembersList>>;
  readonly updateMember: (
    input: RpcInput<typeof WS_METHODS.collaborationMembersUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationMembersUpdate>>;
  readonly removeMember: (
    input: RpcInput<typeof WS_METHODS.collaborationMembersRemove>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationMembersRemove>>;
  readonly recordUsage: (
    input: RpcInput<typeof WS_METHODS.collaborationUsageRecord>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationUsageRecord>>;

  readonly getSettings: (
    input: RpcInput<typeof WS_METHODS.collaborationSettingsGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationSettingsGet>>;
  readonly updateSettings: (
    input: RpcInput<typeof WS_METHODS.collaborationSettingsUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationSettingsUpdate>>;
  readonly getConsent: (
    input: RpcInput<typeof WS_METHODS.collaborationConsentGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationConsentGet>>;
  readonly updateConsent: (
    input: RpcInput<typeof WS_METHODS.collaborationConsentUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationConsentUpdate>>;
  readonly getViewPreferences: (
    input: RpcInput<typeof WS_METHODS.collaborationViewGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationViewGet>>;
  readonly updateViewPreferences: (
    input: RpcInput<typeof WS_METHODS.collaborationViewUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationViewUpdate>>;

  /**
   * Ask whether a prompt may run. In an open workspace this answers yes
   * immediately; where prompts are reviewed it queues one for an approver.
   */
  readonly submitApproval: (
    input: RpcInput<typeof WS_METHODS.collaborationApprovalsSubmit>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationApprovalsSubmit>>;
  readonly listApprovals: (
    input: RpcInput<typeof WS_METHODS.collaborationApprovalsList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationApprovalsList>>;
  readonly decideApproval: (
    input: RpcInput<typeof WS_METHODS.collaborationApprovalsDecide>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationApprovalsDecide>>;

  readonly claimBranch: (
    input: RpcInput<typeof WS_METHODS.collaborationBranchClaim>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationBranchClaim>>;
  readonly listBranchClaims: (
    input: RpcInput<typeof WS_METHODS.collaborationBranchList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationBranchList>>;
  readonly releaseBranch: (
    input: RpcInput<typeof WS_METHODS.collaborationBranchRelease>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationBranchRelease>>;
  readonly touchFiles: (
    input: RpcInput<typeof WS_METHODS.collaborationFilesTouch>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationFilesTouch>>;
  readonly listFileTouches: (
    input: RpcInput<typeof WS_METHODS.collaborationFilesTouchList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationFilesTouchList>>;

  readonly watch: (
    input: RpcInput<typeof WS_METHODS.subscribeCollaboration>,
    onEvent: (event: CollaborationStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
}

export function makeCollaborationApi(transport: T3Transport): T3CollaborationApi {
  return {
    upsertPresence: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationPresenceUpsert](input)),
    listPresence: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationPresenceList](input)),

    createInvite: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationInvitesCreate](input)),
    listInvites: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationInvitesList](input)),
    acceptInvite: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationInvitesAccept](input)),
    revokeInvite: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationInvitesRevoke](input)),

    listMembers: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationMembersList](input)),
    updateMember: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationMembersUpdate](input)),
    removeMember: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationMembersRemove](input)),
    recordUsage: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationUsageRecord](input)),

    getSettings: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationSettingsGet](input)),
    updateSettings: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationSettingsUpdate](input)),
    getConsent: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationConsentGet](input)),
    updateConsent: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationConsentUpdate](input)),
    getViewPreferences: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationViewGet](input)),
    updateViewPreferences: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationViewUpdate](input)),

    submitApproval: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationApprovalsSubmit](input)),
    listApprovals: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationApprovalsList](input)),
    decideApproval: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationApprovalsDecide](input)),

    claimBranch: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationBranchClaim](input)),
    listBranchClaims: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationBranchList](input)),
    releaseBranch: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationBranchRelease](input)),
    touchFiles: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationFilesTouch](input)),
    listFileTouches: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationFilesTouchList](input)),

    watch: (input, onEvent, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeCollaboration](input),
        onEvent,
        options,
      ),
  };
}
