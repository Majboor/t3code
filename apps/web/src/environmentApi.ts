import type { EnvironmentId, EnvironmentApi } from "@t3tools/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      listDirectory: rpcClient.projects.listDirectory,
      readFile: rpcClient.projects.readFile,
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      createEntry: rpcClient.projects.createEntry,
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    git: {
      pull: rpcClient.git.pull,
      refreshStatus: rpcClient.git.refreshStatus,
      getWorkingTreeDiff: rpcClient.git.getWorkingTreeDiff,
      onStatus: (input, callback, options) => rpcClient.git.onStatus(input, callback, options),
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      mergeBranch: rpcClient.git.mergeBranch,
      compareBranches: rpcClient.git.compareBranches,
      getMergeState: rpcClient.git.getMergeState,
      abortMerge: rpcClient.git.abortMerge,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
    collaboration: {
      upsertPresence: rpcClient.collaboration.upsertPresence,
      listPresence: rpcClient.collaboration.listPresence,
      createInvite: rpcClient.collaboration.createInvite,
      listInvites: rpcClient.collaboration.listInvites,
      acceptInvite: rpcClient.collaboration.acceptInvite,
      revokeInvite: rpcClient.collaboration.revokeInvite,
      recordSharedPrompt: rpcClient.collaboration.recordSharedPrompt,
      listActivity: rpcClient.collaboration.listActivity,
      getSettings: rpcClient.collaboration.getSettings,
      updateSettings: rpcClient.collaboration.updateSettings,
      submitApproval: rpcClient.collaboration.submitApproval,
      listApprovals: rpcClient.collaboration.listApprovals,
      decideApproval: rpcClient.collaboration.decideApproval,
      getViewPreferences: rpcClient.collaboration.getViewPreferences,
      updateViewPreferences: rpcClient.collaboration.updateViewPreferences,
      claimBranch: rpcClient.collaboration.claimBranch,
      listBranchClaims: rpcClient.collaboration.listBranchClaims,
      releaseBranch: rpcClient.collaboration.releaseBranch,
      touchFiles: rpcClient.collaboration.touchFiles,
      listFileTouches: rpcClient.collaboration.listFileTouches,
      setActivityVisibility: rpcClient.collaboration.setActivityVisibility,
      listMembers: rpcClient.collaboration.listMembers,
      updateMember: rpcClient.collaboration.updateMember,
      removeMember: rpcClient.collaboration.removeMember,
      recordUsage: rpcClient.collaboration.recordUsage,
      getConsent: rpcClient.collaboration.getConsent,
      updateConsent: rpcClient.collaboration.updateConsent,
      subscribe: (input, callback, options) =>
        rpcClient.collaboration.subscribe(input, callback, options),
    },
    packs: {
      publish: rpcClient.packs.publish,
      recordVersion: rpcClient.packs.recordVersion,
      search: rpcClient.packs.search,
      get: rpcClient.packs.get,
      listVersions: rpcClient.packs.listVersions,
      setVisibility: rpcClient.packs.setVisibility,
      subscribe: (input, callback, options) => rpcClient.packs.subscribe(input, callback, options),
    },
    organizations: {
      create: rpcClient.organizations.create,
      list: rpcClient.organizations.list,
      inviteEmployee: rpcClient.organizations.inviteEmployee,
      acceptEmployeeInvite: rpcClient.organizations.acceptEmployeeInvite,
      listEmployees: rpcClient.organizations.listEmployees,
      updateEmployee: rpcClient.organizations.updateEmployee,
      disableEmployee: rpcClient.organizations.disableEmployee,
      createTeam: rpcClient.organizations.createTeam,
      createDepartment: rpcClient.organizations.createDepartment,
      grantAccess: rpcClient.organizations.grantAccess,
      createAccessReview: rpcClient.organizations.createAccessReview,
      completeAccessReview: rpcClient.organizations.completeAccessReview,
      listAuditEvents: rpcClient.organizations.listAuditEvents,
    },
    providerAccounts: {
      list: rpcClient.providerAccounts.list,
      connect: rpcClient.providerAccounts.connect,
      openAuthTerminal: rpcClient.providerAccounts.openAuthTerminal,
      confirm: rpcClient.providerAccounts.confirm,
      disconnect: rpcClient.providerAccounts.disconnect,
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client) : undefined;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
