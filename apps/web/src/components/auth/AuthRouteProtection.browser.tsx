import "../../index.css";

import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ServerAuthGateState } from "../../environments/primary";
import { getRouter } from "../../router";

const authHarness = vi.hoisted(() => {
  const requiresAuthState: ServerAuthGateState = {
    status: "requires-auth" as const,
    auth: {
      policy: "remote-reachable" as const,
      bootstrapMethods: ["one-time-token" as const],
      sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
      sessionCookieName: "t3_session",
    },
  };
  const activeAuthState: ServerAuthGateState = {
    status: "authenticated" as const,
    tenantStatus: "active" as const,
  };
  const pendingMembershipAuthState: ServerAuthGateState = {
    status: "authenticated" as const,
    tenantStatus: "pending-membership" as const,
  };
  let authGateState: ServerAuthGateState = requiresAuthState;

  return {
    getAuthGateState: vi.fn(async () => authGateState),
    setActiveUser() {
      authGateState = activeAuthState;
    },
    setPendingMembershipUser() {
      authGateState = pendingMembershipAuthState;
    },
    reset() {
      authGateState = requiresAuthState;
      this.getAuthGateState.mockClear();
    },
  };
});

vi.mock("../AppSidebarLayout", () => ({
  AppSidebarLayout: ({ children }: { readonly children: ReactNode }) => (
    <div data-testid="mock-app-shell">{children}</div>
  ),
}));

vi.mock("../CommandPalette", () => ({
  CommandPalette: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../WebSocketConnectionSurface", () => ({
  SlowRpcAckToastCoordinator: () => null,
  WebSocketConnectionCoordinator: () => null,
  WebSocketConnectionSurface: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock("../WorkspaceDashboard", () => ({
  WorkspaceDashboard: () => (
    <main data-testid="workspace-dashboard">
      <h1>Workspace Dashboard</h1>
    </main>
  ),
}));

vi.mock("../../environments/runtime", () => ({
  addSavedEnvironment: vi.fn(async () => undefined),
  disconnectSavedEnvironment: vi.fn(async () => undefined),
  ensureEnvironmentConnectionBootstrapped: vi.fn(async () => undefined),
  getEnvironmentHttpBaseUrl: () => null,
  getPrimaryEnvironmentConnection: () => ({
    client: {
      server: {},
    },
  }),
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listSavedEnvironmentRecords: () => [],
  readEnvironmentConnection: () => undefined,
  reconnectSavedEnvironment: vi.fn(async () => undefined),
  removeSavedEnvironment: vi.fn(async () => undefined),
  requireEnvironmentConnection: () => ({
    client: {
      orchestration: {},
      server: {},
    },
  }),
  resetEnvironmentServiceForTests: vi.fn(),
  resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
  resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
  resolveEnvironmentHttpUrl: () => null,
  startEnvironmentConnectionService: vi.fn(() => () => undefined),
  subscribeEnvironmentConnections: () => () => undefined,
  useSavedEnvironmentRegistryStore: Object.assign(() => [], {
    getState: () => ({}),
    setState: vi.fn(),
    subscribe: () => () => undefined,
  }),
  useSavedEnvironmentRuntimeStore: Object.assign(() => ({}), {
    getState: () => ({}),
    setState: vi.fn(),
    subscribe: () => () => undefined,
  }),
  waitForSavedEnvironmentRegistryHydration: async () => undefined,
}));

vi.mock("../../observability/clientTracing", () => ({
  __resetClientTracingForTests: vi.fn(async () => undefined),
  ClientTracingLive: {},
  configureClientTracing: vi.fn(async () => undefined),
}));

vi.mock("../../rpc/serverState", () => ({
  applySettingsUpdated: vi.fn(),
  getServerConfig: () => null,
  getServerConfigUpdatedNotification: () => null,
  resetServerStateForTests: vi.fn(),
  setServerConfigSnapshot: vi.fn(),
  startServerStateSync: vi.fn(() => () => undefined),
  useServerAvailableEditors: () => [],
  useServerConfig: () => null,
  useServerConfigUpdatedSubscription: vi.fn(() => undefined),
  useServerKeybindings: () => null,
  useServerKeybindingsConfigPath: () => null,
  useServerObservability: () => null,
  useServerProviders: () => [],
  useServerSettings: () => null,
  useServerWelcomeSubscription: vi.fn(() => undefined),
}));

vi.mock("../../environments/primary", () => {
  return {
    createServerPairingCredential: vi.fn(async () => ({
      credential: "pairing-credential",
      pairingLink: null,
    })),
    ensurePrimaryEnvironmentReady: async () => undefined,
    fetchOnboardingState: vi.fn(async () => ({ nextStep: "create-workspace" })),
    fetchSessionState: vi.fn(async () => authHarness.getAuthGateState()),
    fetchSupabaseBearerSessionState: vi.fn(async () => ({
      authenticated: true,
      tenantStatus: "active",
    })),
    fetchSupabaseBearerUserProfile: vi.fn(async () => null),
    fetchSupabasePublicAuthConfig: vi.fn(async () => null),
    fetchUserProfile: vi.fn(async () => null),
    getPrimaryKnownEnvironment: () => null,
    issueSupabaseBearerWebSocketToken: vi.fn(async () => ({ token: "ws-token" })),
    isLoopbackHostname: () => false,
    listServerClientSessions: vi.fn(async () => []),
    listServerPairingLinks: vi.fn(async () => []),
    peekPairingTokenFromUrl: vi.fn(() => null),
    readPrimaryEnvironmentDescriptor: () => null,
    readSupabaseBrowserAccessToken: vi.fn(() => null),
    readSupabaseBrowserRefreshToken: vi.fn(() => null),
    removeSupabaseBrowserAccessToken: vi.fn(),
    resolvePrimaryEnvironmentHttpUrl: () => null,
    resolveInitialPrimaryEnvironmentDescriptor: async () => undefined,
    resolveInitialServerAuthGateState: authHarness.getAuthGateState,
    resolveSupabasePrimaryWebSocketConnectionUrl: vi.fn(async (url: string) => url),
    revokeOtherServerClientSessions: vi.fn(async () => undefined),
    revokeServerClientSession: vi.fn(async () => undefined),
    revokeServerPairingLink: vi.fn(async () => undefined),
    signOutSupabaseBrowserSession: vi.fn(),
    subscribeSupabaseBrowserSessionChanges: vi.fn(() => () => undefined),
    stripPairingTokenFromUrl: vi.fn(),
    submitSupabaseBrowserAccessToken: vi.fn(async () => ({
      authenticated: true,
      tenantStatus: "active",
    })),
    submitServerAuthCredential: vi.fn(async () => undefined),
    signOutLocalServerSession: vi.fn(async () => undefined),
    submitLocalPasswordAuth: vi.fn(async () => ({
      authenticated: true,
      role: "client",
      sessionMethod: "browser-session-cookie",
      tenantStatus: "active",
    })),
    takePairingTokenFromUrl: vi.fn(() => null),
    submitSupabasePasswordAuth: vi.fn(async () => ({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "t3_session",
      },
      role: "client",
      sessionMethod: "bearer-session-token",
      tenantStatus: "active",
    })),
    updateUserProfile: vi.fn(async () => null),
    updatePrimaryEnvironmentDescriptor: vi.fn(),
    usePrimaryEnvironmentId: () => null,
    writePrimaryEnvironmentDescriptor: vi.fn(),
    writeSupabaseBrowserAccessToken: vi.fn(),
  };
});

async function clearBrowserState(): Promise<void> {
  localStorage.clear();
  sessionStorage.clear();

  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  });

  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
  }

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

