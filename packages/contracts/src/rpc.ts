import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { OpenError, OpenInEditorInput } from "./editor.ts";
import { AuthAccessStreamEvent } from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCheckoutResult,
  GitGetWorkingTreeDiffInput,
  GitGetWorkingTreeDiffResult,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitManagerServiceError,
  GitAbortMergeInput,
  GitAbortMergeResult,
  GitCompareBranchesInput,
  GitCompareBranchesResult,
  GitMergeBranchInput,
  GitMergeBranchResult,
  GitMergeStateInput,
  GitMergeStateResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStatusInput,
  GitStatusResult,
  GitStatusStreamEvent,
} from "./git.ts";
import {
  DeployCreateTargetInput,
  DeployCreateTargetResult,
  DeployDeleteTargetInput,
  DeployError,
  DeployListRunsInput,
  DeployListRunsResult,
  DeployListTargetsInput,
  DeployListTargetsResult,
  DeployRunInput,
  DeployRunResult,
} from "./deploy.ts";
import {
  PackDisableInput,
  PackEnableInput,
  PackEnableResult,
  PackEnablementError,
  PackListEnablementsInput,
  PackListEnablementsResult,
} from "./packEnablement.ts";
import {
  AnalyticsDeclareStreamInput,
  AnalyticsDeclareStreamResult,
  AnalyticsError,
  AnalyticsListStreamsInput,
  AnalyticsListStreamsResult,
  AnalyticsQueryInput,
  AnalyticsQueryResult,
} from "./analytics.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
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
  CollaborationBranchClaimInput,
  CollaborationBranchClaimResult,
  CollaborationBranchListInput,
  CollaborationBranchListResult,
  CollaborationBranchReleaseInput,
  CollaborationBranchReleaseResult,
  CollaborationError,
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
  CollaborationUsageRecordInput,
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
  CollaborationSettingsGetInput,
  CollaborationSettingsResult,
  CollaborationSettingsUpdateInput,
  CollaborationSharedPromptRecordInput,
  CollaborationSharedPromptRecordResult,
  CollaborationStreamEvent,
  CollaborationStreamInput,
  CollaborationViewGetInput,
  CollaborationViewResult,
  CollaborationViewUpdateInput,
  OrganizationAccessGrantInput,
  OrganizationAccessGrantResult,
  OrganizationAccessRevokeInput,
  OrganizationAccessRevokeResult,
  OrganizationAccessReviewCompleteInput,
  OrganizationAccessReviewCompleteResult,
  OrganizationAccessReviewCreateInput,
  OrganizationAccessReviewCreateResult,
  OrganizationAuditListInput,
  OrganizationAuditListResult,
  OrganizationCreateInput,
  OrganizationCreateResult,
  OrganizationDepartmentCreateInput,
  OrganizationDepartmentCreateResult,
  OrganizationEmployeeInviteAcceptInput,
  OrganizationEmployeeInviteAcceptResult,
  OrganizationEmployeeDisableInput,
  OrganizationEmployeeInviteInput,
  OrganizationEmployeeInviteResult,
  OrganizationEmployeeListInput,
  OrganizationEmployeeListResult,
  OrganizationEmployeeUpdateInput,
  OrganizationEmployeeUpdateResult,
  OrganizationError,
  OrganizationListResult,
  OrganizationTeamCreateInput,
  OrganizationTeamCreateResult,
  ProviderAccountConfirmInput,
  ProviderAccountConfirmResult,
  ProviderAccountConnectInput,
  ProviderAccountConnectResult,
  ProviderAccountDisconnectInput,
  ProviderAccountDisconnectResult,
  ProviderAccountError,
  ProviderAccountListInput,
  ProviderAccountListResult,
  ProviderAccountOpenAuthTerminalInput,
  ProviderAccountOpenAuthTerminalResult,
  WorkspaceCreateInput,
  WorkspaceCreateResult,
} from "./tenancy.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import {
  ProjectCreateEntryError,
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectListDirectoryError,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  IsoDateTime,
  TenantId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";
