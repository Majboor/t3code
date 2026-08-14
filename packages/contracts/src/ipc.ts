import type {
  PackDisableInput,
  PackEnableInput,
  PackEnableResult,
  PackListEnablementsInput,
  PackListEnablementsResult,
} from "./packEnablement.ts";
import type {
  AnalyticsListStreamsInput,
  AnalyticsListStreamsResult,
  AnalyticsQueryInput,
  AnalyticsQueryResult,
} from "./analytics.ts";
import type {
  GitAbortMergeInput,
  GitAbortMergeResult,
  GitCheckoutInput,
  GitCompareBranchesInput,
  GitCompareBranchesResult,
  GitMergeBranchInput,
  GitMergeBranchResult,
  GitMergeStateInput,
  GitMergeStateResult,
  GitCheckoutResult,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitGetWorkingTreeDiffInput,
  GitGetWorkingTreeDiffResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitCreateBranchResult,
} from "./git.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type {
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type {
  ServerConfig,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerUpsertKeybindingInput } from "./server.ts";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import type {
  CollaborationActivityListInput,
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
  CollaborationSettingsGetInput,
  CollaborationSettingsResult,
  CollaborationSettingsUpdateInput,
  CollaborationViewGetInput,
  CollaborationViewResult,
  CollaborationViewUpdateInput,
  CollaborationActivityListResult,
  CollaborationActivityVisibilityInput,
  CollaborationActivityVisibilityResult,
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
  OrganizationEmployeeDisableInput,
  OrganizationEmployeeInviteAcceptInput,
  OrganizationEmployeeInviteAcceptResult,
  OrganizationEmployeeInviteInput,
  OrganizationEmployeeInviteResult,
  OrganizationEmployeeListInput,
  OrganizationEmployeeListResult,
  OrganizationEmployeeUpdateInput,
  OrganizationEmployeeUpdateResult,
  OrganizationListResult,
  OrganizationTeamCreateInput,
  OrganizationTeamCreateResult,
  ProviderAccountConfirmInput,
  ProviderAccountConfirmResult,
  ProviderAccountConnectInput,
  ProviderAccountConnectResult,
  ProviderAccountDisconnectInput,
  ProviderAccountDisconnectResult,
  ProviderAccountListResult,
  ProviderAccountOpenAuthTerminalInput,
  ProviderAccountOpenAuthTerminalResult,
} from "./tenancy.ts";
import type { EnvironmentId } from "./baseSchemas.ts";
import type {
  PackGetInput,
  PackGetResult,
  PackPublishInput,
  PackPublishResult,
  PackRegistryStreamEvent,
  PackSearchInput,
  PackSearchResult,
  PackStreamInput,
  PackVersionInput,
  PackVersionListInput,
  PackVersionListResult,
  PackVisibilityInput,
  PackVisibilityResult,
} from "./rpc.ts";
import { EditorId } from "./editor.ts";
import { ServerSettings, type ClientSettings, type ServerSettingsPatch } from "./settings.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export interface PersistedSavedEnvironmentRecord {
  environmentId: EnvironmentId;
  label: string;
  wsBaseUrl: string;
  httpBaseUrl: string;
  createdAt: string;
  lastConnectedAt: string | null;
}

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
}

