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
  CollaborationFilePresenceListInput,
  CollaborationFilePresenceMarkInput,
  CollaborationFilePresenceReleaseInput,
  CollaborationFilePresenceResult,
  CollaborationFilePresence,
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
  CollaborationUsageQueryInput,
  CollaborationUsageQueryResult,
  CollaborationUsageRecordInput,
  TenantInvite,
  TenantMembership,
  UserId,
  CollaborationDirectMessageListInput,
  CollaborationDirectMessageListResult,
  CollaborationNoteCreateInput,
  CollaborationNoteCreateResult,
  CollaborationNoteListInput,
  CollaborationNoteListResult,
  CollaborationNoteResolveInput,
  CollaborationNoteResolveResult,
  CollaborationSharedPromptCreateInput,
  CollaborationSharedPromptCreateResult,
  CollaborationSharedPromptListInput,
  CollaborationSharedPromptListResult,
} from "@t3tools/contracts";
import { Context, type Effect, type Stream } from "effect";

import type {
  CollaborationMemberProfileRecord,
  CollaborationMemberUsageRecord,
} from "../../persistence/Services/Tenancy.ts";

export interface CollaborationActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarInitials?: string;
  /**
   * The address this account can be proved to own, when the server knows one.
   *
   * Resolved server-side from the account record, never taken from the client,
   * so "absent" means this install cannot prove an address for this session —
   * not that the caller declined to send one. `acceptInvite` is the only thing
   * that reads it, and only to refuse a mismatch.
   */
  readonly email?: string | null;
}

export interface CollaborationServiceShape {
  readonly upsertPresence: (
    actor: CollaborationActor,
    input: CollaborationPresenceUpsertInput,
  ) => Effect.Effect<CollaborationPresenceUpsertResult, CollaborationError>;

  readonly listPresence: (
    actor: CollaborationActor,
    input: CollaborationPresenceListInput,
  ) => Effect.Effect<CollaborationPresenceListResult, CollaborationError>;

  readonly createInvite: (
    actor: CollaborationActor,
    input: CollaborationInviteCreateInput,
  ) => Effect.Effect<CollaborationInviteCreateResult, CollaborationError>;