import {
  PackError,
  PackHandle,
  PackId,
  PackManifest,
  PackName,
  PackTag,
  PackVersion,
  PackVisibility,
} from "./pack.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListDirectory: "projects.listDirectory",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsCreateEntry: "projects.createEntry",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // Git methods
  gitPull: "git.pull",
  gitRefreshStatus: "git.refreshStatus",
  gitGetWorkingTreeDiff: "git.getWorkingTreeDiff",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitMergeBranch: "git.mergeBranch",
  gitCompareBranches: "git.compareBranches",
  gitGetMergeState: "git.getMergeState",
  gitAbortMerge: "git.abortMerge",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",

  // Provider account methods
  providerAccountsList: "providerAccounts.list",
  providerAccountsConnect: "providerAccounts.connect",
  providerAccountsOpenAuthTerminal: "providerAccounts.openAuthTerminal",
  providerAccountsConfirm: "providerAccounts.confirm",
  providerAccountsDisconnect: "providerAccounts.disconnect",

  // Streaming subscriptions
  subscribeGitStatus: "subscribeGitStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",

  // Collaboration methods
  collaborationPresenceUpsert: "collaboration.presence.upsert",
  collaborationPresenceList: "collaboration.presence.list",
  collaborationInvitesCreate: "collaboration.invites.create",
  collaborationInvitesList: "collaboration.invites.list",
  collaborationInvitesAccept: "collaboration.invites.accept",
  collaborationInvitesRevoke: "collaboration.invites.revoke",
  collaborationSharedPromptRecord: "collaboration.sharedPrompt.record",
  collaborationActivityList: "collaboration.activity.list",
  collaborationActivityVisibility: "collaboration.activity.visibility",
  collaborationSettingsGet: "collaboration.settings.get",
  collaborationSettingsUpdate: "collaboration.settings.update",
  collaborationApprovalsSubmit: "collaboration.approvals.submit",
  collaborationApprovalsList: "collaboration.approvals.list",
  collaborationApprovalsDecide: "collaboration.approvals.decide",
  collaborationViewGet: "collaboration.view.get",
  collaborationViewUpdate: "collaboration.view.update",
  collaborationBranchClaim: "collaboration.branch.claim",
  collaborationBranchList: "collaboration.branch.list",
  collaborationBranchRelease: "collaboration.branch.release",
  collaborationFilesTouch: "collaboration.files.touch",
  collaborationFilesTouchList: "collaboration.files.touchList",
  collaborationMembersList: "collaboration.members.list",
  collaborationMembersUpdate: "collaboration.members.update",
  collaborationMembersRemove: "collaboration.members.remove",
  collaborationUsageRecord: "collaboration.usage.record",
  collaborationConsentGet: "collaboration.consent.get",
  collaborationConsentUpdate: "collaboration.consent.update",
  subscribeCollaboration: "collaboration.subscribe",

  // Pack registry methods
  packsPublish: "packs.publish",
  packsRecordVersion: "packs.recordVersion",
  packsSearch: "packs.search",
  packsGet: "packs.get",
  packsListVersions: "packs.listVersions",
  packsSetVisibility: "packs.setVisibility",
  subscribePacks: "packs.subscribe",

  // Deploy methods
  deployListTargets: "deploy.targets.list",
  deployCreateTarget: "deploy.targets.create",
  deployDeleteTarget: "deploy.targets.delete",
  deployRun: "deploy.run",
  deployListRuns: "deploy.runs.list",
  analyticsListStreams: "analytics.streams.list",
  analyticsDeclareStream: "analytics.streams.declare",
  analyticsQuery: "analytics.query",
  packsEnable: "packs.enable",
  packsDisable: "packs.disable",
  packsListEnablements: "packs.enablements.list",

  // Workspace / tenancy methods
  workspacesCreate: "workspaces.create",

  // Organization / RBAC methods
  organizationsCreate: "organizations.create",
  organizationsList: "organizations.list",
  organizationEmployeesInvite: "organization.employees.invite",
  organizationEmployeesAcceptInvite: "organization.employees.acceptInvite",
  organizationEmployeesList: "organization.employees.list",
  organizationEmployeesUpdate: "organization.employees.update",
  organizationEmployeesDisable: "organization.employees.disable",
  organizationTeamsCreate: "organization.teams.create",
  organizationDepartmentsCreate: "organization.departments.create",
  organizationAccessGrant: "organization.access.grant",
  organizationAccessRevoke: "organization.access.revoke",
  organizationAccessReviewCreate: "organization.accessReview.create",
  organizationAccessReviewComplete: "organization.accessReview.complete",
  organizationAuditList: "organization.audit.list",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsProviderAccountsListRpc = Rpc.make(WS_METHODS.providerAccountsList, {
  payload: ProviderAccountListInput,
  success: ProviderAccountListResult,
  error: ProviderAccountError,
});

