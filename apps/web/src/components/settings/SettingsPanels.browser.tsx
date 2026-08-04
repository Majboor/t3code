import "../../index.css";

import {
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderAccountId,
  type DesktopBridge,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type LocalApi,
  ProjectId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetLocalApiForTests } from "../../localApi";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  readSupabaseBrowserAccessToken,
  writePrimaryEnvironmentDescriptor,
  writeSupabaseBrowserAccessToken,
} from "../../environments/primary";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { AccountSettingsPanel, GeneralSettingsPanel } from "./SettingsPanels";

const authAccessHarness = vi.hoisted(() => {
  type Snapshot = AuthAccessSnapshot;
  let snapshot: Snapshot = {
    pairingLinks: [],
    clientSessions: [],
  };
  let revision = 1;
  const listeners = new Set<(event: AuthAccessStreamEvent) => void>();

  const emitEvent = (event: AuthAccessStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    reset() {
      snapshot = {
        pairingLinks: [],
        clientSessions: [],
      };
      revision = 1;
      listeners.clear();
    },
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    emitSnapshot() {
      emitEvent({
        version: 1 as const,
        revision,
        type: "snapshot" as const,
        payload: snapshot,
      });
      revision += 1;
    },
    emitEvent,
    emitPairingLinkUpserted(pairingLink: Snapshot["pairingLinks"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: pairingLink,
      });
      revision += 1;
    },
    emitPairingLinkRemoved(id: string) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id },
      });
      revision += 1;
    },
    emitClientUpserted(clientSession: Snapshot["clientSessions"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "clientUpserted",
        payload: clientSession,
      });
      revision += 1;
    },
    emitClientRemoved(sessionId: string) {
      emitEvent({
        version: 1,
        revision,
        type: "clientRemoved",
        payload: {
          sessionId: AuthSessionId.make(sessionId),
        },
      });
      revision += 1;
    },
    subscribe(listener: (event: AuthAccessStreamEvent) => void) {
      listeners.add(listener);
      listener({
        version: 1,
        revision: 1,
        type: "snapshot",
        payload: snapshot,
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        subscribeAuthAccess: (listener: Parameters<typeof authAccessHarness.subscribe>[0]) =>
          authAccessHarness.subscribe(listener),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    resetSavedEnvironmentRegistryStoreForTests: () => undefined,
    resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
    resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
      new URL(path, "http://localhost:3000").toString(),
    waitForSavedEnvironmentRegistryHydration: async () => undefined,
    addSavedEnvironment: vi.fn(),
    disconnectSavedEnvironment: vi.fn(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    reconnectSavedEnvironment: vi.fn(),
    removeSavedEnvironment: vi.fn(),
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRegistryStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(Date.parse(value));
}

async function clearBrowserState() {
  localStorage.clear();
  sessionStorage.clear();
  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
  }
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  });

  if ("indexedDB" in window && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.addEventListener("success", () => resolve());
              request.addEventListener("error", () => resolve());
              request.addEventListener("blocked", () => resolve());
            }),
        ),
    );
  }
}

function makePairingLink(input: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): AuthAccessSnapshot["pairingLinks"][number] {
  return {
    ...input,
    createdAt: makeUtc(input.createdAt),
    expiresAt: makeUtc(input.expiresAt),
  };
}

function makeClientSession(input: {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie";
  readonly client?: {
    readonly label?: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
    readonly deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly os?: string;
    readonly browser?: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt?: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}): AuthAccessSnapshot["clientSessions"][number] {
  return {
    ...input,
    client: {
      deviceType: "unknown",
      ...input.client,
    },
    sessionId: AuthSessionId.make(input.sessionId),
    issuedAt: makeUtc(input.issuedAt),
    expiresAt: makeUtc(input.expiresAt),
    lastConnectedAt:
      input.lastConnectedAt === undefined || input.lastConnectedAt === null
        ? null
        : makeUtc(input.lastConnectedAt),
  };
}

const createDesktopBridgeStub = (overrides?: {
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
  readonly setServerExposureMode?: DesktopBridge["setServerExposureMode"];
  readonly setUpdateChannel?: DesktopBridge["setUpdateChannel"];
}): DesktopBridge => {
  const idleUpdateState: DesktopUpdateState = {
    enabled: false,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.0-test",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  return {
    getAppBranding: vi.fn().mockReturnValue(null),
    getLocalEnvironmentBootstrap: () => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "desktop-bootstrap-token",
    }),
    getClientSettings: vi.fn().mockResolvedValue(null),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
    setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
    setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
    removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
      })),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(true),
    onMenuAction: () => () => {},
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    setUpdateChannel:
      overrides?.setUpdateChannel ??
      vi.fn().mockImplementation(async (channel: DesktopUpdateChannel) => ({
        ...idleUpdateState,
        channel,
      })),
    checkForUpdate: vi.fn().mockResolvedValue({ checked: false, state: idleUpdateState }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    onUpdateState: () => () => {},
  };
};