  readonly listInvites: (
    actor: CollaborationActor,
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

  /**
   * Shares a prompt as a durable, commentable post — distinct from
   * `recordSharedPrompt`, which only appends an ephemeral audit-log entry
   * with no id a note could reference.
   */
  readonly createSharedPrompt: (
    actor: CollaborationActor,
    input: CollaborationSharedPromptCreateInput,
  ) => Effect.Effect<CollaborationSharedPromptCreateResult, CollaborationError>;

  readonly listSharedPrompts: (
    actor: CollaborationActor,
    input: CollaborationSharedPromptListInput,
  ) => Effect.Effect<CollaborationSharedPromptListResult, CollaborationError>;

  /** A note on a shared prompt (`targetType: "prompt"`) or a direct message (`targetType: "user"`). */
  readonly createNote: (
    actor: CollaborationActor,
    input: CollaborationNoteCreateInput,
  ) => Effect.Effect<CollaborationNoteCreateResult, CollaborationError>;

  readonly listNotesForTarget: (
    actor: CollaborationActor,
    input: CollaborationNoteListInput,
  ) => Effect.Effect<CollaborationNoteListResult, CollaborationError>;

  /** Only the shared prompt's own author may resolve a note on it. */
  readonly resolveNote: (
    actor: CollaborationActor,
    input: CollaborationNoteResolveInput,
  ) => Effect.Effect<CollaborationNoteResolveResult, CollaborationError>;

  readonly listDirectMessages: (
    actor: CollaborationActor,
    input: CollaborationDirectMessageListInput,
  ) => Effect.Effect<CollaborationDirectMessageListResult, CollaborationError>;

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

  /**
   * Whether this person may put work into the workspace at all. A membership of
   * `viewer` and nothing else can watch but not prompt.
   */
  readonly checkWriteAccessForTurn: (
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

  /**
   * Records touches for work somebody asked for but did not type.
   *
   * An agent writes with no session attached, so there is no actor to hand in —
   * only the id of whoever sent the message that started the turn. The name is
   * resolved here rather than guessed by the caller, so a mark left by an agent
   * and a mark left by a browser name the same person the same way, and the
   * contention warning can finally see a file two agents are both in.
   */
  readonly touchFilesForUser: (
    userId: UserId,
    input: CollaborationFileTouchInput,
  ) => Effect.Effect<CollaborationFileTouchResult, CollaborationError>;

  readonly listFileTouches: (
    input: CollaborationFileTouchListInput,
  ) => Effect.Effect<CollaborationFileTouchResult, CollaborationError>;

  /**
   * Claims, or re-claims, "this person has these files open right now".
   *
   * Idempotent by design: a browser calls this on a heartbeat and the row it
   * writes is keyed on the page rather than the call, so refreshing a claim
   * moves its deadline and nothing else. The kind is always `person` — it is
   * decided here from the fact that a session made the call, never taken from
   * the caller, or a tab could dress itself up as an agent.
   */
  readonly markFilePresence: (
    actor: CollaborationActor,
    input: CollaborationFilePresenceMarkInput,
  ) => Effect.Effect<CollaborationFilePresenceResult, CollaborationError>;

  /**
   * The same claim for a turn, filed by the reactor that runs it.
   *
   * An agent has no session and no account, so — exactly as `touchFilesForUser`
   * does — it borrows the id of whoever asked for the turn, and the name is
   * resolved here so an agent's mark and its author's roster row never disagree.
   */
  readonly markFilePresenceForAgent: (
    userId: UserId,
    input: CollaborationFilePresenceMarkInput,
  ) => Effect.Effect<CollaborationFilePresenceResult, CollaborationError>;

  /** Gives a file up. An empty `paths` gives up everything this source holds. */
  readonly releaseFilePresence: (
    actor: CollaborationActor,
    input: CollaborationFilePresenceReleaseInput,
  ) => Effect.Effect<CollaborationFilePresenceResult, CollaborationError>;

  readonly releaseFilePresenceForAgent: (
    userId: UserId,
    input: CollaborationFilePresenceReleaseInput,
  ) => Effect.Effect<CollaborationFilePresenceResult, CollaborationError>;

  /** What is live in this workspace. Expired claims are never handed out. */
  readonly listFilePresence: (
    input: CollaborationFilePresenceListInput,
  ) => Effect.Effect<CollaborationFilePresenceResult, CollaborationError>;

  /**
   * Names the files somebody has open, at the moment a turn is about to start.
   *
   * Deliberately says nothing about which files the turn will write: nothing in
   * the model knows that before the turn runs, and a guess dressed as a
   * prediction would be worse than naming the real risk. Recording the warning
   * is all it does — an agent that could not run because a colleague left an
   * editor open would be a worse product than one that says so out loud.
   */
  readonly warnBeforeAgentWrites: (
    userId: UserId,
    input: CollaborationFilePresenceListInput,
  ) => Effect.Effect<{ readonly heldPaths: ReadonlyArray<string> }, CollaborationError>;

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

  /**
   * Attributes a thread's token total to whoever is running it. Reports carry a
   * cumulative figure, so re-reporting the same total changes nothing.
   *
   * Also appends to the usage series, storing the change since the last report
   * rather than the running total — otherwise every trend would count the same
   * tokens once per report.
   */
  readonly recordUsage: (
    actor: CollaborationActor,
    input: CollaborationUsageRecordInput,
  ) => Effect.Effect<CollaborationMemberResult, CollaborationError>;

  /**
   * What the workspace spent over a window: a per-member leaderboard, a daily
   * trend, an hour-of-day histogram, provider and model splits, and a cost
   * estimate. Members who opted out of sharing usage contribute to nothing the
   * caller can see, except their own row.
   */
  readonly queryUsage: (
    actor: CollaborationActor,
    input: CollaborationUsageQueryInput,
  ) => Effect.Effect<CollaborationUsageQueryResult, CollaborationError>;

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
  /** Keyed by `tenantId:workspaceId:path:userId:kind:sourceId`. Expiring, not accumulating. */
  readonly filePresence: ReadonlyMap<string, CollaborationFilePresence>;
  /** Keyed by `tenantId:workspaceId:userId`. */
  readonly memberProfiles: ReadonlyMap<string, CollaborationMemberProfileRecord>;
  /** Keyed by `tenantId:workspaceId:userId:threadId`. */
  readonly memberUsage: ReadonlyMap<string, CollaborationMemberUsageRecord>;
}

export class CollaborationService extends Context.Service<
  CollaborationService,
  CollaborationServiceShape
>()("t3/collaboration/Services/CollaborationService") {}