export const WsProviderAccountsConnectRpc = Rpc.make(WS_METHODS.providerAccountsConnect, {
  payload: ProviderAccountConnectInput,
  success: ProviderAccountConnectResult,
  error: ProviderAccountError,
});

export const WsProviderAccountsOpenAuthTerminalRpc = Rpc.make(
  WS_METHODS.providerAccountsOpenAuthTerminal,
  {
    payload: ProviderAccountOpenAuthTerminalInput,
    success: ProviderAccountOpenAuthTerminalResult,
    error: ProviderAccountError,
  },
);

export const WsProviderAccountsConfirmRpc = Rpc.make(WS_METHODS.providerAccountsConfirm, {
  payload: ProviderAccountConfirmInput,
  success: ProviderAccountConfirmResult,
  error: ProviderAccountError,
});

export const WsProviderAccountsDisconnectRpc = Rpc.make(WS_METHODS.providerAccountsDisconnect, {
  payload: ProviderAccountDisconnectInput,
  success: ProviderAccountDisconnectResult,
  error: ProviderAccountError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsListDirectoryRpc = Rpc.make(WS_METHODS.projectsListDirectory, {
  payload: ProjectListDirectoryInput,
  success: ProjectListDirectoryResult,
  error: ProjectListDirectoryError,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: ProjectReadFileError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsProjectsCreateEntryRpc = Rpc.make(WS_METHODS.projectsCreateEntry, {
  payload: ProjectCreateEntryInput,
  success: ProjectCreateEntryResult,
  error: ProjectCreateEntryError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

export const WsSubscribeGitStatusRpc = Rpc.make(WS_METHODS.subscribeGitStatus, {
  payload: GitStatusInput,
  success: GitStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: GitCommandError,
});

export const WsGitRefreshStatusRpc = Rpc.make(WS_METHODS.gitRefreshStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitGetWorkingTreeDiffRpc = Rpc.make(WS_METHODS.gitGetWorkingTreeDiff, {
  payload: GitGetWorkingTreeDiffInput,
  success: GitGetWorkingTreeDiffResult,
  error: GitCommandError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: GitCreateBranchResult,
  error: GitCommandError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: GitCheckoutResult,
  error: GitCommandError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

/**
 * Reading only. Declaring a stream hands back an ingest key, which is write
 * access to a project's numbers — that stays on the CLI rather than becoming
 * something a browser session can mint.
 */
export const WsPacksEnableRpc = Rpc.make(WS_METHODS.packsEnable, {
  payload: PackEnableInput,
  success: PackEnableResult,
  error: PackEnablementError,
});

export const WsPacksDisableRpc = Rpc.make(WS_METHODS.packsDisable, {
  payload: PackDisableInput,
  error: PackEnablementError,
});

export const WsPacksListEnablementsRpc = Rpc.make(WS_METHODS.packsListEnablements, {
  payload: PackListEnablementsInput,
  success: PackListEnablementsResult,
  error: PackEnablementError,
});

export const WsAnalyticsListStreamsRpc = Rpc.make(WS_METHODS.analyticsListStreams, {
  payload: AnalyticsListStreamsInput,
  success: AnalyticsListStreamsResult,
  error: AnalyticsError,
});

/**
 * Declaring was reachable only from the CLI, so an agent inside a session could
 * not open a stream for the thing it had just built without shelling out —
 * and nothing told it the option existed. The ingest key comes back here for
 * the same reason it does on the CLI: this is the only moment it exists.
 */
export const WsAnalyticsDeclareStreamRpc = Rpc.make(WS_METHODS.analyticsDeclareStream, {
  payload: AnalyticsDeclareStreamInput,
  success: AnalyticsDeclareStreamResult,
  error: AnalyticsError,
});

export const WsAnalyticsQueryRpc = Rpc.make(WS_METHODS.analyticsQuery, {
  payload: AnalyticsQueryInput,
  success: AnalyticsQueryResult,
  error: AnalyticsError,
});

export const WsDeployListTargetsRpc = Rpc.make(WS_METHODS.deployListTargets, {
  payload: DeployListTargetsInput,
  success: DeployListTargetsResult,
  error: DeployError,
});

export const WsDeployCreateTargetRpc = Rpc.make(WS_METHODS.deployCreateTarget, {
  payload: DeployCreateTargetInput,
  success: DeployCreateTargetResult,
  error: DeployError,
});

export const WsDeployDeleteTargetRpc = Rpc.make(WS_METHODS.deployDeleteTarget, {
  payload: DeployDeleteTargetInput,
  error: DeployError,
});

export const WsDeployRunRpc = Rpc.make(WS_METHODS.deployRun, {
  payload: DeployRunInput,
  success: DeployRunResult,
  error: DeployError,
});

export const WsDeployListRunsRpc = Rpc.make(WS_METHODS.deployListRuns, {
  payload: DeployListRunsInput,
  success: DeployListRunsResult,
  error: DeployError,
});

export const WsGitMergeBranchRpc = Rpc.make(WS_METHODS.gitMergeBranch, {
  payload: GitMergeBranchInput,
  success: GitMergeBranchResult,
  error: GitCommandError,
});

export const WsGitCompareBranchesRpc = Rpc.make(WS_METHODS.gitCompareBranches, {
  payload: GitCompareBranchesInput,
  success: GitCompareBranchesResult,
  error: GitCommandError,
});

export const WsGitGetMergeStateRpc = Rpc.make(WS_METHODS.gitGetMergeState, {
  payload: GitMergeStateInput,
  success: GitMergeStateResult,
  error: GitCommandError,
});

export const WsGitAbortMergeRpc = Rpc.make(WS_METHODS.gitAbortMerge, {
  payload: GitAbortMergeInput,
  success: GitAbortMergeResult,
  error: GitCommandError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  stream: true,
});

export const WsCollaborationPresenceUpsertRpc = Rpc.make(WS_METHODS.collaborationPresenceUpsert, {
  payload: CollaborationPresenceUpsertInput,
  success: CollaborationPresenceUpsertResult,
  error: CollaborationError,
});

export const WsCollaborationPresenceListRpc = Rpc.make(WS_METHODS.collaborationPresenceList, {
  payload: CollaborationPresenceListInput,
  success: CollaborationPresenceListResult,
  error: CollaborationError,
});

export const WsCollaborationInvitesCreateRpc = Rpc.make(WS_METHODS.collaborationInvitesCreate, {
  payload: CollaborationInviteCreateInput,
  success: CollaborationInviteCreateResult,
  error: CollaborationError,
});

export const WsCollaborationInvitesListRpc = Rpc.make(WS_METHODS.collaborationInvitesList, {
  payload: CollaborationInviteListInput,
  success: CollaborationInviteListResult,
  error: CollaborationError,
});

export const WsCollaborationInvitesAcceptRpc = Rpc.make(WS_METHODS.collaborationInvitesAccept, {
  payload: CollaborationInviteAcceptInput,
  success: CollaborationInviteAcceptResult,
  error: CollaborationError,
});

export const WsCollaborationInvitesRevokeRpc = Rpc.make(WS_METHODS.collaborationInvitesRevoke, {
  payload: CollaborationInviteRevokeInput,
  success: CollaborationInviteRevokeResult,
  error: CollaborationError,
});

export const WsCollaborationSharedPromptRecordRpc = Rpc.make(
  WS_METHODS.collaborationSharedPromptRecord,
  {
    payload: CollaborationSharedPromptRecordInput,
    success: CollaborationSharedPromptRecordResult,
    error: CollaborationError,
  },
);

export const WsCollaborationActivityListRpc = Rpc.make(WS_METHODS.collaborationActivityList, {
  payload: CollaborationActivityListInput,
  success: CollaborationActivityListResult,
  error: CollaborationError,
});

export const WsCollaborationSettingsGetRpc = Rpc.make(WS_METHODS.collaborationSettingsGet, {
  payload: CollaborationSettingsGetInput,
  success: CollaborationSettingsResult,
  error: CollaborationError,
});

export const WsCollaborationSettingsUpdateRpc = Rpc.make(WS_METHODS.collaborationSettingsUpdate, {
  payload: CollaborationSettingsUpdateInput,
  success: CollaborationSettingsResult,
  error: CollaborationError,
});

export const WsCollaborationApprovalsSubmitRpc = Rpc.make(WS_METHODS.collaborationApprovalsSubmit, {
  payload: CollaborationApprovalSubmitInput,
  success: CollaborationApprovalSubmitResult,
  error: CollaborationError,
});

export const WsCollaborationApprovalsListRpc = Rpc.make(WS_METHODS.collaborationApprovalsList, {
  payload: CollaborationApprovalListInput,
  success: CollaborationApprovalListResult,
  error: CollaborationError,
});

export const WsCollaborationApprovalsDecideRpc = Rpc.make(WS_METHODS.collaborationApprovalsDecide, {
  payload: CollaborationApprovalDecideInput,
  success: CollaborationApprovalDecideResult,
  error: CollaborationError,
});

export const WsCollaborationViewGetRpc = Rpc.make(WS_METHODS.collaborationViewGet, {
  payload: CollaborationViewGetInput,
  success: CollaborationViewResult,
  error: CollaborationError,
});

export const WsCollaborationViewUpdateRpc = Rpc.make(WS_METHODS.collaborationViewUpdate, {
  payload: CollaborationViewUpdateInput,
  success: CollaborationViewResult,
  error: CollaborationError,
});

export const WsCollaborationBranchClaimRpc = Rpc.make(WS_METHODS.collaborationBranchClaim, {
  payload: CollaborationBranchClaimInput,
  success: CollaborationBranchClaimResult,
  error: CollaborationError,
});

export const WsCollaborationBranchListRpc = Rpc.make(WS_METHODS.collaborationBranchList, {
  payload: CollaborationBranchListInput,
  success: CollaborationBranchListResult,
  error: CollaborationError,
});

export const WsCollaborationBranchReleaseRpc = Rpc.make(WS_METHODS.collaborationBranchRelease, {
  payload: CollaborationBranchReleaseInput,
  success: CollaborationBranchReleaseResult,
  error: CollaborationError,
});

export const WsCollaborationFilesTouchRpc = Rpc.make(WS_METHODS.collaborationFilesTouch, {
  payload: CollaborationFileTouchInput,
  success: CollaborationFileTouchResult,
  error: CollaborationError,
});

export const WsCollaborationFilesTouchListRpc = Rpc.make(WS_METHODS.collaborationFilesTouchList, {
  payload: CollaborationFileTouchListInput,
  success: CollaborationFileTouchResult,
  error: CollaborationError,
});

export const WsCollaborationActivityVisibilityRpc = Rpc.make(
  WS_METHODS.collaborationActivityVisibility,
  {
    payload: CollaborationActivityVisibilityInput,
    success: CollaborationActivityVisibilityResult,
    error: CollaborationError,
  },
);

export const WsCollaborationMembersListRpc = Rpc.make(WS_METHODS.collaborationMembersList, {
  payload: CollaborationMemberListInput,
  success: CollaborationMemberListResult,
  error: CollaborationError,
});

export const WsCollaborationMembersUpdateRpc = Rpc.make(WS_METHODS.collaborationMembersUpdate, {
  payload: CollaborationMemberUpdateInput,
  success: CollaborationMemberResult,
  error: CollaborationError,
});

export const WsCollaborationMembersRemoveRpc = Rpc.make(WS_METHODS.collaborationMembersRemove, {
  payload: CollaborationMemberRemoveInput,
  success: CollaborationMemberRemoveResult,
  error: CollaborationError,
});

export const WsCollaborationUsageRecordRpc = Rpc.make(WS_METHODS.collaborationUsageRecord, {
  payload: CollaborationUsageRecordInput,
  success: CollaborationMemberResult,
  error: CollaborationError,
});

export const WsCollaborationConsentGetRpc = Rpc.make(WS_METHODS.collaborationConsentGet, {
  payload: CollaborationConsentGetInput,
  success: CollaborationConsentResult,
  error: CollaborationError,
});

export const WsCollaborationConsentUpdateRpc = Rpc.make(WS_METHODS.collaborationConsentUpdate, {
  payload: CollaborationConsentUpdateInput,
  success: CollaborationConsentResult,
  error: CollaborationError,
});

export const WsSubscribeCollaborationRpc = Rpc.make(WS_METHODS.subscribeCollaboration, {
  payload: CollaborationStreamInput,
  success: CollaborationStreamEvent,
  error: CollaborationError,
  stream: true,
});

// ── Pack registry ───────────────────────────────────────────────────────────

/**
 * What one server's registry has recorded about a pack. These projections live
 * beside the RPC rather than in `pack.ts` because they are not part of the pack
 * format: a manifest describes a pack, and an entry describes what a particular
 * registry knows about it — who published it, and who may currently see it.
 */
export const PackRegistryEntry = Schema.Struct({
  packId: PackId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  name: PackName,
  publisherHandle: PackHandle,
  displayName: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  capabilitySummary: TrimmedNonEmptyString,
  tags: Schema.Array(PackTag),
  visibility: PackVisibility,
  latestVersion: PackVersion,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PackRegistryEntry = typeof PackRegistryEntry.Type;

/** One immutable release. Nothing here is ever rewritten. */
export const PackRegistryVersion = Schema.Struct({
  packId: PackId,
  version: PackVersion,
  capabilitySummary: TrimmedNonEmptyString,
  publishedByUserId: UserId,
  publishedAt: IsoDateTime,
});
export type PackRegistryVersion = typeof PackRegistryVersion.Type;

/**
 * The workspace a pack request is made from.
 *
 * The organizations a caller belongs to are deliberately absent: the server
 * fills those from the session, because a viewer scope that arrives on the wire
 * is a claim, and a caller that could name any organization could read every
 * pack listed to it.
 */
const PackWorkspaceScopeFields = {
  tenantId: TenantId,
  workspaceId: WorkspaceId,
};

export const PackPublishInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  manifest: PackManifest,
});
export type PackPublishInput = typeof PackPublishInput.Type;

export const PackVersionInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  packId: PackId,
  manifest: PackManifest,
});
export type PackVersionInput = typeof PackVersionInput.Type;

export const PackSearchInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  /** Matched against name, tags and capability summary at once. */
  query: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});
export type PackSearchInput = typeof PackSearchInput.Type;

export const PackGetInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  packId: PackId,
  /** Omitted means the most recently published version. */
  version: Schema.optional(PackVersion),
});
export type PackGetInput = typeof PackGetInput.Type;

export const PackVersionListInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  packId: PackId,
});
export type PackVersionListInput = typeof PackVersionListInput.Type;

export const PackVisibilityInput = Schema.Struct({
  ...PackWorkspaceScopeFields,
  packId: PackId,
  visibility: PackVisibility,
});
export type PackVisibilityInput = typeof PackVisibilityInput.Type;

export const PackStreamInput = Schema.Struct(PackWorkspaceScopeFields);
export type PackStreamInput = typeof PackStreamInput.Type;

export const PackPublishResult = Schema.Struct({
  pack: PackRegistryEntry,
  version: PackRegistryVersion,
});
export type PackPublishResult = typeof PackPublishResult.Type;

export const PackSearchResult = Schema.Struct({
  packs: Schema.Array(PackRegistryEntry),
});
export type PackSearchResult = typeof PackSearchResult.Type;

export const PackGetResult = Schema.Struct({
  pack: PackRegistryEntry,
  version: PackRegistryVersion,
  manifest: PackManifest,
});
export type PackGetResult = typeof PackGetResult.Type;

export const PackVersionListResult = Schema.Struct({
  pack: PackRegistryEntry,
  /** Newest first. Pinning one of these is what a rollback is. */
  versions: Schema.Array(PackRegistryVersion),
});
export type PackVersionListResult = typeof PackVersionListResult.Type;

export const PackVisibilityResult = Schema.Struct({
  pack: PackRegistryEntry,
});
export type PackVisibilityResult = typeof PackVisibilityResult.Type;

export const PackRegistryStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pack-published"),
    pack: PackRegistryEntry,
  }),
  Schema.Struct({
    type: Schema.Literal("pack-version-recorded"),
    pack: PackRegistryEntry,
    version: PackRegistryVersion,
  }),
  Schema.Struct({
    type: Schema.Literal("pack-visibility-changed"),
    pack: PackRegistryEntry,
  }),
]);
export type PackRegistryStreamEvent = typeof PackRegistryStreamEvent.Type;

