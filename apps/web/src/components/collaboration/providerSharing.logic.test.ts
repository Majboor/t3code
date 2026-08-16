import {
  ProviderAccountId,
  TenantId,
  UserId,
  WorkspaceId,
  type ProviderSharingOverviewResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { readMemberAccess, readViewerSharing, readWorkspacePolicy } from "./providerSharing.logic";

const TENANT_ID = TenantId.make("tenant-sharing");
const WORKSPACE_ID = WorkspaceId.make("workspace-sharing");
const VIEWER = UserId.make("user-viewer");
const OTHER = UserId.make("user-other");
const NOW = "2026-08-16T10:00:00.000Z";

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

function account(accountId: string, isDefault: boolean) {
  return {
    accountId: ProviderAccountId.make(accountId),
    provider: "claude" as const,
    label: accountId,
    createdAt: NOW,
    isDefault,
  };
}

function share(accountId: string, enabled: boolean) {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: VIEWER,
    provider: "claude" as const,
    accountId: ProviderAccountId.make(accountId),
    enabled,
    updatedAt: NOW,
  };
}

function workspaceAccount(patch: { userId: UserId; accountId: string; isShared: boolean }) {
  return {
    userId: patch.userId,
    displayName: "Ana",
    provider: "claude" as const,
    accountId: ProviderAccountId.make(patch.accountId),
    label: patch.accountId,
    createdAt: NOW,
    isShared: patch.isShared,
    isWorkspaceDefault: false,
  };
}

function policy(patch: { mode: "own" | "shared"; owner?: UserId; accountId?: string }) {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    provider: "claude" as const,
    mode: patch.mode,
    sharedOwnerUserId: patch.owner ?? null,
    sharedAccountId: patch.accountId ? ProviderAccountId.make(patch.accountId) : null,
    updatedAt: NOW,
  };
}

describe("readViewerSharing", () => {
  it("offers nothing to contribute when no account of that provider is connected", () => {
    const view = readViewerSharing(overview({ viewerAccounts: [] }), "claude");
    expect(view.accounts).toEqual([]);
    expect(view.isSharing).toBe(false);
    expect(view.selectedAccount).toBeNull();
  });

  it("preselects the default account before anything has been shared", () => {
    const view = readViewerSharing(
      overview({ viewerAccounts: [account("work", false), account("personal", true)] }),
      "claude",
    );
    expect(view.selectedAccount?.accountId).toBe("personal");
    expect(view.isSharing).toBe(false);
  });

  it("reads the shared account from the share rather than the default", () => {
    const view = readViewerSharing(
      overview({
        viewerAccounts: [account("work", false), account("personal", true)],
        viewerShares: [share("work", true)],
      }),
      "claude",
    );
    expect(view.isSharing).toBe(true);
    expect(view.selectedAccount?.accountId).toBe("work");
    expect(view.sharedAccountMissing).toBe(false);
  });

  it("treats a disabled share as not sharing", () => {
    const view = readViewerSharing(
      overview({ viewerAccounts: [account("work", true)], viewerShares: [share("work", false)] }),
      "claude",
    );
    expect(view.isSharing).toBe(false);
  });

  it("flags a share whose account has been disconnected", () => {
    const view = readViewerSharing(
      overview({
        viewerAccounts: [account("personal", true)],
        viewerShares: [share("gone", true)],
      }),
      "claude",
    );
    expect(view.sharedAccountMissing).toBe(true);
    expect(view.selectedAccount?.accountId).toBe("personal");
  });

  it("follows the workspace default when no grant names the viewer", () => {
    expect(
      readViewerSharing(overview({ policies: [policy({ mode: "shared" })] }), "claude").access,
    ).toBe("workspace");
    expect(readViewerSharing(overview({}), "claude").access).toBe("own");
  });

  it("lets a grant naming the viewer beat the workspace default", () => {
    const view = readViewerSharing(
      overview({
        policies: [policy({ mode: "shared" })],
        viewerGrants: [
          {
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            userId: VIEWER,
            provider: "claude",
            access: "own",
            updatedAt: NOW,
          },
        ],
      }),
      "claude",
    );
    expect(view.access).toBe("own");
  });

  it("keeps providers apart", () => {
    const view = readViewerSharing(
      overview({ viewerAccounts: [account("personal", true)] }),
      "codex",
    );
    expect(view.accounts).toEqual([]);
  });
});

describe("readWorkspacePolicy", () => {
  it("reports own mode with no problem and no account", () => {
    const view = readWorkspacePolicy(overview({ policies: [policy({ mode: "own" })] }), "claude");
    expect(view.mode).toBe("own");
    expect(view.problem).toBeNull();
    expect(view.account).toBeNull();
  });

  it("resolves the named account", () => {
    const view = readWorkspacePolicy(
      overview({
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
        workspaceAccounts: [workspaceAccount({ userId: OTHER, accountId: "team", isShared: true })],
      }),
      "claude",
    );
    expect(view.account?.accountId).toBe("team");
    expect(view.problem).toBeNull();
  });

  it("flags a policy pointing at an account whose owner has withdrawn it", () => {
    const view = readWorkspacePolicy(
      overview({
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
        workspaceAccounts: [
          workspaceAccount({ userId: OTHER, accountId: "team", isShared: false }),
        ],
      }),
      "claude",
    );
    expect(view.problem).toBe("not-shared");
    expect(view.candidates).toEqual([]);
  });

  it("flags a policy pointing at an account that no longer exists", () => {
    const view = readWorkspacePolicy(
      overview({ policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })] }),
      "claude",
    );
    expect(view.problem).toBe("no-account");
    expect(view.account).toBeNull();
  });

  it("offers only shared accounts of that provider as candidates", () => {
    const view = readWorkspacePolicy(
      overview({
        workspaceAccounts: [
          workspaceAccount({ userId: OTHER, accountId: "team", isShared: true }),
          workspaceAccount({ userId: VIEWER, accountId: "private", isShared: false }),
          {
            ...workspaceAccount({ userId: OTHER, accountId: "cx", isShared: true }),
            provider: "codex",
          },
        ],
      }),
      "claude",
    );
    expect(view.candidates.map((entry) => entry.accountId)).toEqual(["team"]);
  });
});

describe("readMemberAccess", () => {
  it("falls back to the workspace default when nobody has been named", () => {
    expect(
      readMemberAccess(overview({ policies: [policy({ mode: "shared" })] }), OTHER, "claude"),
    ).toEqual({ access: "workspace", isExplicit: false });
    expect(readMemberAccess(overview({}), OTHER, "claude")).toEqual({
      access: "own",
      isExplicit: false,
    });
  });

  it("prefers the grant naming that person for that provider", () => {
    const result = readMemberAccess(
      overview({
        policies: [policy({ mode: "shared" })],
        grants: [
          {
            tenantId: TENANT_ID,
            workspaceId: WORKSPACE_ID,
            userId: OTHER,
            provider: "claude",
            access: "own",
            updatedAt: NOW,
          },
        ],
      }),
      OTHER,
      "claude",
    );
    expect(result).toEqual({ access: "own", isExplicit: true });
  });
});
