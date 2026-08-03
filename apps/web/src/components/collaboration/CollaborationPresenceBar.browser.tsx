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
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      userId: UserId.make("user-fresh-browser"),
      kind: "prompted" as const,
      summary: `${input.freshUserName} shared a prompt: ${request.prompt}`,
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
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            userId: UserId.make("user-returning-browser"),
            kind: "joined" as const,
            summary: "Existing collaborator joined this shared workspace.",
            createdAt: NOW_ISO,
          },
        ],
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

    const screen = await render(
      <CollaborationPresenceBar
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        threadId={THREAD_ID}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: /open collaboration panel/i }))
        .toBeInTheDocument();
      await page.getByRole("button", { name: /open collaboration panel/i }).click();

      await expect.element(page.getByText(freshUserName)).toBeInTheDocument();
      await expect.element(page.getByTitle(`${freshUserName} · active`)).toHaveTextContent("FU");
      await expect.element(page.getByText("Returning Browser User")).toBeInTheDocument();
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
});
