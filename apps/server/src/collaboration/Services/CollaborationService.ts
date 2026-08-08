import type {
  CollaborationActivity,
  CollaborationActivityListInput,
  CollaborationActivityListResult,
  CollaborationActivityVisibilityInput,
  CollaborationActivityVisibilityResult,
  CollaborationApprovalDecideInput,
  CollaborationApprovalDecideResult,
  CollaborationApprovalListInput,
  CollaborationApprovalListResult,
  CollaborationApprovalSubmitInput,
  CollaborationApprovalSubmitResult,
  CollaborationBranchClaim,
  CollaborationBranchClaimInput,
  CollaborationBranchClaimResult,
  CollaborationBranchListInput,
  CollaborationBranchListResult,
  CollaborationBranchReleaseInput,
  CollaborationBranchReleaseResult,
  CollaborationError,
  CollaborationFileTouch,
  CollaborationFileTouchInput,
  CollaborationFileTouchListInput,
  CollaborationFileTouchResult,
  CollaborationConsentGetInput,
  CollaborationConsentResult,
  CollaborationConsentUpdateInput,
  CollaborationMemberListInput,
  CollaborationMemberListResult,
  CollaborationMemberRemoveInput,
  CollaborationMemberRemoveResult,
  CollaborationMemberResult,
  CollaborationMemberUpdateInput,
  CollaborationPromptApproval,
  CollaborationSettingsGetInput,
  CollaborationSettingsResult,
  CollaborationSettingsUpdateInput,
  CollaborationViewGetInput,
  CollaborationViewPreferences,
  CollaborationViewResult,
  CollaborationViewUpdateInput,
  CollaborationWorkspaceSettings,
  CollaborationInviteAcceptInput,
  CollaborationInviteAcceptResult,
  CollaborationInviteCreateInput,
  CollaborationInviteCreateResult,
  CollaborationInviteListInput,
  CollaborationInviteListResult,
  CollaborationInviteRevokeInput,
  CollaborationInviteRevokeResult,
  CollaborationPresenceListInput,
  CollaborationPresenceListResult,
  CollaborationPresenceUpsertInput,
  CollaborationPresenceUpsertResult,
  CollaborationSharedPromptRecordInput,
  CollaborationSharedPromptRecordResult,
  CollaborationStreamEvent,
  CollaborationStreamInput,
  TenantInvite,
  TenantMembership,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect, type Stream } from "effect";

import type { CollaborationMemberProfileRecord } from "../../persistence/Services/Tenancy.ts";

export interface CollaborationActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
}

export interface CollaborationServiceShape {
  readonly upsertPresence: (
    actor: CollaborationActor,
    input: CollaborationPresenceUpsertInput,
  ) => Effect.Effect<CollaborationPresenceUpsertResult, CollaborationError>;

  readonly listPresence: (
    input: CollaborationPresenceListInput,
  ) => Effect.Effect<CollaborationPresenceListResult, CollaborationError>;

