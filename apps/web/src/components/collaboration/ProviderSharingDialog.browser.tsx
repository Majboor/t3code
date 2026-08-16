import "../../index.css";

import {
  ProviderAccountId,
  TenantId,
  UserId,
  WorkspaceId,
  type ProviderSharingOverviewResult,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ProviderSharing } from "../../hooks/useProviderSharing";
import { ProviderSharingDialog } from "./ProviderSharingDialog";

const TENANT_ID = TenantId.make("tenant-sharing-dialog");
const WORKSPACE_ID = WorkspaceId.make("workspace-sharing-dialog");
const VIEWER = UserId.make("user-viewer-dialog");
const OWNER = UserId.make("user-owner-dialog");
const NOW = "2026-08-16T10:00:00.000Z";

function overview(patch: Partial<ProviderSharingOverviewResult>): ProviderSharingOverviewResult {
  return {
    viewerUserId: VIEWER,
    canManage: true,
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

function sharedPolicy() {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    provider: "claude" as const,
    mode: "shared" as const,
    sharedOwnerUserId: OWNER,
    sharedAccountId: ProviderAccountId.make("team"),
    updatedAt: NOW,
  };
}

function teamAccount(isShared: boolean) {
  return {
    userId: OWNER,
    displayName: "Ana Owner",
    provider: "claude" as const,
    accountId: ProviderAccountId.make("team"),
    label: "Team Claude",
    createdAt: NOW,
    isShared,
    isWorkspaceDefault: true,
  };
}

// The environment is null on purpose: the roster comes from a separate call the
// dialog degrades without, and these cases are about what sharing itself says.
async function renderDialog(sharing: ProviderSharing) {
  return await render(
    <ProviderSharingDialog
      environmentId={null}
      tenantId={TENANT_ID}
      workspaceId={WORKSPACE_ID}
      workspaceTitle="Payments Team"
      sharing={sharing}
      open
      onOpenChange={vi.fn()}
    />,
  );
}

describe("ProviderSharingDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lists every connected account by label, and never anything else", async () => {
    const screen = await renderDialog(
      makeSharing(overview({ policies: [sharedPolicy()], workspaceAccounts: [teamAccount(true)] })),
    );
    try {
      await expect.element(page.getByText("Ana Owner").first()).toBeInTheDocument();
      await expect.element(page.getByText("Contributed").first()).toBeInTheDocument();
      await expect.element(page.getByText("Workspace default").first()).toBeInTheDocument();
      expect(document.body.textContent).toContain("Team Claude");
      expect(document.body.textContent).not.toContain("sk-ant");
    } finally {
      await screen.unmount();
    }
  });

  it("says so when the workspace runs on an account nobody contributes any more", async () => {
    const screen = await renderDialog(
      makeSharing(
        overview({ policies: [sharedPolicy()], workspaceAccounts: [teamAccount(false)] }),
      ),
    );
    try {
      await expect.element(page.getByText(/no longer contributed/i).first()).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("tells an admin nothing has been contributed rather than showing an empty picker", async () => {
    const screen = await renderDialog(makeSharing(overview({})));
    try {
      await expect
        .element(page.getByText(/No Claude account has been contributed here/i).first())
        .toBeInTheDocument();
      await expect
        .element(page.getByText(/Nobody in this workspace has connected/i).first())
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the admin sections out of a member's view", async () => {
    const screen = await renderDialog(makeSharing(overview({ canManage: false })));
    try {
      await expect.element(page.getByText(/Only a workspace admin/i).first()).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="provider-sharing-policy"]')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
