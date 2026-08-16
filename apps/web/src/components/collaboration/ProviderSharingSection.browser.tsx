import "../../index.css";

import {
  ProviderAccountId,
  TenantId,
  UserId,
  WorkspaceId,
  type ProviderConnectedAccount,
  type ProviderSharingOverviewResult,
} from "@t3tools/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ProviderSharing } from "../../hooks/useProviderSharing";
import { ProviderSharingSection } from "./ProviderSharingSection";

const TENANT_ID = TenantId.make("tenant-sharing-browser");
const WORKSPACE_ID = WorkspaceId.make("workspace-sharing-browser");
const VIEWER = UserId.make("user-sharing-browser");
const NOW = "2026-08-16T10:00:00.000Z";

function claudeAccount(accountId: string, isDefault: boolean): ProviderConnectedAccount {
  return {
    accountId: ProviderAccountId.make(accountId),
    provider: "claude",
    label: `Claude ${accountId}`,
    createdAt: NOW,
    isDefault,
  };
}

function overview(patch: Partial<ProviderSharingOverviewResult>): ProviderSharingOverviewResult {
  return {
    viewerUserId: VIEWER,
    canManage: false,
    viewerAccounts: [],
    viewerShares: [],
    viewerGrants: [],
    policies: [],
    grants: [],
    workspaceAccounts: [],
    ...patch,
  };
}

function makeSharing(result: ProviderSharingOverviewResult): ProviderSharing {
  return {
    overview: result,
    loading: false,
    refresh: vi.fn(),
    setShare: vi.fn(async () => undefined),
    setPolicy: vi.fn(async () => undefined),
    setMemberAccess: vi.fn(async () => undefined),
  };
}

// The section links to Settings → Connections, and a router link needs a router.
async function renderSection(input: { sharing: ProviderSharing; onManage?: () => void }) {
  const rootRoute = createRootRoute({
    component: () => (
      <ProviderSharingSection
        sharing={input.sharing}
        workspaceTitle="Payments Team"
        onManage={input.onManage}
      />
    ),
  });
  return render(
    <RouterProvider
      router={createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ["/"] }),
      })}
    />,
  );
}

describe("ProviderSharingSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the workspace the switches apply to", async () => {
    const screen = await renderSection({ sharing: makeSharing(overview({})) });
    try {
      await expect.element(page.getByText("Payments Team").first()).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("offers a way to connect instead of a switch when nothing is connected", async () => {
    const screen = await renderSection({ sharing: makeSharing(overview({})) });
    try {
      await expect.element(page.getByText("Connect Claude")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="provider-sharing-toggle"]')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("contributes the default account when the switch goes on", async () => {
    const sharing = makeSharing(
      overview({ viewerAccounts: [claudeAccount("work", false), claudeAccount("personal", true)] }),
    );
    const screen = await renderSection({ sharing });
    try {
      await page.getByRole("switch", { name: /contribute my claude/i }).click();
      expect(sharing.setShare).toHaveBeenCalledWith({
        provider: "claude",
        accountId: "personal",
        enabled: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("only offers a picker once there is more than one account and something is shared", async () => {
    const sharing = makeSharing(
      overview({
        viewerAccounts: [claudeAccount("work", false), claudeAccount("personal", true)],
        viewerShares: [
          {
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            ownerUserId: VIEWER,
            provider: "claude",
            accountId: ProviderAccountId.make("personal"),
            enabled: true,
            updatedAt: NOW,
          },
        ],
      }),
    );
    const screen = await renderSection({ sharing });
    try {
      await page.getByRole("button", { name: "Claude work" }).click();
      expect(sharing.setShare).toHaveBeenCalledWith({
        provider: "claude",
        accountId: "work",
        enabled: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the admin dialog out of reach of members who cannot manage", async () => {
    const onManage = vi.fn();
    const member = await renderSection({ sharing: makeSharing(overview({})), onManage });
    try {
      expect(document.querySelectorAll('[data-testid="provider-sharing-manage"]')).toHaveLength(0);
    } finally {
      await member.unmount();
    }

    const admin = await renderSection({
      sharing: makeSharing(overview({ canManage: true })),
      onManage,
    });
    try {
      await page.getByRole("button", { name: "Manage" }).click();
      expect(onManage).toHaveBeenCalled();
    } finally {
      await admin.unmount();
    }
  });
});