export const WsPacksPublishRpc = Rpc.make(WS_METHODS.packsPublish, {
  payload: PackPublishInput,
  success: PackPublishResult,
  error: PackError,
});

export const WsPacksRecordVersionRpc = Rpc.make(WS_METHODS.packsRecordVersion, {
  payload: PackVersionInput,
  success: PackPublishResult,
  error: PackError,
});

export const WsPacksSearchRpc = Rpc.make(WS_METHODS.packsSearch, {
  payload: PackSearchInput,
  success: PackSearchResult,
  error: PackError,
});

export const WsPacksGetRpc = Rpc.make(WS_METHODS.packsGet, {
  payload: PackGetInput,
  success: PackGetResult,
  error: PackError,
});

export const WsPacksListVersionsRpc = Rpc.make(WS_METHODS.packsListVersions, {
  payload: PackVersionListInput,
  success: PackVersionListResult,
  error: PackError,
});

export const WsPacksSetVisibilityRpc = Rpc.make(WS_METHODS.packsSetVisibility, {
  payload: PackVisibilityInput,
  success: PackVisibilityResult,
  error: PackError,
});

export const WsSubscribePacksRpc = Rpc.make(WS_METHODS.subscribePacks, {
  payload: PackStreamInput,
  success: PackRegistryStreamEvent,
  error: PackError,
  stream: true,
});

