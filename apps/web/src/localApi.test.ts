import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EnvironmentId,
  type GitStatusResult,
  ProjectId,
  type OrchestrationShellStreamItem,
  ProviderAccountId,
  type ServerConfig,
  type ServerProvider,
  type TerminalEvent,
  ThreadId,
  TenantId,
  UserId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@t3tools/contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
const shellStreamListeners = new Set<(event: OrchestrationShellStreamItem) => void>();
const gitStatusListeners = new Set<(event: GitStatusResult) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  projects: {
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  filesystem: {
    browse: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
  },
  git: {
    pull: vi.fn(),
    refreshStatus: vi.fn(),
    onStatus: vi.fn((input: { cwd: string }, listener: (event: GitStatusResult) => void) =>
      registerListener(gitStatusListeners, listener),
    ),
    runStackedAction: vi.fn(),
    listBranches: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    init: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
    subscribeAuthAccess: vi.fn(),
  },
  orchestration: {
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    subscribeShell: vi.fn((listener: (event: OrchestrationShellStreamItem) => void) =>
      registerListener(shellStreamListeners, listener),
    ),
    subscribeThread: vi.fn(() => () => undefined),
  },
  collaboration: {
    upsertPresence: vi.fn(),
    listPresence: vi.fn(),
    createInvite: vi.fn(),
    listInvites: vi.fn(),
    acceptInvite: vi.fn(),
    revokeInvite: vi.fn(),
    recordSharedPrompt: vi.fn(),
    listActivity: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
  providerSharing: {
    getOverview: vi.fn(),
    updateShare: vi.fn(),
    updatePolicy: vi.fn(),
    updateMember: vi.fn(),
  },
  providerUsage: {
    createRequest: vi.fn(),
    listRequests: vi.fn(),
    respondToRequest: vi.fn(),
    withdrawRequest: vi.fn(),
  },
  shareLinks: {
    create: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
  },
  analytics: {
    listStreams: vi.fn(),
    query: vi.fn(),
  },
  deploys: {
    listDeployments: vi.fn(),
  },
  packs: {
    publish: vi.fn(),
    recordVersion: vi.fn(),
    search: vi.fn(),
    get: vi.fn(),
    listVersions: vi.fn(),
    setVisibility: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    listEnablements: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
  organizations: {
    create: vi.fn(),
    list: vi.fn(),
    inviteEmployee: vi.fn(),
    acceptEmployeeInvite: vi.fn(),
    listEmployees: vi.fn(),
    updateEmployee: vi.fn(),
    disableEmployee: vi.fn(),
    createTeam: vi.fn(),
    createDepartment: vi.fn(),
    grantAccess: vi.fn(),
    createAccessReview: vi.fn(),
    listAuditEvents: vi.fn(),
  },
  providerAccounts: {
    list: vi.fn(),
    connect: vi.fn(),
    openAuthTerminal: vi.fn(),
    confirm: vi.fn(),
    disconnect: vi.fn(),
  },
};

vi.mock("./environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Primary",
      source: "manual" as const,
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
      environmentId: EnvironmentId.make("environment-local"),
    },
    client: rpcClientMock,
    environmentId: EnvironmentId.make("environment-local"),
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
}));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getAppBranding: () => null,
    getLocalEnvironmentBootstrap: () => null,
    getClientSettings: async () => null,
    setClientSettings: async () => undefined,
    getSavedEnvironmentRegistry: async () => [],
    setSavedEnvironmentRegistry: async () => undefined,
    getSavedEnvironmentSecret: async () => null,
    setSavedEnvironmentSecret: async () => true,
    removeSavedEnvironmentSecret: async () => undefined,
    getServerExposureState: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
    }),
    setServerExposureMode: async () => ({
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
    }),
    getWorkspaceShareState: async () => ({
      status: "not-shared",
      url: null,
      failureReason: null,
      diagnostics: null,
    }),
    startWorkspaceShare: async () => ({
      status: "not-shared",
      url: null,
      failureReason: null,
      diagnostics: null,
    }),
    stopWorkspaceShare: async () => ({
      status: "not-shared",
      url: null,
      failureReason: null,
      diagnostics: null,
    }),
    onWorkspaceShareState: () => () => undefined,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    writeClipboardText: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    setUpdateChannel: async () => {
      throw new Error("setUpdateChannel not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

const baseEnvironment = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

const baseServerConfig: ServerConfig = {
  environment: baseEnvironment,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const baseGitStatus: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/streamed",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  terminalEventListeners.clear();
  shellStreamListeners.clear();
  gitStatusListeners.clear();
  const testWindow = getWindowForTest();
  Reflect.deleteProperty(testWindow, "desktopBridge");
  Object.defineProperty(testWindow, "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsApi", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards terminal and shell stream events", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onTerminalEvent = vi.fn();
    const onShellEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.subscribeShell(onShellEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitEvent(terminalEventListeners, terminalEvent);

    const shellEvent = {
      kind: "project-upserted" as const,
      sequence: 1,
      project: {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies OrchestrationShellStreamItem;
    emitEvent(shellStreamListeners, shellEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onShellEvent).toHaveBeenCalledWith(shellEvent);
  });

  it("forwards git status stream events", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onStatus = vi.fn();

    api.git.onStatus({ cwd: "/repo" }, onStatus);

    const gitStatus = baseGitStatus;
    emitEvent(gitStatusListeners, gitStatus);

    expect(rpcClientMock.git.onStatus).toHaveBeenCalledWith({ cwd: "/repo" }, onStatus, undefined);
    expect(onStatus).toHaveBeenCalledWith(gitStatus);
  });

  it("forwards git status refreshes directly to the RPC client", async () => {
    rpcClientMock.git.refreshStatus.mockResolvedValue(baseGitStatus);
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);

    await api.git.refreshStatus({ cwd: "/repo" });

    expect(rpcClientMock.git.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("forwards shell stream subscription options to the RPC client", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onShellEvent = vi.fn();
    const onResubscribe = vi.fn();

    api.orchestration.subscribeShell(onShellEvent, { onResubscribe });

    expect(rpcClientMock.orchestration.subscribeShell).toHaveBeenCalledWith(onShellEvent, {
      onResubscribe,
    });
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const command = {
      type: "project.create",
      commandId: CommandId.make("cmd-1"),
      projectId: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards filesystem browse requests to the RPC client", async () => {
    rpcClientMock.filesystem.browse.mockResolvedValue({
      parentPath: "/tmp/project/",
      entries: [],
    });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.filesystem.browse({
      partialPath: "/tmp/project/",
      cwd: "/tmp/project",
    });

    expect(rpcClientMock.filesystem.browse).toHaveBeenCalledWith({
      partialPath: "/tmp/project/",
      cwd: "/tmp/project",
    });
  });

  it("forwards provider account status and disconnect requests to the RPC client", async () => {
    rpcClientMock.providerAccounts.list.mockResolvedValue({ accounts: [] });
    rpcClientMock.providerAccounts.connect.mockResolvedValue({
      instructions: {
        provider: "codex",
        authCommand: "codex login --device-auth",
        statusCommand: "codex login status",
        verificationHint: "Verify Codex after the device-auth flow completes.",
        steps: ["Run the Codex device-auth flow."],
      },
    });
    rpcClientMock.providerAccounts.openAuthTerminal.mockResolvedValue({
      instructions: {
        provider: "codex",
        authCommand: "codex login --device-auth",
        statusCommand: "codex login status",
        verificationHint: "Verify Codex after the device-auth flow completes.",
        steps: ["Run the Codex device-auth flow."],
      },
      terminal: {
        threadId: "thread-1",
        terminalId: "provider-auth-codex",
        cwd: "/tenant/provider-homes/user/codex",
        worktreePath: null,
        status: "running",
        pid: 12_345,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-05-09T01:00:00.000Z",
      },
    });
    rpcClientMock.providerAccounts.confirm.mockResolvedValue({
      account: {
        id: ProviderAccountId.make("provider-account-1"),
        provider: "codex",
        tenantId: TenantId.make("tenant-1"),
        owner: { type: "user", userId: UserId.make("user-1") },
        sharing: "private",
        status: "connected",
        createdAt: "2026-05-09T01:00:00.000Z",
        disabledAt: null,
        activeSessionCount: 1,
      },
    });
    rpcClientMock.providerAccounts.disconnect.mockResolvedValue({
      account: {
        id: ProviderAccountId.make("provider-account-1"),
        provider: "codex",
        tenantId: TenantId.make("tenant-1"),
        owner: { type: "user", userId: UserId.make("user-1") },
        sharing: "private",
        status: "disabled",
        createdAt: "2026-05-09T01:00:00.000Z",
        disabledAt: "2026-05-09T01:10:00.000Z",
        activeSessionCount: 0,
      },
    });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.providerAccounts.list();
    await api.providerAccounts.connect({ provider: "codex" });
    await api.providerAccounts.openAuthTerminal({
      provider: "codex",
      threadId: ThreadId.make("thread-1"),
    });
    await api.providerAccounts.confirm({
      provider: "codex",
      threadId: ThreadId.make("thread-1"),
      statusOutput: "Logged in",
    });
    await api.providerAccounts.disconnect({
      providerAccountId: ProviderAccountId.make("provider-account-1"),
    });

    expect(rpcClientMock.providerAccounts.list).toHaveBeenCalledWith();
    expect(rpcClientMock.providerAccounts.connect).toHaveBeenCalledWith({ provider: "codex" });
    expect(rpcClientMock.providerAccounts.openAuthTerminal).toHaveBeenCalledWith({
      provider: "codex",
      threadId: ThreadId.make("thread-1"),
    });
    expect(rpcClientMock.providerAccounts.confirm).toHaveBeenCalledWith({
      provider: "codex",
      threadId: ThreadId.make("thread-1"),
      statusOutput: "Logged in",
    });
    expect(rpcClientMock.providerAccounts.disconnect).toHaveBeenCalledWith({
      providerAccountId: ProviderAccountId.make("provider-account-1"),
    });
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
    rpcClientMock.orchestration.getFullThreadDiff.mockResolvedValue({ diff: "patch" });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.make("thread-1"),
      toTurnCount: 1,
    });

    expect(rpcClientMock.orchestration.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("forwards folder picker options to the desktop bridge", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    getWindowForTest().desktopBridge = makeDesktopBridge({ pickFolder });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await expect(api.dialogs.pickFolder({ initialPath: "/tmp/workspace" })).resolves.toBe(
      "/tmp/project",
    );
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp/workspace" });
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("reads and writes persistence through the desktop bridge when available", async () => {
    const clientSettings = {
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      desktopLayoutMode: "dev" as const,
      desktopLayoutModesJson: "",
      desktopLayoutAutoOpenToast: true,
      diffWordWrap: true,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadSortOrder: "created_at" as const,
      timestampFormat: "24-hour" as const,
    };
    const getClientSettings = vi.fn().mockResolvedValue({
      ...clientSettings,
    });
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    const getSavedEnvironmentRegistry = vi.fn().mockResolvedValue([]);
    const setSavedEnvironmentRegistry = vi.fn().mockResolvedValue(undefined);
    const getSavedEnvironmentSecret = vi.fn().mockResolvedValue("bearer-token");
    const setSavedEnvironmentSecret = vi.fn().mockResolvedValue(true);
    const removeSavedEnvironmentSecret = vi.fn().mockResolvedValue(undefined);
    getWindowForTest().desktopBridge = makeDesktopBridge({
      getClientSettings,
      setClientSettings,
      getSavedEnvironmentRegistry,
      setSavedEnvironmentRegistry,
      getSavedEnvironmentSecret,
      setSavedEnvironmentSecret,
      removeSavedEnvironmentSecret,
    });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await api.persistence.getClientSettings();
    await api.persistence.setClientSettings(clientSettings);
    await api.persistence.getSavedEnvironmentRegistry();
    await api.persistence.setSavedEnvironmentRegistry([]);
    await api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local"));
    await api.persistence.setSavedEnvironmentSecret(
      EnvironmentId.make("environment-local"),
      "bearer-token",
    );
    await api.persistence.removeSavedEnvironmentSecret(EnvironmentId.make("environment-local"));

    expect(getClientSettings).toHaveBeenCalledWith();
    expect(setClientSettings).toHaveBeenCalledWith(clientSettings);
    expect(getSavedEnvironmentRegistry).toHaveBeenCalledWith();
    expect(setSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(getSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local");
    expect(setSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local", "bearer-token");
    expect(removeSavedEnvironmentSecret).toHaveBeenCalledWith("environment-local");
  });

  it("falls back to browser storage for persistence when the desktop bridge is missing", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const clientSettings = {
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      desktopLayoutMode: "dev" as const,
      desktopLayoutModesJson: "",
      desktopLayoutAutoOpenToast: true,
      diffWordWrap: true,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadSortOrder: "created_at" as const,
      timestampFormat: "24-hour" as const,
    };

    await api.persistence.setClientSettings(clientSettings);
    await api.persistence.setSavedEnvironmentRegistry([
      {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Primary",
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);
    await api.persistence.setSavedEnvironmentSecret(
      EnvironmentId.make("environment-local"),
      "bearer-token",
    );

    await expect(api.persistence.getClientSettings()).resolves.toEqual(clientSettings);
    await expect(api.persistence.getSavedEnvironmentRegistry()).resolves.toEqual([
      {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Primary",
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);
    await expect(
      api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local")),
    ).resolves.toBe("bearer-token");

    await api.persistence.removeSavedEnvironmentSecret(EnvironmentId.make("environment-local"));

    await expect(
      api.persistence.getSavedEnvironmentSecret(EnvironmentId.make("environment-local")),
    ).resolves.toBeNull();
  });
});
