import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusResult,
  type GitStatusStreamEvent,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly listDirectory: RpcUnaryMethod<typeof WS_METHODS.projectsListDirectory>;
    readonly readFile: RpcUnaryMethod<typeof WS_METHODS.projectsReadFile>;
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
    readonly createEntry: RpcUnaryMethod<typeof WS_METHODS.projectsCreateEntry>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.gitRefreshStatus>;
    readonly getWorkingTreeDiff: RpcUnaryMethod<typeof WS_METHODS.gitGetWorkingTreeDiff>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeGitStatus>,
      listener: (status: GitStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly mergeBranch: RpcUnaryMethod<typeof WS_METHODS.gitMergeBranch>;
    readonly compareBranches: RpcUnaryMethod<typeof WS_METHODS.gitCompareBranches>;
    readonly getMergeState: RpcUnaryMethod<typeof WS_METHODS.gitGetMergeState>;
    readonly abortMerge: RpcUnaryMethod<typeof WS_METHODS.gitAbortMerge>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  readonly collaboration: {
    readonly upsertPresence: RpcUnaryMethod<typeof WS_METHODS.collaborationPresenceUpsert>;
    readonly listPresence: RpcUnaryMethod<typeof WS_METHODS.collaborationPresenceList>;
    readonly createInvite: RpcUnaryMethod<typeof WS_METHODS.collaborationInvitesCreate>;
    readonly listInvites: RpcUnaryMethod<typeof WS_METHODS.collaborationInvitesList>;
    readonly acceptInvite: RpcUnaryMethod<typeof WS_METHODS.collaborationInvitesAccept>;
    readonly revokeInvite: RpcUnaryMethod<typeof WS_METHODS.collaborationInvitesRevoke>;
    readonly recordSharedPrompt: RpcUnaryMethod<typeof WS_METHODS.collaborationSharedPromptRecord>;
    readonly listActivity: RpcUnaryMethod<typeof WS_METHODS.collaborationActivityList>;
    readonly getSettings: RpcUnaryMethod<typeof WS_METHODS.collaborationSettingsGet>;
    readonly updateSettings: RpcUnaryMethod<typeof WS_METHODS.collaborationSettingsUpdate>;
    readonly submitApproval: RpcUnaryMethod<typeof WS_METHODS.collaborationApprovalsSubmit>;
    readonly listApprovals: RpcUnaryMethod<typeof WS_METHODS.collaborationApprovalsList>;
    readonly decideApproval: RpcUnaryMethod<typeof WS_METHODS.collaborationApprovalsDecide>;
    readonly getViewPreferences: RpcUnaryMethod<typeof WS_METHODS.collaborationViewGet>;
    readonly updateViewPreferences: RpcUnaryMethod<typeof WS_METHODS.collaborationViewUpdate>;
    readonly claimBranch: RpcUnaryMethod<typeof WS_METHODS.collaborationBranchClaim>;
    readonly listBranchClaims: RpcUnaryMethod<typeof WS_METHODS.collaborationBranchList>;
    readonly releaseBranch: RpcUnaryMethod<typeof WS_METHODS.collaborationBranchRelease>;
    readonly touchFiles: RpcUnaryMethod<typeof WS_METHODS.collaborationFilesTouch>;
    readonly listFileTouches: RpcUnaryMethod<typeof WS_METHODS.collaborationFilesTouchList>;
    readonly setActivityVisibility: RpcUnaryMethod<
      typeof WS_METHODS.collaborationActivityVisibility
    >;
    readonly listMembers: RpcUnaryMethod<typeof WS_METHODS.collaborationMembersList>;
    readonly updateMember: RpcUnaryMethod<typeof WS_METHODS.collaborationMembersUpdate>;
    readonly removeMember: RpcUnaryMethod<typeof WS_METHODS.collaborationMembersRemove>;
    readonly recordUsage: RpcUnaryMethod<typeof WS_METHODS.collaborationUsageRecord>;
    readonly queryUsage: RpcUnaryMethod<typeof WS_METHODS.collaborationUsageQuery>;
    readonly getConsent: RpcUnaryMethod<typeof WS_METHODS.collaborationConsentGet>;
    readonly updateConsent: RpcUnaryMethod<typeof WS_METHODS.collaborationConsentUpdate>;
    readonly subscribe: RpcInputStreamMethod<typeof WS_METHODS.subscribeCollaboration>;
  };
  readonly analytics: {
    readonly listStreams: RpcUnaryMethod<typeof WS_METHODS.analyticsListStreams>;
    readonly declareStream: RpcUnaryMethod<typeof WS_METHODS.analyticsDeclareStream>;
    readonly query: RpcUnaryMethod<typeof WS_METHODS.analyticsQuery>;
  };
  readonly deploys: {
    readonly listDeployments: RpcUnaryMethod<typeof WS_METHODS.deployListDeployments>;
  };
  readonly packs: {
    readonly publish: RpcUnaryMethod<typeof WS_METHODS.packsPublish>;
    readonly recordVersion: RpcUnaryMethod<typeof WS_METHODS.packsRecordVersion>;
    readonly search: RpcUnaryMethod<typeof WS_METHODS.packsSearch>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.packsGet>;
    readonly listVersions: RpcUnaryMethod<typeof WS_METHODS.packsListVersions>;
    readonly setVisibility: RpcUnaryMethod<typeof WS_METHODS.packsSetVisibility>;
    readonly enable: RpcUnaryMethod<typeof WS_METHODS.packsEnable>;
    readonly disable: RpcUnaryMethod<typeof WS_METHODS.packsDisable>;
    readonly listEnablements: RpcUnaryMethod<typeof WS_METHODS.packsListEnablements>;
    readonly subscribe: RpcInputStreamMethod<typeof WS_METHODS.subscribePacks>;
  };
  readonly workspaces: {
    readonly create: RpcUnaryMethod<typeof WS_METHODS.workspacesCreate>;
  };
  readonly organizations: {
    readonly create: RpcUnaryMethod<typeof WS_METHODS.organizationsCreate>;
    readonly list: RpcUnaryNoArgMethod<typeof WS_METHODS.organizationsList>;
    readonly inviteEmployee: RpcUnaryMethod<typeof WS_METHODS.organizationEmployeesInvite>;
    readonly acceptEmployeeInvite: RpcUnaryMethod<
      typeof WS_METHODS.organizationEmployeesAcceptInvite
    >;
    readonly listEmployees: RpcUnaryMethod<typeof WS_METHODS.organizationEmployeesList>;
    readonly updateEmployee: RpcUnaryMethod<typeof WS_METHODS.organizationEmployeesUpdate>;
    readonly disableEmployee: RpcUnaryMethod<typeof WS_METHODS.organizationEmployeesDisable>;
    readonly createTeam: RpcUnaryMethod<typeof WS_METHODS.organizationTeamsCreate>;
    readonly createDepartment: RpcUnaryMethod<typeof WS_METHODS.organizationDepartmentsCreate>;
    readonly grantAccess: RpcUnaryMethod<typeof WS_METHODS.organizationAccessGrant>;
    readonly revokeAccess: RpcUnaryMethod<typeof WS_METHODS.organizationAccessRevoke>;
    readonly createAccessReview: RpcUnaryMethod<typeof WS_METHODS.organizationAccessReviewCreate>;
    readonly completeAccessReview: RpcUnaryMethod<
      typeof WS_METHODS.organizationAccessReviewComplete
    >;
    readonly listAuditEvents: RpcUnaryMethod<typeof WS_METHODS.organizationAuditList>;
  };
  readonly providerAccounts: {
    readonly list: RpcUnaryNoArgMethod<typeof WS_METHODS.providerAccountsList>;
    readonly connect: RpcUnaryMethod<typeof WS_METHODS.providerAccountsConnect>;
    readonly openAuthTerminal: RpcUnaryMethod<typeof WS_METHODS.providerAccountsOpenAuthTerminal>;
    readonly confirm: RpcUnaryMethod<typeof WS_METHODS.providerAccountsConfirm>;
    readonly disconnect: RpcUnaryMethod<typeof WS_METHODS.providerAccountsDisconnect>;
  };
  readonly providerSharing: {
    readonly getOverview: RpcUnaryMethod<typeof WS_METHODS.providerSharingOverviewGet>;
    readonly updateShare: RpcUnaryMethod<typeof WS_METHODS.providerSharingShareUpdate>;
    readonly updatePolicy: RpcUnaryMethod<typeof WS_METHODS.providerSharingPolicyUpdate>;
    readonly updateMember: RpcUnaryMethod<typeof WS_METHODS.providerSharingMemberUpdate>;
  };
  readonly providerUsage: {
    readonly createRequest: RpcUnaryMethod<typeof WS_METHODS.providerUsageRequestCreate>;
    readonly listRequests: RpcUnaryMethod<typeof WS_METHODS.providerUsageRequestList>;
    readonly respondToRequest: RpcUnaryMethod<typeof WS_METHODS.providerUsageRequestRespond>;
    readonly withdrawRequest: RpcUnaryMethod<typeof WS_METHODS.providerUsageRequestWithdraw>;
  };
  readonly cloudSync: {
    /** `sync` is null for a project nobody ever shared; that is not an error. */
    readonly getStatus: RpcUnaryMethod<typeof WS_METHODS.cloudSyncStatusGet>;
    /** Refuses with `mode-locked` rather than reinterpreting a sync already running. */
    readonly start: RpcUnaryMethod<typeof WS_METHODS.cloudSyncStart>;
    readonly pause: RpcUnaryMethod<typeof WS_METHODS.cloudSyncPause>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.cloudSyncStop>;
    readonly listConflicts: RpcUnaryMethod<typeof WS_METHODS.cloudSyncConflictsList>;
    /** Records that a person dealt with it. Neither copy is deleted. */
    readonly resolveConflict: RpcUnaryMethod<typeof WS_METHODS.cloudSyncConflictsResolve>;
  };
  readonly shareLinks: {
    /** The only call that ever yields a token; `list` never returns one again. */
    readonly create: RpcUnaryMethod<typeof WS_METHODS.shareLinksCreate>;
    readonly list: RpcUnaryMethod<typeof WS_METHODS.shareLinksList>;
    readonly revoke: RpcUnaryMethod<typeof WS_METHODS.shareLinksRevoke>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
}

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          listener,
          options,
        ),
    },
    projects: {
      listDirectory: (input) =>
        transport.request((client) => client[WS_METHODS.projectsListDirectory](input)),
      readFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadFile](input)),
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
      createEntry: (input) =>
        transport.request((client) => client[WS_METHODS.projectsCreateEntry](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.gitRefreshStatus](input)),
      getWorkingTreeDiff: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetWorkingTreeDiff](input)),
      onStatus: (input, listener, options) => {
        let current: GitStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeGitStatus](input),
          (event: GitStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          options,
        );
      },
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      mergeBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitMergeBranch](input)),
      compareBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitCompareBranches](input)),
      getMergeState: (input) =>
        transport.request((client) => client[WS_METHODS.gitGetMergeState](input)),
      abortMerge: (input) => transport.request((client) => client[WS_METHODS.gitAbortMerge](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      subscribeConfig: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener,
          options,
        ),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener,
          options,
        ),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeAuthAccess]({}),
          listener,
          options,
        ),
    },
    collaboration: {
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
      recordSharedPrompt: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationSharedPromptRecord](input)),
      listActivity: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationActivityList](input)),
      getSettings: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationSettingsGet](input)),
      updateSettings: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationSettingsUpdate](input)),
      submitApproval: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationApprovalsSubmit](input)),
      listApprovals: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationApprovalsList](input)),
      decideApproval: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationApprovalsDecide](input)),
      getViewPreferences: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationViewGet](input)),
      updateViewPreferences: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationViewUpdate](input)),
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
      setActivityVisibility: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationActivityVisibility](input)),
      listMembers: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationMembersList](input)),
      updateMember: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationMembersUpdate](input)),
      removeMember: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationMembersRemove](input)),
      recordUsage: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationUsageRecord](input)),
      queryUsage: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationUsageQuery](input)),
      getConsent: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationConsentGet](input)),
      updateConsent: (input) =>
        transport.request((client) => client[WS_METHODS.collaborationConsentUpdate](input)),
      subscribe: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeCollaboration](input),
          listener,
          options,
        ),
    },
    analytics: {
      listStreams: (input) =>
        transport.request((client) => client[WS_METHODS.analyticsListStreams](input)),
      declareStream: (input) =>
        transport.request((client) => client[WS_METHODS.analyticsDeclareStream](input)),
      query: (input) => transport.request((client) => client[WS_METHODS.analyticsQuery](input)),
    },
    deploys: {
      listDeployments: (input) =>
        transport.request((client) => client[WS_METHODS.deployListDeployments](input)),
    },
    packs: {
      publish: (input) => transport.request((client) => client[WS_METHODS.packsPublish](input)),
      recordVersion: (input) =>
        transport.request((client) => client[WS_METHODS.packsRecordVersion](input)),
      search: (input) => transport.request((client) => client[WS_METHODS.packsSearch](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.packsGet](input)),
      listVersions: (input) =>
        transport.request((client) => client[WS_METHODS.packsListVersions](input)),
      setVisibility: (input) =>
        transport.request((client) => client[WS_METHODS.packsSetVisibility](input)),
      enable: (input) => transport.request((client) => client[WS_METHODS.packsEnable](input)),
      disable: (input) => transport.request((client) => client[WS_METHODS.packsDisable](input)),
      listEnablements: (input) =>
        transport.request((client) => client[WS_METHODS.packsListEnablements](input)),
      subscribe: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribePacks](input),
          listener,
          options,
        ),
    },
    workspaces: {
      create: (input) => transport.request((client) => client[WS_METHODS.workspacesCreate](input)),
    },
    organizations: {
      create: (input) =>
        transport.request((client) => client[WS_METHODS.organizationsCreate](input)),
      list: () => transport.request((client) => client[WS_METHODS.organizationsList]({})),
      inviteEmployee: (input) =>
        transport.request((client) => client[WS_METHODS.organizationEmployeesInvite](input)),
      acceptEmployeeInvite: (input) =>
        transport.request((client) => client[WS_METHODS.organizationEmployeesAcceptInvite](input)),
      listEmployees: (input) =>
        transport.request((client) => client[WS_METHODS.organizationEmployeesList](input)),
      updateEmployee: (input) =>
        transport.request((client) => client[WS_METHODS.organizationEmployeesUpdate](input)),
      disableEmployee: (input) =>
        transport.request((client) => client[WS_METHODS.organizationEmployeesDisable](input)),
      createTeam: (input) =>
        transport.request((client) => client[WS_METHODS.organizationTeamsCreate](input)),
      createDepartment: (input) =>
        transport.request((client) => client[WS_METHODS.organizationDepartmentsCreate](input)),
      grantAccess: (input) =>
        transport.request((client) => client[WS_METHODS.organizationAccessGrant](input)),
      revokeAccess: (input) =>
        transport.request((client) => client[WS_METHODS.organizationAccessRevoke](input)),
      createAccessReview: (input) =>
        transport.request((client) => client[WS_METHODS.organizationAccessReviewCreate](input)),
      completeAccessReview: (input) =>
        transport.request((client) => client[WS_METHODS.organizationAccessReviewComplete](input)),
      listAuditEvents: (input) =>
        transport.request((client) => client[WS_METHODS.organizationAuditList](input)),
    },
    providerAccounts: {
      list: () => transport.request((client) => client[WS_METHODS.providerAccountsList]({})),
      connect: (input) =>
        transport.request((client) => client[WS_METHODS.providerAccountsConnect](input)),
      openAuthTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.providerAccountsOpenAuthTerminal](input)),
      confirm: (input) =>
        transport.request((client) => client[WS_METHODS.providerAccountsConfirm](input)),
      disconnect: (input) =>
        transport.request((client) => client[WS_METHODS.providerAccountsDisconnect](input)),
    },
    providerSharing: {
      getOverview: (input) =>
        transport.request((client) => client[WS_METHODS.providerSharingOverviewGet](input)),
      updateShare: (input) =>
        transport.request((client) => client[WS_METHODS.providerSharingShareUpdate](input)),
      updatePolicy: (input) =>
        transport.request((client) => client[WS_METHODS.providerSharingPolicyUpdate](input)),
      updateMember: (input) =>
        transport.request((client) => client[WS_METHODS.providerSharingMemberUpdate](input)),
    },
    providerUsage: {
      createRequest: (input) =>
        transport.request((client) => client[WS_METHODS.providerUsageRequestCreate](input)),
      listRequests: (input) =>
        transport.request((client) => client[WS_METHODS.providerUsageRequestList](input)),
      respondToRequest: (input) =>
        transport.request((client) => client[WS_METHODS.providerUsageRequestRespond](input)),
      withdrawRequest: (input) =>
        transport.request((client) => client[WS_METHODS.providerUsageRequestWithdraw](input)),
    },
    cloudSync: {
      getStatus: (input) =>
        transport.request((client) => client[WS_METHODS.cloudSyncStatusGet](input)),
      start: (input) => transport.request((client) => client[WS_METHODS.cloudSyncStart](input)),
      pause: (input) => transport.request((client) => client[WS_METHODS.cloudSyncPause](input)),
      stop: (input) => transport.request((client) => client[WS_METHODS.cloudSyncStop](input)),
      listConflicts: (input) =>
        transport.request((client) => client[WS_METHODS.cloudSyncConflictsList](input)),
      resolveConflict: (input) =>
        transport.request((client) => client[WS_METHODS.cloudSyncConflictsResolve](input)),
    },
    shareLinks: {
      create: (input) => transport.request((client) => client[WS_METHODS.shareLinksCreate](input)),
      list: (input) => transport.request((client) => client[WS_METHODS.shareLinksList](input)),
      revoke: (input) => transport.request((client) => client[WS_METHODS.shareLinksRevoke](input)),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          options,
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          options,
        ),
    },
  };
}