  readonly createInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteCreateInput,
  ) => Effect.Effect<CollaborationInviteCreateResult, CollaborationError>;

  readonly listInvites: (
    input: CollaborationInviteListInput,
  ) => Effect.Effect<CollaborationInviteListResult, CollaborationError>;

  readonly acceptInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteAcceptInput,
  ) => Effect.Effect<CollaborationInviteAcceptResult, CollaborationError>;

  readonly revokeInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteRevokeInput,
  ) => Effect.Effect<CollaborationInviteRevokeResult, CollaborationError>;

  readonly recordSharedPrompt: (
    actor: CollaborationActor,
    input: CollaborationSharedPromptRecordInput,
  ) => Effect.Effect<CollaborationSharedPromptRecordResult, CollaborationError>;

  readonly listActivity: (
    actor: CollaborationActor,
    input: CollaborationActivityListInput,
  ) => Effect.Effect<CollaborationActivityListResult, CollaborationError>;

  /** Takes one of the author's own entries out of the shared history, or puts it back. */
  readonly setActivityVisibility: (
    actor: CollaborationActor,
    input: CollaborationActivityVisibilityInput,
  ) => Effect.Effect<CollaborationActivityVisibilityResult, CollaborationError>;

  readonly stream: (
    input: CollaborationStreamInput,
  ) => Stream.Stream<CollaborationStreamEvent, CollaborationError>;

  readonly getSettings: (
    actor: CollaborationActor,
    input: CollaborationSettingsGetInput,
  ) => Effect.Effect<CollaborationSettingsResult, CollaborationError>;

  readonly updateSettings: (
    actor: CollaborationActor,
    input: CollaborationSettingsUpdateInput,
  ) => Effect.Effect<CollaborationSettingsResult, CollaborationError>;

  readonly submitPromptForApproval: (
    actor: CollaborationActor,
    input: CollaborationApprovalSubmitInput,
  ) => Effect.Effect<CollaborationApprovalSubmitResult, CollaborationError>;

  /**
   * Spends an approval so a turn may start. Returns whether the run is allowed;
   * an approval is good for exactly one turn.
   */
  readonly consumeApprovalForTurn: (
    actor: CollaborationActor,
    input: CollaborationSettingsGetInput,
  ) => Effect.Effect<{ readonly mayRun: boolean }, CollaborationError>;

  readonly listApprovals: (
    actor: CollaborationActor,
    input: CollaborationApprovalListInput,
  ) => Effect.Effect<CollaborationApprovalListResult, CollaborationError>;

  readonly decideApproval: (
    actor: CollaborationActor,
    input: CollaborationApprovalDecideInput,
  ) => Effect.Effect<CollaborationApprovalDecideResult, CollaborationError>;

  readonly getViewPreferences: (
    actor: CollaborationActor,
    input: CollaborationViewGetInput,
  ) => Effect.Effect<CollaborationViewResult, CollaborationError>;

  readonly updateViewPreferences: (
    actor: CollaborationActor,
    input: CollaborationViewUpdateInput,
  ) => Effect.Effect<CollaborationViewResult, CollaborationError>;

  readonly claimBranch: (
    actor: CollaborationActor,
    input: CollaborationBranchClaimInput,
  ) => Effect.Effect<CollaborationBranchClaimResult, CollaborationError>;

  readonly listBranchClaims: (
    actor: CollaborationActor,
    input: CollaborationBranchListInput,
  ) => Effect.Effect<CollaborationBranchListResult, CollaborationError>;

  readonly releaseBranch: (
    actor: CollaborationActor,
    input: CollaborationBranchReleaseInput,
  ) => Effect.Effect<CollaborationBranchReleaseResult, CollaborationError>;

  readonly touchFiles: (
    actor: CollaborationActor,
    input: CollaborationFileTouchInput,
  ) => Effect.Effect<CollaborationFileTouchResult, CollaborationError>;

  readonly listFileTouches: (
    input: CollaborationFileTouchListInput,
  ) => Effect.Effect<CollaborationFileTouchResult, CollaborationError>;

  readonly listMembers: (
    actor: CollaborationActor,
    input: CollaborationMemberListInput,
  ) => Effect.Effect<CollaborationMemberListResult, CollaborationError>;

  readonly updateMember: (
    actor: CollaborationActor,
    input: CollaborationMemberUpdateInput,
  ) => Effect.Effect<CollaborationMemberResult, CollaborationError>;

  readonly removeMember: (
    actor: CollaborationActor,
    input: CollaborationMemberRemoveInput,
  ) => Effect.Effect<CollaborationMemberRemoveResult, CollaborationError>;

  readonly getConsent: (
    actor: CollaborationActor,
    input: CollaborationConsentGetInput,
  ) => Effect.Effect<CollaborationConsentResult, CollaborationError>;

  readonly updateConsent: (
    actor: CollaborationActor,
    input: CollaborationConsentUpdateInput,
  ) => Effect.Effect<CollaborationConsentResult, CollaborationError>;
}

export interface CollaborationState {
  readonly presence: ReadonlyMap<string, CollaborationPresenceUpsertResult["presence"]>;
  readonly invites: ReadonlyMap<string, TenantInvite>;
  readonly memberships: ReadonlyMap<string, TenantMembership>;
  readonly activities: ReadonlyArray<CollaborationActivity>;
  /** Keyed by `tenantId:workspaceId`. */
  readonly settings: ReadonlyMap<string, CollaborationWorkspaceSettings>;
  readonly approvals: ReadonlyMap<string, CollaborationPromptApproval>;
  /** Keyed by `tenantId:workspaceId:userId`. */
  readonly viewPreferences: ReadonlyMap<string, CollaborationViewPreferences>;
  readonly branchClaims: ReadonlyMap<string, CollaborationBranchClaim>;
  /** Keyed by `tenantId:workspaceId:path`. */
  readonly fileTouches: ReadonlyMap<string, CollaborationFileTouch>;
  /** Keyed by `tenantId:workspaceId:userId`. */
  readonly memberProfiles: ReadonlyMap<string, CollaborationMemberProfileRecord>;
}

export class CollaborationService extends Context.Service<
  CollaborationService,
  CollaborationServiceShape
>()("t3/collaboration/Services/CollaborationService") {}
