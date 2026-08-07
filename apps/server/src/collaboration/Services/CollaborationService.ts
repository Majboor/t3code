import type {
  CollaborationActivity,
  CollaborationActivityListInput,
  CollaborationActivityListResult,
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
    input: CollaborationActivityListInput,
  ) => Effect.Effect<CollaborationActivityListResult, CollaborationError>;

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
}

export class CollaborationService extends Context.Service<
  CollaborationService,
  CollaborationServiceShape
>()("t3/collaboration/Services/CollaborationService") {}