export const WsWorkspacesCreateRpc = Rpc.make(WS_METHODS.workspacesCreate, {
  payload: WorkspaceCreateInput,
  success: WorkspaceCreateResult,
  error: OrganizationError,
});

export const WsOrganizationsCreateRpc = Rpc.make(WS_METHODS.organizationsCreate, {
  payload: OrganizationCreateInput,
  success: OrganizationCreateResult,
  error: OrganizationError,
});

export const WsOrganizationsListRpc = Rpc.make(WS_METHODS.organizationsList, {
  payload: Schema.Struct({}),
  success: OrganizationListResult,
  error: OrganizationError,
});

export const WsOrganizationEmployeesInviteRpc = Rpc.make(WS_METHODS.organizationEmployeesInvite, {
  payload: OrganizationEmployeeInviteInput,
  success: OrganizationEmployeeInviteResult,
  error: OrganizationError,
});

export const WsOrganizationEmployeesAcceptInviteRpc = Rpc.make(
  WS_METHODS.organizationEmployeesAcceptInvite,
  {
    payload: OrganizationEmployeeInviteAcceptInput,
    success: OrganizationEmployeeInviteAcceptResult,
    error: OrganizationError,
  },
);

export const WsOrganizationEmployeesListRpc = Rpc.make(WS_METHODS.organizationEmployeesList, {
  payload: OrganizationEmployeeListInput,
  success: OrganizationEmployeeListResult,
  error: OrganizationError,
});

