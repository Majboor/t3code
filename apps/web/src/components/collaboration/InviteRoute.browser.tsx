import "../../index.css";

import {
  EnvironmentId,
  InviteId,
  MembershipId,
  OrganizationId,
  TenantId,
  UserId,
  WorkspaceId,
  type EnvironmentApi,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { getRouter } from "../../router";

const authHarness = vi.hoisted(() => {
  let authGateState: { status: "authenticated"; tenantStatus?: "active" | "pending-membership" } = {
    status: "authenticated",
    tenantStatus: "active",
  };

  return {
    getAuthGateState() {
      return authGateState;
    },
    setPendingMembership() {
      authGateState = { status: "authenticated", tenantStatus: "pending-membership" };
    },
    reset() {
      authGateState = { status: "authenticated", tenantStatus: "active" };
    },
  };
});

const runtimeHarness = vi.hoisted(() => {
  let onEnsureBootstrapped: (() => void) | undefined;
  const stopConnectionService = vi.fn();
  const startEnvironmentConnectionService = vi.fn(() => stopConnectionService);
  const ensureEnvironmentConnectionBootstrapped = vi.fn(async () => {
    onEnsureBootstrapped?.();
  });

  return {
    ensureEnvironmentConnectionBootstrapped,
    missingRuntimeExport: (name: string) => () => {
      throw new Error(`Runtime test mock does not implement ${name}.`);
    },
    setOnEnsureBootstrapped(callback: (() => void) | undefined) {
      onEnsureBootstrapped = callback;
    },
    startEnvironmentConnectionService,
    stopConnectionService,
    reset() {
      onEnsureBootstrapped = undefined;
      ensureEnvironmentConnectionBootstrapped.mockClear();
      startEnvironmentConnectionService.mockClear();
      stopConnectionService.mockClear();
    },
  };
});

const primaryAuthHarness = vi.hoisted(() => {
  let pairingToken: string | null = null;
  const submitServerAuthCredential = vi.fn(async (_credential: string) => undefined);
  const takePairingTokenFromUrl = vi.fn(() => {
    const token = pairingToken;
    pairingToken = null;
    return token;
  });

  return {
    setPairingToken(token: string | null) {
      pairingToken = token;
    },
    submitServerAuthCredential,
    takePairingTokenFromUrl,
    reset() {
      pairingToken = null;
      submitServerAuthCredential.mockReset();
      submitServerAuthCredential.mockResolvedValue(undefined);
      takePairingTokenFromUrl.mockClear();
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-invite-browser");
const TENANT_ID = TenantId.make("tenant-invite-browser");
const WORKSPACE_ID = WorkspaceId.make("workspace-invite-browser");
const NOW_ISO = "2026-05-09T12:00:00.000Z";

vi.mock("../../environments/primary", async () => {
  const actual = await vi.importActual<typeof import("../../environments/primary")>(
    "../../environments/primary",
  );
  return {
    ...actual,
    ensurePrimaryEnvironmentReady: async () => undefined,
    resolveInitialServerAuthGateState: async () => authHarness.getAuthGateState(),
    submitServerAuthCredential: primaryAuthHarness.submitServerAuthCredential,
    takePairingTokenFromUrl: primaryAuthHarness.takePairingTokenFromUrl,
    updatePrimaryEnvironmentDescriptor: vi.fn(),
    usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
  };
});

vi.mock("../../environments/runtime", () => {
  const missingRuntimeExport = runtimeHarness.missingRuntimeExport;
  return {
    addSavedEnvironment: missingRuntimeExport("addSavedEnvironment"),
    disconnectSavedEnvironment: missingRuntimeExport("disconnectSavedEnvironment"),
    ensureEnvironmentConnectionBootstrapped: runtimeHarness.ensureEnvironmentConnectionBootstrapped,
    getEnvironmentHttpBaseUrl: () => null,
    getPrimaryEnvironmentConnection: missingRuntimeExport("getPrimaryEnvironmentConnection"),
    getSavedEnvironmentRecord: () => null,
    getSavedEnvironmentRuntimeState: () => null,
    hasSavedEnvironmentRegistryHydrated: () => true,
    listSavedEnvironmentRecords: () => [],
    readEnvironmentConnection: () => undefined,
    reconnectSavedEnvironment: missingRuntimeExport("reconnectSavedEnvironment"),
    removeSavedEnvironment: missingRuntimeExport("removeSavedEnvironment"),
    requireEnvironmentConnection: missingRuntimeExport("requireEnvironmentConnection"),
    resetEnvironmentServiceForTests: vi.fn(),
    resetSavedEnvironmentRegistryStoreForTests: vi.fn(),
    resetSavedEnvironmentRuntimeStoreForTests: vi.fn(),
    resolveEnvironmentHttpUrl: missingRuntimeExport("resolveEnvironmentHttpUrl"),
    startEnvironmentConnectionService: runtimeHarness.startEnvironmentConnectionService,
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
  };
});

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

function makeEnvironmentApi(input: {
  readonly inviteId: ReturnType<typeof InviteId.make>;
  readonly email: string;
  readonly scope?: "tenant" | "workspace" | "project";
  readonly workspaceId?: ReturnType<typeof WorkspaceId.make> | null;
  readonly acceptInvite?: EnvironmentApi["collaboration"]["acceptInvite"];
  readonly acceptEmployeeInvite?: EnvironmentApi["organizations"]["acceptEmployeeInvite"];
}): EnvironmentApi {
  const scope = input.scope ?? "tenant";
  const workspaceId =
    input.workspaceId === undefined
      ? scope === "tenant"
        ? null
        : WORKSPACE_ID
      : input.workspaceId;
  const acceptInvite =
    input.acceptInvite ??
    vi.fn(async () => ({
      invite: {
        id: input.inviteId,
        tenantId: TENANT_ID,
        workspaceId,
        invitedByUserId: UserId.make("user-inviter-browser"),
        email: input.email,
        scope,
        roles: ["developer" as const],
        createdAt: NOW_ISO,
        expiresAt: "2026-05-16T12:00:00.000Z",
        acceptedAt: NOW_ISO,
        acceptedByUserId: null,
        revokedAt: null,
      },
      membership: {
        id: MembershipId.make("membership-invite-browser"),
        tenantId: TENANT_ID,
        userId: UserId.make("user-fresh-invite-browser"),
        organizationId: null,
        roles: ["developer" as const],
        createdAt: NOW_ISO,
        disabledAt: null,
      },
    }));

  return {
    collaboration: {
      acceptInvite,
    },
    ...(input.acceptEmployeeInvite
      ? {
          organizations: {
            acceptEmployeeInvite: input.acceptEmployeeInvite,
          },
        }
      : {}),
  } as unknown as EnvironmentApi;
}

async function renderInviteRoute(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  const screen = await render(<RouterProvider router={router} />);
  return {
    async unmount() {
      await screen.unmount();
    },
  };
}

describe("invite route browser flow", () => {
  beforeEach(async () => {
    await clearBrowserState();
    document.body.innerHTML = "";
    authHarness.reset();
    primaryAuthHarness.reset();
    runtimeHarness.reset();
    __resetEnvironmentApiOverridesForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    primaryAuthHarness.reset();
    runtimeHarness.reset();
    __resetEnvironmentApiOverridesForTests();
  });

  it("shows a missing invite message without accepting anything", async () => {
    const inviteId = InviteId.make("invite-browser-missing");
    const api = makeEnvironmentApi({
      inviteId,
      email: "missing-invite-browser@example.test",
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute("/invite");
    try {
      await expect.element(page.getByText("Invite link is missing")).toBeInTheDocument();
      expect(api.collaboration.acceptInvite).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("routes a first-time authenticated user without membership into invite onboarding from clean browser state", async () => {
    authHarness.setPendingMembership();

    const screen = await renderInviteRoute("/");
    try {
      await expect.element(page.getByText("Invite link is missing")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("accepts an invite for a unique fresh user from clean browser state", async () => {
    const inviteId = InviteId.make(`invite-browser-${Date.now()}`);
    const email = `fresh-invite-${Date.now()}@example.test`;
    const api = makeEnvironmentApi({ inviteId, email });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?invite=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText(`${email} now has access. You can return to the workspace.`))
        .toBeInTheDocument();
      expect(api.collaboration.acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("accepts an organization employee invite before trying collaboration invites", async () => {
    const inviteId = InviteId.make(`employee-invite-browser-${Date.now()}`);
    const email = `employee-invite-${Date.now()}@example.test`;
    const organizationId = OrganizationId.make("org-invite-browser");
    const membership = {
      id: MembershipId.make("membership-employee-invite-browser"),
      tenantId: TENANT_ID,
      userId: UserId.make("user-employee-invite-browser"),
      organizationId,
      roles: ["developer"] as const,
      organizationRoles: ["developer"] as const,
      teamIds: [],
      departmentId: null,
      createdAt: NOW_ISO,
      disabledAt: null,
    };
    const invite = {
      id: inviteId,
      tenantId: TENANT_ID,
      workspaceId: null,
      invitedByUserId: UserId.make("user-inviter-browser"),
      email,
      scope: "tenant" as const,
      roles: ["developer"] as const,
      createdAt: NOW_ISO,
      expiresAt: "2026-05-16T12:00:00.000Z",
      acceptedAt: NOW_ISO,
      acceptedByUserId: null,
      revokedAt: null,
    };
    const acceptEmployeeInvite = vi.fn(async () => ({
      invite,
      membership,
      employee: {
        membership,
        email,
        displayName: "Fresh Employee",
        status: "active" as const,
      },
    }));
    const acceptInvite = vi.fn();
    const api = makeEnvironmentApi({
      inviteId,
      email,
      acceptInvite,
      acceptEmployeeInvite,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?invite=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText(`${email} now has access. You can return to the workspace.`))
        .toBeInTheDocument();
      expect(acceptEmployeeInvite).toHaveBeenCalledWith({ inviteId });
      expect(acceptInvite).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("bootstraps the real environment connection before accepting when the invite route has no api yet", async () => {
    const inviteId = InviteId.make(`invite-bootstrap-browser-${Date.now()}`);
    const email = `bootstrap-invite-${Date.now()}@example.test`;
    const api = makeEnvironmentApi({ inviteId, email });
    runtimeHarness.setOnEnsureBootstrapped(() => {
      __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    });

    const screen = await renderInviteRoute(`/invite?invite=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText(`${email} now has access. You can return to the workspace.`))
        .toBeInTheDocument();
      expect(runtimeHarness.startEnvironmentConnectionService).toHaveBeenCalledTimes(1);
      expect(runtimeHarness.ensureEnvironmentConnectionBootstrapped).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
      );
      expect(api.collaboration.acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
    expect(runtimeHarness.stopConnectionService).toHaveBeenCalledTimes(1);
  });

  it("accepts with the current session when an old setup token is already consumed", async () => {
    const inviteId = InviteId.make(`invite-stale-setup-token-${Date.now()}`);
    const email = `stale-setup-token-${Date.now()}@example.test`;
    const api = makeEnvironmentApi({ inviteId, email });
    primaryAuthHarness.setPairingToken("already-used-token");
    primaryAuthHarness.submitServerAuthCredential.mockRejectedValueOnce(
      new Error("Invalid bootstrap credential."),
    );
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?inviteId=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      expect(primaryAuthHarness.takePairingTokenFromUrl).toHaveBeenCalledTimes(1);
      expect(primaryAuthHarness.submitServerAuthCredential).toHaveBeenCalledWith(
        "already-used-token",
      );
      expect(api.collaboration.acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("accepts a workspace-scoped invite with membership rules from clean browser state", async () => {
    const inviteId = InviteId.make(`invite-workspace-browser-${Date.now()}`);
    const email = `workspace-invite-${Date.now()}@example.test`;
    const api = makeEnvironmentApi({
      inviteId,
      email,
      scope: "workspace",
      workspaceId: WORKSPACE_ID,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?invite=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText(`${email} now has access. You can return to the workspace.`))
        .toBeInTheDocument();
      expect(api.collaboration.acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("accepts a project-scoped invite with membership rules from clean browser state", async () => {
    const inviteId = InviteId.make(`invite-project-browser-${Date.now()}`);
    const email = `project-invite-${Date.now()}@example.test`;
    const api = makeEnvironmentApi({
      inviteId,
      email,
      scope: "project",
      workspaceId: WORKSPACE_ID,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?inviteId=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText(`${email} now has access. You can return to the workspace.`))
        .toBeInTheDocument();
      expect(api.collaboration.acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("shows the returning-user failure state when an invite was already accepted", async () => {
    const inviteId = InviteId.make("invite-browser-returning-user");
    const acceptInvite = vi.fn(async () => {
      throw new Error("Collaboration invite has already been accepted.");
    });
    const api = makeEnvironmentApi({
      inviteId,
      email: "returning-invite-browser@example.test",
      acceptInvite,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?inviteId=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite could not be accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText("Collaboration invite has already been accepted."))
        .toBeInTheDocument();
      expect(acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("shows a revoked invite failure state", async () => {
    const inviteId = InviteId.make("invite-browser-revoked");
    const acceptInvite = vi.fn(async () => {
      throw new Error("Collaboration invite has been revoked.");
    });
    const api = makeEnvironmentApi({
      inviteId,
      email: "revoked-invite-browser@example.test",
      acceptInvite,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?invite=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite could not be accepted")).toBeInTheDocument();
      await expect
        .element(page.getByText("Collaboration invite has been revoked."))
        .toBeInTheDocument();
      expect(acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });

  it("shows an expired invite failure state", async () => {
    const inviteId = InviteId.make("invite-browser-expired");
    const acceptInvite = vi.fn(async () => {
      throw new Error("Collaboration invite has expired.");
    });
    const api = makeEnvironmentApi({
      inviteId,
      email: "expired-invite-browser@example.test",
      acceptInvite,
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderInviteRoute(`/invite?inviteId=${encodeURIComponent(inviteId)}`);
    try {
      await expect.element(page.getByText("Invite could not be accepted")).toBeInTheDocument();
      await expect.element(page.getByText("Collaboration invite has expired.")).toBeInTheDocument();
      expect(acceptInvite).toHaveBeenCalledWith({ inviteId });
    } finally {
      await screen.unmount();
    }
  });
});