describe("GeneralSettingsPanel observability", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    __resetEnvironmentApiOverridesForTests();
    await clearBrowserState();
    writePrimaryEnvironmentDescriptor(createBaseServerConfig().environment);
    authAccessHarness.reset();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    __resetEnvironmentApiOverridesForTests();
    writePrimaryEnvironmentDescriptor(null);
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    authAccessHarness.reset();
  });

  it("hides owner pairing tools in browser-served loopback builds without remote exposure", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        makeClientSession({
          sessionId: "session-owner",
          subject: "browser-owner",
          role: "owner",
          method: "browser-session-cookie",
          client: {
            label: "Chrome on Mac",
            deviceType: "desktop",
            os: "macOS",
            browser: "Chrome",
            ipAddress: "127.0.0.1",
          },
          issuedAt: "2036-04-07T00:00:00.000Z",
          expiresAt: "2036-05-07T00:00:00.000Z",
          connected: true,
          current: true,
        }),
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Manage local backend")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Enable network access")).toBeDisabled();
    await expect
      .element(
        page.getByText(
          "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText("Authorized clients")).not.toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Mac")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Remote environments", exact: true }))
      .toBeInTheDocument();
  });

  it("shows diagnostics inside About with a single logs-folder action", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect.element(page.getByText("Diagnostics")).toBeInTheDocument();
    await expect.element(page.getByText("Open logs folder")).toBeInTheDocument();
    await expect
      .element(page.getByText("/repo/project/.t3/logs", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. OTLP exporting traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
      },
    });
    let pairingLinks: Array<AuthAccessSnapshot["pairingLinks"][number]> = [];
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: true,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks,
      clientSessions,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/pairing-token") && method === "POST") {
          pairingLinks = [
            makePairingLink({
              id: "pairing-link-1",
              credential: "pairing-token",
              role: "client",
              subject: "one-time-token",
              label: "Julius iPhone",
              createdAt: "2036-04-07T00:00:00.000Z",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
          ];
          clientSessions = [
            ...clientSessions,
            makeClientSession({
              sessionId: "session-client",
              subject: "one-time-token",
              role: "client",
              method: "browser-session-cookie",
              client: {
                label: "Julius iPhone",
                deviceType: "mobile",
                os: "iOS",
                browser: "Safari",
                ipAddress: "192.168.1.88",
              },
              issuedAt: "2036-04-07T00:01:00.000Z",
              expiresAt: "2036-05-07T00:01:00.000Z",
              connected: false,
              current: false,
            }),
          ];
          authAccessHarness.setSnapshot({
            pairingLinks,
            clientSessions,
          });
          return new Response(
            JSON.stringify({
              id: "pairing-link-1",
              credential: "pairing-token",
              label: "Julius iPhone",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unhandled fetch ${method} ${url}`);
      }),
    );

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Authorized clients")).toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect.element(page.getByText("Create pairing link")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    authAccessHarness.emitPairingLinkUpserted(pairingLinks[0]!);
    authAccessHarness.emitClientUpserted(clientSessions[1]!);
    await expect
      .element(page.getByText("Client · Mobile · iOS · Safari · 192.168.1.88"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^(Copy|Show link)$/ }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
  });

  it("revokes all other paired clients from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
      },
    });
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: false,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions,
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/clients/revoke-others") && method === "POST") {
        clientSessions = clientSessions.filter((session) => session.current);
        authAccessHarness.setSnapshot({
          pairingLinks: [],
          clientSessions,
        });
        authAccessHarness.emitClientRemoved("session-client");
        return new Response(JSON.stringify({ revokedCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    await page.getByRole("button", { name: "Revoke others", exact: true }).click();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await expect.element(page.getByText("Julius iPhone")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("loads and clears a stored Supabase browser session from account settings", async () => {
    await clearBrowserState();
    writeSupabaseBrowserAccessToken("stored-supabase-settings-token");
    const uniqueEmail = `settings-supabase-${Date.now()}@example.test`;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/api/auth/profile")) {
        expect(headers.get("authorization")).toBe("Bearer stored-supabase-settings-token");
        if (init?.method === "PATCH") {
          expect(JSON.parse(String(init.body))).toEqual({
            displayName: "Updated Settings User",
            avatarInitials: "US",
          });
          return new Response(
            JSON.stringify({
              userId: "supabase:settings-browser-user",
              subject: uniqueEmail,
              displayName: "Updated Settings User",
              avatarInitials: "US",
              role: "client",
              sessionId: "supabase:settings-browser-user",
              sessionMethod: "bearer-session-token",
              client: {
                deviceType: "browser",
                browser: "Chromium",
              },
              expiresAt: "2036-05-07T00:00:00.000Z",
              tenantStatus: "active",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            userId: "supabase:settings-browser-user",
            subject: uniqueEmail,
            displayName: "Settings Supabase User",
            avatarInitials: "SU",
            role: "client",
            sessionId: "supabase:settings-browser-user",
            sessionMethod: "bearer-session-token",
            client: {
              deviceType: "browser",
              browser: "Chromium",
            },
            expiresAt: "2036-05-07T00:00:00.000Z",
            tenantStatus: "active",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(<AccountSettingsPanel />);

    await expect.element(page.getByText("Settings Supabase User")).toBeInTheDocument();
    await expect.element(page.getByText(uniqueEmail)).toBeInTheDocument();
    await page.getByLabelText("Display name").fill("Updated Settings User");
    await page.getByLabelText("Avatar").fill("US");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect.element(page.getByText("Account profile updated.")).toBeInTheDocument();
    await expect.element(page.getByText("Updated Settings User")).toBeInTheDocument();
    await page.getByRole("button", { name: "Sign out of Supabase" }).click();
    expect(readSupabaseBrowserAccessToken()).toBeNull();
    await expect
      .element(page.getByText("Supabase browser session removed. Sign in again to reconnect."))
      .toBeInTheDocument();
    await expect.element(page.getByText("Settings Supabase User")).not.toBeInTheDocument();
  });

  it("opens provider auth terminal, confirms status, and disconnects through the environment API", async () => {
    await clearBrowserState();
    const uniqueEmail = `provider-settings-${Date.now()}@example.test`;
    const accountId = ProviderAccountId.make("provider-account-settings-browser");
    const environmentId = EnvironmentId.make("environment-local");
    const projectId = ProjectId.make("provider-settings-project");
    const threadId = ThreadId.make("provider-settings-thread");
    useStore.setState({
      activeEnvironmentId: environmentId,
      environmentStateById: {
        [environmentId]: {
          projectIds: [projectId],
          projectById: {
            [projectId]: {
              id: projectId,
              environmentId,
              name: "Provider settings project",
              cwd: "/repo/project",
              defaultModelSelection: null,
              scripts: [],
            },
          },
          threadIds: [threadId],
          threadIdsByProjectId: { [projectId]: [threadId] },
          threadShellById: {
            [threadId]: {
              id: threadId,
              environmentId,
              codexThreadId: null,
              projectId,
              title: "Provider settings thread",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              runtimeMode: "full-access",
              interactionMode: "default",
              error: null,
              createdAt: "2026-05-09T00:00:00.000Z",
              updatedAt: "2026-05-09T00:05:00.000Z",
              archivedAt: null,
              branch: null,
              worktreePath: null,
            },
          },
          threadSessionById: {},
          threadTurnStateById: {},
          messageIdsByThreadId: {},
          messageByThreadId: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
          proposedPlanIdsByThreadId: {},
          proposedPlanByThreadId: {},
          turnDiffIdsByThreadId: {},
          turnDiffSummaryByThreadId: {},
          sidebarThreadSummaryById: {},
          bootstrapComplete: true,
        },
      },
    });
    const providerAccounts = {
      list: vi.fn().mockResolvedValue({
        accounts: [],
      }),
      connect: vi.fn().mockResolvedValue({
        instructions: {
          provider: "codex",
          authCommand: "codex login --device-auth",
          statusCommand: "codex login status",
          verificationHint: "Start a hosted Codex turn after the device-auth flow completes.",
          steps: [
            "Open a hosted provider shell for this account.",
            "Run `codex login --device-auth`.",
          ],
        },
      }),
      openAuthTerminal: vi.fn().mockResolvedValue({
        instructions: {
          provider: "codex",
          authCommand: "codex login --device-auth",
          statusCommand: "codex login status",
          verificationHint: "Start a hosted Codex turn after the device-auth flow completes.",
          steps: [
            "Open a hosted provider shell for this account.",
            "Run `codex login --device-auth`.",
          ],
        },
        terminal: {
          threadId,
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
      }),
      confirm: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Codex status reported that the account is not logged in."),
        )
        .mockResolvedValueOnce({
          account: {
            id: accountId,
            provider: "codex",
            tenantId: "tenant-settings-browser",
            owner: { type: "user", userId: "supabase:provider-settings-browser-user" },
            sharing: "private",
            status: "connected",
            createdAt: "2026-05-09T01:00:00.000Z",
            disabledAt: null,
            activeSessionCount: 1,
          },
        }),
      disconnect: vi.fn().mockResolvedValue({
        account: {
          id: accountId,
          provider: "codex",
          tenantId: "tenant-settings-browser",
          owner: { type: "user", userId: "supabase:provider-settings-browser-user" },
          sharing: "private",
          status: "disabled",
          createdAt: "2026-05-09T01:00:00.000Z",
          disabledAt: "2026-05-09T01:10:00.000Z",
          activeSessionCount: 0,
        },
      }),
    };
    __setEnvironmentApiOverrideForTests(environmentId, {
      providerAccounts,
    } as never);

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/auth/profile")) {
        return new Response(
          JSON.stringify({
            userId: "supabase:provider-settings-browser-user",
            subject: uniqueEmail,
            displayName: "Provider Settings User",
            avatarInitials: "PS",
            role: "client",
            sessionId: "supabase:provider-settings-browser-user",
            sessionMethod: "bearer-session-token",
            client: {
              deviceType: "browser",
              browser: "Chromium",
            },
            expiresAt: "2036-05-07T00:00:00.000Z",
            tenantStatus: "active",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(<AccountSettingsPanel />);

    await expect.element(page.getByText("Provider Settings User")).toBeInTheDocument();
    await expect.element(page.getByText(uniqueEmail)).toBeInTheDocument();
    await expect.element(page.getByText("No provider accounts connected.")).toBeInTheDocument();
    await page.getByRole("button", { name: "Connect Codex" }).click();
    await expect.element(page.getByText("provider-auth-codex")).toBeInTheDocument();
    await expect
      .element(page.getByText("codex login --device-auth", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("codex login status", { exact: true })).toBeInTheDocument();
    const statusOutput = page.getByLabelText("Status output");
    await statusOutput.fill("Not logged in");
    await page.getByRole("button", { name: "Confirm status" }).click();
    await expect
      .element(page.getByText("Codex status reported that the account is not logged in."))
      .toBeInTheDocument();
    await statusOutput.fill("Logged in as provider-settings@example.test");
    await page.getByRole("button", { name: "Confirm status" }).click();
    await expect.element(page.getByText("Codex provider account connected.")).toBeInTheDocument();
    await expect.element(page.getByText("Connected, 1 active session")).toBeInTheDocument();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect.element(page.getByText("Disconnected", { exact: true })).toBeInTheDocument();
    expect(providerAccounts.list).toHaveBeenCalledWith();
    expect(providerAccounts.openAuthTerminal).toHaveBeenCalledWith({
      provider: "codex",
      threadId,
      accountScope: "personal",
    });
    expect(providerAccounts.connect).not.toHaveBeenCalled();
    expect(providerAccounts.confirm).toHaveBeenNthCalledWith(1, {
      provider: "codex",
      threadId,
      statusOutput: "Not logged in",
      accountScope: "personal",
    });
    expect(providerAccounts.confirm).toHaveBeenNthCalledWith(2, {
      provider: "codex",
      threadId,
      statusOutput: "Logged in as provider-settings@example.test",
      accountScope: "personal",
    });
    expect(providerAccounts.disconnect).toHaveBeenCalledWith({ providerAccountId: accountId });
  });

  it("shows provider account linking as an informative state on loopback backends", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    const environmentId = EnvironmentId.make("environment-local");
    useStore.setState({
      activeEnvironmentId: environmentId,
      environmentStateById: {},
    });
    const providerAccounts = {
      list: vi
        .fn()
        .mockRejectedValue(
          new Error("Provider account operations require a hosted tenant session."),
        ),
      connect: vi.fn(),
      openAuthTerminal: vi.fn(),
      confirm: vi.fn(),
      disconnect: vi.fn(),
    };
    __setEnvironmentApiOverrideForTests(environmentId, {
      providerAccounts,
    } as never);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Provider Accounts")).toBeInTheDocument();
    await expect
      .element(
        page.getByText("Provider account linking requires a hosted tenant session.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Connect Codex" }))
      .not.toBeInTheDocument();
    expect(providerAccounts.list).toHaveBeenCalledWith();
  });

  it("shows a disabled network access toggle with guidance in desktop builds", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    const networkAccessToggle = page.getByLabelText("Enable network access");
    await expect.element(networkAccessToggle).not.toBeDisabled();
    await networkAccessToggle.click();
    await expect.element(page.getByText("Enable network access?")).toBeInTheDocument();
    await expect
      .element(page.getByText("T3 Code will restart to expose this environment over the network."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and enable", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect
      .element(page.getByText("Reachable at http://192.168.1.44:3773"))
      .toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      shell: {
        openInEditor,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <GeneralSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByText("Open logs folder");
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });
});