export const WsOrganizationEmployeesUpdateRpc = Rpc.make(WS_METHODS.organizationEmployeesUpdate, {
  payload: OrganizationEmployeeUpdateInput,
  success: OrganizationEmployeeUpdateResult,
  error: OrganizationError,
});

export const WsOrganizationEmployeesDisableRpc = Rpc.make(WS_METHODS.organizationEmployeesDisable, {
  payload: OrganizationEmployeeDisableInput,
  success: OrganizationEmployeeUpdateResult,
  error: OrganizationError,
});

export const WsOrganizationTeamsCreateRpc = Rpc.make(WS_METHODS.organizationTeamsCreate, {
  payload: OrganizationTeamCreateInput,
  success: OrganizationTeamCreateResult,
  error: OrganizationError,
});

export const WsOrganizationDepartmentsCreateRpc = Rpc.make(
  WS_METHODS.organizationDepartmentsCreate,
  {
    payload: OrganizationDepartmentCreateInput,
    success: OrganizationDepartmentCreateResult,
    error: OrganizationError,
  },
);

export const WsOrganizationAccessGrantRpc = Rpc.make(WS_METHODS.organizationAccessGrant, {
  payload: OrganizationAccessGrantInput,
  success: OrganizationAccessGrantResult,
  error: OrganizationError,
});