export interface PickFolderOptions {
  initialPath?: string | null;
}

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, and git operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    listDirectory: (input: ProjectListDirectoryInput) => Promise<ProjectListDirectoryResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    createEntry: (input: ProjectCreateEntryInput) => Promise<ProjectCreateEntryResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  git: {
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<GitCreateBranchResult>;
    checkout: (input: GitCheckoutInput) => Promise<GitCheckoutResult>;
    init: (input: GitInitInput) => Promise<void>;
    mergeBranch: (input: GitMergeBranchInput) => Promise<GitMergeBranchResult>;
    compareBranches: (input: GitCompareBranchesInput) => Promise<GitCompareBranchesResult>;
    getMergeState: (input: GitMergeStateInput) => Promise<GitMergeStateResult>;
    abortMerge: (input: GitAbortMergeInput) => Promise<GitAbortMergeResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    refreshStatus: (input: GitStatusInput) => Promise<GitStatusResult>;
    getWorkingTreeDiff: (input: GitGetWorkingTreeDiffInput) => Promise<GitGetWorkingTreeDiffResult>;
    onStatus: (
      input: GitStatusInput,
      callback: (status: GitStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  collaboration: {
    upsertPresence: (
      input: CollaborationPresenceUpsertInput,
    ) => Promise<CollaborationPresenceUpsertResult>;
    listPresence: (
      input: CollaborationPresenceListInput,
    ) => Promise<CollaborationPresenceListResult>;
    createInvite: (
      input: CollaborationInviteCreateInput,
    ) => Promise<CollaborationInviteCreateResult>;
    listInvites: (input: CollaborationInviteListInput) => Promise<CollaborationInviteListResult>;
    acceptInvite: (
      input: CollaborationInviteAcceptInput,
    ) => Promise<CollaborationInviteAcceptResult>;
    revokeInvite: (
      input: CollaborationInviteRevokeInput,
    ) => Promise<CollaborationInviteRevokeResult>;
    recordSharedPrompt: (
      input: CollaborationSharedPromptRecordInput,
    ) => Promise<CollaborationSharedPromptRecordResult>;
    listActivity: (
      input: CollaborationActivityListInput,
    ) => Promise<CollaborationActivityListResult>;
    getSettings: (input: CollaborationSettingsGetInput) => Promise<CollaborationSettingsResult>;
    updateSettings: (
      input: CollaborationSettingsUpdateInput,
    ) => Promise<CollaborationSettingsResult>;
    submitApproval: (
      input: CollaborationApprovalSubmitInput,
    ) => Promise<CollaborationApprovalSubmitResult>;
    listApprovals: (
      input: CollaborationApprovalListInput,
    ) => Promise<CollaborationApprovalListResult>;
    decideApproval: (
      input: CollaborationApprovalDecideInput,
    ) => Promise<CollaborationApprovalDecideResult>;
    getViewPreferences: (input: CollaborationViewGetInput) => Promise<CollaborationViewResult>;
    updateViewPreferences: (
      input: CollaborationViewUpdateInput,
    ) => Promise<CollaborationViewResult>;
    claimBranch: (input: CollaborationBranchClaimInput) => Promise<CollaborationBranchClaimResult>;
    listBranchClaims: (
      input: CollaborationBranchListInput,
    ) => Promise<CollaborationBranchListResult>;
    releaseBranch: (
      input: CollaborationBranchReleaseInput,
    ) => Promise<CollaborationBranchReleaseResult>;
    touchFiles: (input: CollaborationFileTouchInput) => Promise<CollaborationFileTouchResult>;
    listFileTouches: (
      input: CollaborationFileTouchListInput,
    ) => Promise<CollaborationFileTouchResult>;
    setActivityVisibility: (
      input: CollaborationActivityVisibilityInput,
    ) => Promise<CollaborationActivityVisibilityResult>;
    listMembers: (input: CollaborationMemberListInput) => Promise<CollaborationMemberListResult>;
    updateMember: (input: CollaborationMemberUpdateInput) => Promise<CollaborationMemberResult>;
    removeMember: (
      input: CollaborationMemberRemoveInput,
    ) => Promise<CollaborationMemberRemoveResult>;
    recordUsage: (input: CollaborationUsageRecordInput) => Promise<CollaborationMemberResult>;
    getConsent: (input: CollaborationConsentGetInput) => Promise<CollaborationConsentResult>;
    updateConsent: (input: CollaborationConsentUpdateInput) => Promise<CollaborationConsentResult>;
    subscribe: (
      input: CollaborationStreamInput,
      callback: (event: CollaborationStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  /** Reading only; declaring a stream mints an ingest key and stays on the CLI. */
  analytics: {
    listStreams: (input: AnalyticsListStreamsInput) => Promise<AnalyticsListStreamsResult>;
    query: (input: AnalyticsQueryInput) => Promise<AnalyticsQueryResult>;
  };
  packs: {
    publish: (input: PackPublishInput) => Promise<PackPublishResult>;
    recordVersion: (input: PackVersionInput) => Promise<PackPublishResult>;
    search: (input: PackSearchInput) => Promise<PackSearchResult>;
    get: (input: PackGetInput) => Promise<PackGetResult>;
    listVersions: (input: PackVersionListInput) => Promise<PackVersionListResult>;
    enable: (input: PackEnableInput) => Promise<PackEnableResult>;
    disable: (input: PackDisableInput) => Promise<void>;
    listEnablements: (input: PackListEnablementsInput) => Promise<PackListEnablementsResult>;
    setVisibility: (input: PackVisibilityInput) => Promise<PackVisibilityResult>;
    subscribe: (
      input: PackStreamInput,
      callback: (event: PackRegistryStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  organizations: {
    create: (input: OrganizationCreateInput) => Promise<OrganizationCreateResult>;
    list: () => Promise<OrganizationListResult>;
    inviteEmployee: (
      input: OrganizationEmployeeInviteInput,
    ) => Promise<OrganizationEmployeeInviteResult>;
    acceptEmployeeInvite: (
      input: OrganizationEmployeeInviteAcceptInput,
    ) => Promise<OrganizationEmployeeInviteAcceptResult>;
    listEmployees: (
      input: OrganizationEmployeeListInput,
    ) => Promise<OrganizationEmployeeListResult>;
    updateEmployee: (
      input: OrganizationEmployeeUpdateInput,
    ) => Promise<OrganizationEmployeeUpdateResult>;
    disableEmployee: (
      input: OrganizationEmployeeDisableInput,
    ) => Promise<OrganizationEmployeeUpdateResult>;
    createTeam: (input: OrganizationTeamCreateInput) => Promise<OrganizationTeamCreateResult>;
    createDepartment: (
      input: OrganizationDepartmentCreateInput,
    ) => Promise<OrganizationDepartmentCreateResult>;
    grantAccess: (input: OrganizationAccessGrantInput) => Promise<OrganizationAccessGrantResult>;
    createAccessReview: (
      input: OrganizationAccessReviewCreateInput,
    ) => Promise<OrganizationAccessReviewCreateResult>;
    completeAccessReview: (
      input: OrganizationAccessReviewCompleteInput,
    ) => Promise<OrganizationAccessReviewCompleteResult>;
    listAuditEvents: (input: OrganizationAuditListInput) => Promise<OrganizationAuditListResult>;
  };
  providerAccounts: {
    list: () => Promise<ProviderAccountListResult>;
    connect: (input: ProviderAccountConnectInput) => Promise<ProviderAccountConnectResult>;
    openAuthTerminal: (
      input: ProviderAccountOpenAuthTerminalInput,
    ) => Promise<ProviderAccountOpenAuthTerminalResult>;
    confirm: (input: ProviderAccountConfirmInput) => Promise<ProviderAccountConfirmResult>;
    disconnect: (input: ProviderAccountDisconnectInput) => Promise<ProviderAccountDisconnectResult>;
  };
}