async function renderRoute(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  const screen = await render(<RouterProvider router={router} />);
  return {
    router,
    async unmount() {
      await screen.unmount();
    },
  };
}

describe("authenticated route protection browser flow", () => {
  beforeEach(async () => {
    await clearBrowserState();
    document.body.innerHTML = "";
    authHarness.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    authHarness.reset();
  });

  it("redirects unauthenticated settings access to the pairing route from clean state", async () => {
    const mounted = await renderRoute("/settings/account");

    try {
      await expect.element(page.getByText("Pair with this environment")).toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe("/pair");
      expect(authHarness.getAuthGateState).toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("redirects unauthenticated workspace access to the pairing route from clean state", async () => {
    const mounted = await renderRoute("/project/environment-route-protect/project-route-protect");

    try {
      await expect.element(page.getByText("Pair with this environment")).toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe("/pair");
      expect(authHarness.getAuthGateState).toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("lands authenticated active users in the app shell workspace hub from clean state", async () => {
    await clearBrowserState();
    const uniqueEmail = `active-route-${Date.now()}@example.test`;
    localStorage.setItem("t3-route-protection-active-user", uniqueEmail);
    authHarness.setActiveUser();

    const mounted = await renderRoute("/pair");

    try {
      await expect.element(page.getByTestId("mock-app-shell")).toBeInTheDocument();
      await expect.element(page.getByTestId("workspace-dashboard")).toBeInTheDocument();
      await expect.element(page.getByText("Workspace Dashboard")).toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe("/");
    } finally {
      await mounted.unmount();
    }
  });

  it("lands first-time pending-membership users in invite onboarding from clean state", async () => {
    await clearBrowserState();
    const uniqueEmail = `pending-route-${Date.now()}@example.test`;
    localStorage.setItem("t3-route-protection-pending-user", uniqueEmail);
    authHarness.setPendingMembershipUser();

    const mounted = await renderRoute("/");

    try {
      await expect.element(page.getByText("Invite link is missing")).toBeInTheDocument();
      await expect.element(page.getByTestId("workspace-dashboard")).not.toBeInTheDocument();
      expect(mounted.router.state.location.pathname).toBe("/invite");
    } finally {
      await mounted.unmount();
    }
  });
});
