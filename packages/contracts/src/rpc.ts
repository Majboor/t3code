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
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  CollaborationActivityListInput,
  CollaborationActivityListResult,
  CollaborationError,
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
  subscribeCollaboration: "collaboration.subscribe",

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

export const WsGitMergeBranchRpc = Rpc.make(WS_METHODS.gitMergeBranch, {
  payload: GitMergeBranchInput,
  success: GitMergeBranchResult,
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

export const WsSubscribeCollaborationRpc = Rpc.make(WS_METHODS.subscribeCollaboration, {
  payload: CollaborationStreamInput,
  success: CollaborationStreamEvent,
  error: CollaborationError,
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
  WsGitGetMergeStateRpc,
  WsGitAbortMergeRpc,
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
  WsSubscribeCollaborationRpc,
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
