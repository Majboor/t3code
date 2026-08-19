import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  TenantId,
  ThreadId,
  UserId,
  WorkspaceId,
  type CollaborationStreamEvent,
  type EnvironmentApi,
  type Tenant,
} from "@t3tools/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { CollaborationPresenceBar } from "./CollaborationPresenceBar";

const ENVIRONMENT_ID = EnvironmentId.make("environment-collab-browser");
const PROJECT_ID = ProjectId.make("workspace-collab-browser");
const THREAD_ID = ThreadId.make("thread-collab-browser");
const TENANT_ID = TenantId.make("tenant-collab-browser");
const WORKSPACE_ID = WorkspaceId.make(PROJECT_ID);
const NOW_ISO = "2026-05-09T12:00:00.000Z";

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

function makeTenant(): Tenant {
  return {
    id: TENANT_ID,
    slug: "collab-browser",
    displayName: "Collab Browser",
    kind: "shared",
    organizationId: null,
    runtimeId: "runtime-collab-browser" as Tenant["runtimeId"],
    createdAt: NOW_ISO,
    archivedAt: null,
  };
}

function makeEnvironmentApi(input: {
  readonly freshUserName: string;
  readonly onSubscribe?: (emit: (event: CollaborationStreamEvent) => void) => void;
}): EnvironmentApi {
  const tenant = makeTenant();
  const upsertPresence = vi.fn(async () => ({
    presence: {
      userId: UserId.make("user-fresh-browser"),
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      displayName: input.freshUserName,
      avatarInitials: "FU",
      status: "active" as const,
      lastSeenAt: NOW_ISO,
    },
  }));
  const recordSharedPrompt = vi.fn(async (request: { prompt: string }) => ({
    activity: {
      id: "activity-shared-browser",
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      userId: UserId.make("user-fresh-browser"),
      kind: "prompted" as const,
      summary: `${input.freshUserName} shared a prompt: ${request.prompt}`,
      hiddenAt: null,
      createdAt: NOW_ISO,
    },
  }));

  return {
    collaboration: {
      upsertPresence,
      listPresence: vi.fn(async () => ({
        users: [
          {
            userId: UserId.make("user-fresh-browser"),
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            displayName: input.freshUserName,
            avatarInitials: "FU",
            status: "active" as const,
            lastSeenAt: NOW_ISO,
          },
          {
            userId: UserId.make("user-returning-browser"),
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            displayName: "Returning Browser User",
            avatarInitials: "RU",
            status: "idle" as const,
            lastSeenAt: NOW_ISO,
          },
        ],
      })),
      listActivity: vi.fn(async () => ({
        activities: [
          {
            id: "activity-joined-browser",
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            userId: UserId.make("user-returning-browser"),
            kind: "joined" as const,
            summary: "Existing collaborator joined this shared workspace.",
            hiddenAt: null,
            createdAt: NOW_ISO,
          },
        ],
      })),
      setActivityVisibility: vi.fn(),
      // The roster is read directly rather than through a promise chain, so an
      // override without it takes the whole panel down.
      listMembers: vi.fn(async () => ({
        members: [],
        canManage: false,
        viewerUserId: UserId.make("user-fresh-browser"),
      })),
      createInvite: vi.fn(),
      listInvites: vi.fn(),
      acceptInvite: vi.fn(),
      revokeInvite: vi.fn(),
      recordSharedPrompt,
      subscribe: vi.fn((_request, callback) => {
        input.onSubscribe?.(callback);
        return () => undefined;
      }),
    },
    // The bar reads sharing on mount, so an override without it is a TypeError
    // rather than an empty panel.
    providerSharing: {
      getOverview: vi.fn(async () => ({
        viewerUserId: UserId.make("user-fresh-browser"),
        canManage: false,
        viewerAccounts: [],
        viewerShares: [],
        viewerGrants: [],
        policies: [],
        grants: [],
        workspaceAccounts: [],
      })),
      updateShare: vi.fn(),
      updatePolicy: vi.fn(),
      updateMember: vi.fn(),
    },
    // Same trap as sharing: the usage section reads on mount.
    providerUsage: {
      createRequest: vi.fn(),
      listRequests: vi.fn(async () => ({ requests: [], canRespond: false })),
      respondToRequest: vi.fn(),
      withdrawRequest: vi.fn(),
    },
    organizations: {
      list: vi.fn(async () => ({
        organizations: [],
        tenants: [tenant],
        employees: [],
        invites: [],
        memberships: [],
        teams: [],
        departments: [],
        grants: [],
        reviews: [],
      })),
    },
  } as unknown as EnvironmentApi;
}