export const WsOrganizationAccessRevokeRpc = Rpc.make(WS_METHODS.organizationAccessRevoke, {
  payload: OrganizationAccessRevokeInput,
  success: OrganizationAccessRevokeResult,
  error: OrganizationError,
});

export const WsOrganizationAccessReviewCreateRpc = Rpc.make(
  WS_METHODS.organizationAccessReviewCreate,
  {
    payload: OrganizationAccessReviewCreateInput,
    success: OrganizationAccessReviewCreateResult,
    error: OrganizationError,
  },
);

export const WsOrganizationAccessReviewCompleteRpc = Rpc.make(
  WS_METHODS.organizationAccessReviewComplete,
  {
    payload: OrganizationAccessReviewCompleteInput,
    success: OrganizationAccessReviewCompleteResult,
    error: OrganizationError,
  },
);

export const WsOrganizationAuditListRpc = Rpc.make(WS_METHODS.organizationAuditList, {
  payload: OrganizationAuditListInput,
  success: OrganizationAuditListResult,
  error: OrganizationError,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsProviderAccountsListRpc,
  WsProviderAccountsConnectRpc,
  WsProviderAccountsOpenAuthTerminalRpc,
  WsProviderAccountsConfirmRpc,
  WsProviderAccountsDisconnectRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsListDirectoryRpc,
  WsProjectsReadFileRpc,
  WsProjectsWriteFileRpc,
  WsProjectsCreateEntryRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsSubscribeGitStatusRpc,
  WsGitPullRpc,
  WsGitRefreshStatusRpc,
  WsGitGetWorkingTreeDiffRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsGitMergeBranchRpc,
  WsGitCompareBranchesRpc,
  WsGitGetMergeStateRpc,
  WsGitAbortMergeRpc,
  WsDeployListTargetsRpc,
  WsDeployCreateTargetRpc,
  WsDeployDeleteTargetRpc,
  WsDeployRunRpc,
  WsDeployListRunsRpc,
  WsAnalyticsListStreamsRpc,
  WsAnalyticsDeclareStreamRpc,
  WsAnalyticsQueryRpc,
  WsPacksEnableRpc,
  WsPacksDisableRpc,
  WsPacksListEnablementsRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsCollaborationPresenceUpsertRpc,
  WsCollaborationPresenceListRpc,
  WsCollaborationInvitesCreateRpc,
  WsCollaborationInvitesListRpc,
  WsCollaborationInvitesAcceptRpc,
  WsCollaborationInvitesRevokeRpc,
  WsCollaborationSharedPromptRecordRpc,
  WsCollaborationActivityListRpc,
  WsCollaborationSettingsGetRpc,
  WsCollaborationSettingsUpdateRpc,
  WsCollaborationApprovalsSubmitRpc,
  WsCollaborationApprovalsListRpc,
  WsCollaborationApprovalsDecideRpc,
  WsCollaborationViewGetRpc,
  WsCollaborationViewUpdateRpc,
  WsCollaborationBranchClaimRpc,
  WsCollaborationBranchListRpc,
  WsCollaborationBranchReleaseRpc,
  WsCollaborationFilesTouchRpc,
  WsCollaborationFilesTouchListRpc,
  WsCollaborationActivityVisibilityRpc,
  WsCollaborationMembersListRpc,
  WsCollaborationMembersUpdateRpc,
  WsCollaborationMembersRemoveRpc,
  WsCollaborationUsageRecordRpc,
  WsCollaborationConsentGetRpc,
  WsCollaborationConsentUpdateRpc,
  WsSubscribeCollaborationRpc,
  WsPacksPublishRpc,
  WsPacksRecordVersionRpc,
  WsPacksSearchRpc,
  WsPacksGetRpc,
  WsPacksListVersionsRpc,
  WsPacksSetVisibilityRpc,
  WsSubscribePacksRpc,
  WsWorkspacesCreateRpc,
  WsOrganizationsCreateRpc,
  WsOrganizationsListRpc,
  WsOrganizationEmployeesInviteRpc,
  WsOrganizationEmployeesAcceptInviteRpc,
  WsOrganizationEmployeesListRpc,
  WsOrganizationEmployeesUpdateRpc,
  WsOrganizationEmployeesDisableRpc,
  WsOrganizationTeamsCreateRpc,
  WsOrganizationDepartmentsCreateRpc,
  WsOrganizationAccessGrantRpc,
  WsOrganizationAccessRevokeRpc,
  WsOrganizationAccessReviewCreateRpc,
  WsOrganizationAccessReviewCompleteRpc,
  WsOrganizationAuditListRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
