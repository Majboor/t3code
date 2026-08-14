import "../../index.css";

import {
  EnvironmentId,
  InviteId,
  MembershipId,
  OrganizationId,
  TenantId,
  TenantRuntimeId,
  UserId,
  WorkspaceId,
  type EnvironmentApi,
  type OrganizationListResult,
  type TenantInvite,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { toastManager } from "../ui/toast";
import { OrganizationAdminPanel } from "./OrganizationAdminPanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-organization-admin-browser");
const ORGANIZATION_ID = OrganizationId.make("organization-admin-browser");
const TENANT_ID = TenantId.make("tenant-organization-admin-browser");
const WORKSPACE_ID = WorkspaceId.make("workspace-organization-admin-browser");
const INVITER_USER_ID = UserId.make("user-organization-admin-browser");
const NOW_ISO = "2026-05-09T12:00:00.000Z";

vi.mock("../../environments/primary", async () => {
  const actual = await vi.importActual<typeof import("../../environments/primary")>(
    "../../environments/primary",
  );
  return {
    ...actual,
    usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
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

function makeOrganizationListResult(): OrganizationListResult {
  return {
    organizations: [
      {
        id: ORGANIZATION_ID,
        slug: "browser-admin",
        displayName: "Browser Admin",
        createdAt: NOW_ISO,
        archivedAt: null,
      },
    ],
    tenants: [
      {
        id: TENANT_ID,
        slug: "browser-admin",
        displayName: "Browser Admin",
        kind: "corporate",
        organizationId: ORGANIZATION_ID,
        runtimeId: TenantRuntimeId.make("tenant-runtime-organization-admin-browser"),
        createdAt: NOW_ISO,
        archivedAt: null,
      },
    ],
    employees: [],
    invites: [],
    memberships: [],
    teams: [],
    departments: [],
    grants: [],
    reviews: [],
  };
}

function makeCollaborationInvite(input: {
  readonly inviteId: ReturnType<typeof InviteId.make>;
  readonly email: string;
  readonly acceptedAt?: string | null;
  readonly revokedAt?: string | null;
}): TenantInvite {
  return {
    id: input.inviteId,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    invitedByUserId: INVITER_USER_ID,
    email: input.email,
    scope: "workspace",
    roles: ["developer"],
    createdAt: NOW_ISO,
    expiresAt: "2026-05-16T12:00:00.000Z",
    acceptedAt: input.acceptedAt ?? null,
    acceptedByUserId: null,
    revokedAt: input.revokedAt ?? null,
  };
}

describe("OrganizationAdminPanel browser invite management", () => {
  beforeEach(async () => {
    await clearBrowserState();
    document.body.innerHTML = "";
    __resetEnvironmentApiOverridesForTests();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    __resetEnvironmentApiOverridesForTests();
    vi.restoreAllMocks();
  });

  it("revokes a pending workspace invite from a clean browser state", async () => {
    const inviteId = InviteId.make(`invite-admin-revoke-${Date.now()}`);
    const email = `admin-revoke-${Date.now()}@example.test`;
    let collaborationInvites = [makeCollaborationInvite({ inviteId, email })];

    const revokeInvite = vi.fn(async ({ inviteId: revokedInviteId }) => {
      collaborationInvites = collaborationInvites.map((invite) =>
        invite.id === revokedInviteId ? { ...invite, revokedAt: NOW_ISO } : invite,
      );
      const invite = collaborationInvites.find((entry) => entry.id === revokedInviteId);
      if (!invite) {
        throw new Error("Collaboration invite was not found.");
      }
      return { invite };
    });
    const api = {
      collaboration: {
        listInvites: vi.fn(async () => ({ invites: collaborationInvites })),
        revokeInvite,
      },
      organizations: {
        list: vi.fn(async () => makeOrganizationListResult()),
        listAuditEvents: vi.fn(async () => ({ events: [] })),
      },
    } as unknown as EnvironmentApi;
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await render(<OrganizationAdminPanel />);
    try {
      await expect.element(page.getByText(email)).toBeInTheDocument();
      expect(api.organizations.list).toHaveBeenCalledTimes(1);
      expect(api.organizations.listAuditEvents).toHaveBeenCalledTimes(1);
      expect(api.collaboration.listInvites).toHaveBeenCalledTimes(1);
      await expect
        .element(page.getByRole("button", { name: `Revoke invite for ${email}` }))
        .toBeEnabled();

      await page.getByRole("button", { name: `Revoke invite for ${email}` }).click();

      await expect
        .element(page.getByRole("button", { name: `Revoke invite for ${email}` }))
        .toBeDisabled();
      expect(revokeInvite).toHaveBeenCalledWith({ tenantId: TENANT_ID, inviteId });
      expect(api.collaboration.listInvites).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("filters invite status and copies a share link from a clean browser state", async () => {
    const pendingInviteId = InviteId.make(`invite-admin-pending-${Date.now()}`);
    const acceptedInviteId = InviteId.make(`invite-admin-accepted-${Date.now()}`);
    const revokedInviteId = InviteId.make(`invite-admin-revoked-${Date.now()}`);
    const pendingEmail = `admin-pending-${Date.now()}@example.test`;
    const acceptedEmail = `admin-accepted-${Date.now()}@example.test`;
    const revokedEmail = `admin-revoked-${Date.now()}@example.test`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const collaborationInvites = [
      makeCollaborationInvite({ inviteId: pendingInviteId, email: pendingEmail }),
      makeCollaborationInvite({
        inviteId: acceptedInviteId,
        email: acceptedEmail,
        acceptedAt: NOW_ISO,
      }),
      makeCollaborationInvite({
        inviteId: revokedInviteId,
        email: revokedEmail,
        revokedAt: NOW_ISO,
      }),
    ];
    const api = {
      collaboration: {
        listInvites: vi.fn(async () => ({ invites: collaborationInvites })),
        revokeInvite: vi.fn(),
      },
      organizations: {
        list: vi.fn(async () => makeOrganizationListResult()),
        listAuditEvents: vi.fn(async () => ({ events: [] })),
      },
    } as unknown as EnvironmentApi;
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await render(<OrganizationAdminPanel />);
    try {
      await expect.element(page.getByText(pendingEmail)).toBeInTheDocument();
      await expect.element(page.getByText(acceptedEmail)).toBeInTheDocument();
      await expect.element(page.getByText(revokedEmail)).toBeInTheDocument();

      await page.getByRole("button", { name: "Show accepted invites" }).click();

      await expect.element(page.getByText(acceptedEmail)).toBeInTheDocument();
      await expect.element(page.getByText(pendingEmail)).not.toBeInTheDocument();
      await expect.element(page.getByText(revokedEmail)).not.toBeInTheDocument();

      await page.getByRole("button", { name: `Copy invite link for ${acceptedEmail}` }).click();

      expect(writeText).toHaveBeenCalledWith(
        new URL(
          `/invite?inviteId=${encodeURIComponent(acceptedInviteId)}`,
          window.location.origin,
        ).toString(),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows the employee invite link immediately after creating an invite", async () => {
    const inviteId = InviteId.make(`invite-admin-created-${Date.now()}`);
    const email = `admin-created-${Date.now()}@example.test`;
    const displayName = "Created Browser Employee";
    const invite = {
      id: inviteId,
      tenantId: TENANT_ID,
      workspaceId: null,
      invitedByUserId: INVITER_USER_ID,
      email,
      scope: "tenant",
      roles: ["developer"],
      createdAt: NOW_ISO,
      expiresAt: "2026-05-16T12:00:00.000Z",
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
    } satisfies TenantInvite;
    const inviteEmployee = vi.fn(async () => ({
      invite,
      employee: {
        membership: {
          id: MembershipId.make(`membership-admin-created-${Date.now()}`),
          tenantId: TENANT_ID,
          userId: UserId.make(`user-admin-created-${Date.now()}`),
          organizationId: ORGANIZATION_ID,
          roles: ["developer"],
          organizationRoles: ["developer"],
          teamIds: [],
          departmentId: null,
          createdAt: NOW_ISO,
          disabledAt: null,
        },
        email,
        displayName,
        status: "invited",
      },
    }));
    const api = {
      collaboration: {
        listInvites: vi.fn(async () => ({ invites: [] })),
        revokeInvite: vi.fn(),
      },
      organizations: {
        list: vi.fn(async () => makeOrganizationListResult()),
        listAuditEvents: vi.fn(async () => ({ events: [] })),
        inviteEmployee,
      },
    } as unknown as EnvironmentApi;
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);
    const addToast = vi.spyOn(toastManager, "add");

    const screen = await render(<OrganizationAdminPanel />);
    try {
      await page.getByLabelText("Email").fill(email);
      await page.getByLabelText("Display name").fill(displayName);
      await page.getByRole("button", { name: "Invite employee" }).click();

      const expectedInviteLink = new URL(
        `/invite?inviteId=${encodeURIComponent(inviteId)}`,
        window.location.origin,
      ).toString();
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "success",
          title: "Employee invite created",
          description: expectedInviteLink,
          actionProps: expect.objectContaining({ children: "Copy" }),
        }),
      );
      expect(inviteEmployee).toHaveBeenCalledWith(
        expect.objectContaining({
          email,
          displayName,
          organizationId: ORGANIZATION_ID,
          tenantId: TENANT_ID,
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
});