/**
 * The bar links to Settings → Connections, and a router link outside a router
 * throws, so it is mounted as a route rather than bare.
 */
async function renderBar() {
  const rootRoute = createRootRoute({
    component: () => (
      <CollaborationPresenceBar
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

/**
 * Rows are addressed by the section they open rather than by their label, so
 * the test opens the row the panel would open rather than whichever one happens
 * to read "People".
 */
function openRow(section: string) {
  return page.getByTestId(`collaboration-row-${section}`);
}

describe("CollaborationPresenceBar browser flow", () => {
  beforeEach(async () => {
    await clearBrowserState();
    document.body.innerHTML = "";
    __resetEnvironmentApiOverridesForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    __resetEnvironmentApiOverridesForTests();
  });

  it("loads presence from a clean browser state and records a prompt for a fresh user", async () => {
    const freshUserName = `Fresh Browser User ${Date.now()}`;
    const api = makeEnvironmentApi({ freshUserName });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderBar();

    try {
      await expect
        .element(page.getByRole("button", { name: /open collaboration panel/i }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: /open collaboration panel/i }).click();

      // The overview is previews only: the roster and the activity feed live
      // one click away rather than stacked on top of each other.
      await expect.element(page.getByTestId("collaboration-overview")).toBeInTheDocument();
      await expect.element(openRow("people")).toHaveTextContent("2 people here");
      await expect.element(page.getByTitle(`${freshUserName} · active`)).toHaveTextContent("FU");
      expect(document.querySelectorAll('[data-testid="collaboration-working-pill"]')).toHaveLength(
        0,
      );

      await openRow("people").click();
      await expect.element(page.getByText(freshUserName)).toBeInTheDocument();
      await expect.element(page.getByText("Returning Browser User")).toBeInTheDocument();

      await page.getByTestId("collaboration-panel-back").click();
      await expect.element(page.getByTestId("collaboration-overview")).toBeInTheDocument();

      await openRow("activity").click();
      await expect
        .element(page.getByText("Existing collaborator joined this shared workspace."))
        .toBeInTheDocument();

      const prompt = `Browser e2e prompt ${Date.now()}`;
      await page.getByPlaceholder("Share a prompt with this thread").fill(prompt);
      await page.getByRole("button", { name: /share/i }).click();

      await expect
        .element(page.getByText(`${freshUserName} shared a prompt: ${prompt}`))
        .toBeInTheDocument();
      expect(api.collaboration.upsertPresence).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        status: "active",
      });
      expect(api.collaboration.recordSharedPrompt).toHaveBeenCalledWith({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        prompt,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the provider sections reachable, one at a time", async () => {
    const api = makeEnvironmentApi({ freshUserName: "Fresh Browser User" });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await renderBar();

    try {
      await page.getByRole("button", { name: /open collaboration panel/i }).click();
      await expect.element(page.getByTestId("collaboration-overview")).toBeInTheDocument();

      // Contributing an account and asking for one are two rows now, and
      // neither is on screen until it is asked for.
      expect(document.querySelectorAll('[data-testid="provider-sharing-section"]')).toHaveLength(0);
      expect(document.querySelectorAll('[data-testid="provider-usage-requests"]')).toHaveLength(0);

      await openRow("sharing").click();
      await expect.element(page.getByTestId("provider-sharing-section")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="provider-usage-requests"]')).toHaveLength(0);

      await page.getByTestId("collaboration-panel-back").click();
      await openRow("requests").click();
      await expect.element(page.getByTestId("provider-usage-requests")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="provider-sharing-section"]')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
