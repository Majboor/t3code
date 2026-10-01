import {
  ProviderAccountId,
  TenantId,
  UserId,
  WorkspaceId,
  type ProviderSharingOverviewResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeBacking,
  readMemberAccess,
  readMemberBacking,
  readViewerSharing,
  readWorkspaceCarriers,
  readWorkspacePolicy,
} from "./providerSharing.logic";

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

function policy(patch: {
  mode: "own" | "shared";
  owner?: UserId;
  accountId?: string;
  provider?: "claude" | "codex";
}) {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    provider: patch.provider ?? ("claude" as const),
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

describe("readWorkspaceCarriers", () => {
  it("names nobody while every provider runs on each member's own account", () => {
    expect(readWorkspaceCarriers(overview({ policies: [policy({ mode: "own" })] }))).toEqual([]);
    expect(readWorkspaceCarriers(overview({}))).toEqual([]);
  });

  /**
   * The distinction the whole badge rests on. An offered account and a spent
   * one are different states, and badging the first would tell the workspace
   * that Ana is paying for its turns when the policy has never pointed at her.
   */
  it("does not badge an account that is shared but is not the workspace default", () => {
    const result = overview({
      canManage: true,
      // Ana has switched her account on and it is sitting there unused.
      policies: [policy({ mode: "own" })],
      workspaceAccounts: [workspaceAccount({ userId: OTHER, accountId: "team", isShared: true })],
    });
    expect(readWorkspaceCarriers(result)).toEqual([]);
    expect(readMemberBacking(result, OTHER)).toBeNull();
  });

  /**
   * The same trap from the other side: the roster's `isWorkspaceDefault` is set
   * from the policy's pointers without checking its mode, so it can outlive a
   * policy that has gone back to `own`. The badge reads the mode instead.
   */
  it("ignores a stale workspace-default flag once the policy is back on own mode", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: true,
        policies: [policy({ mode: "own" })],
        workspaceAccounts: [
          {
            ...workspaceAccount({ userId: OTHER, accountId: "team", isShared: true }),
            isWorkspaceDefault: true,
          },
        ],
      }),
    );
    expect(result).toEqual([]);
  });

  it("badges the member the policy actually spends, with the account label", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: true,
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
        workspaceAccounts: [workspaceAccount({ userId: OTHER, accountId: "team", isShared: true })],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe(OTHER);
    expect(result[0]?.displayName).toBe("Ana");
    expect(result[0]?.accountLabels).toEqual(["team"]);
    expect(result[0]?.isViewer).toBe(false);
    expect(result[0]?.broken).toBe(false);
    expect(describeBacking(result[0]!)).toBe("Backing Claude");
  });

  it("gathers both providers onto the one person carrying them", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: true,
        policies: [
          policy({ mode: "shared", owner: OTHER, accountId: "team" }),
          policy({ mode: "shared", owner: OTHER, accountId: "cx", provider: "codex" }),
        ],
        workspaceAccounts: [
          workspaceAccount({ userId: OTHER, accountId: "team", isShared: true }),
          {
            ...workspaceAccount({ userId: OTHER, accountId: "cx", isShared: true }),
            provider: "codex" as const,
          },
        ],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.providers).toEqual(["claude", "codex"]);
    expect(describeBacking(result[0]!)).toBe("Backing Claude and Codex");
  });

  it("marks the viewer when it is their own quota being spent", () => {
    const result = readWorkspaceCarriers(
      overview({ policies: [policy({ mode: "shared", owner: VIEWER, accountId: "mine" })] }),
    );
    expect(result[0]?.isViewer).toBe(true);
  });

  /**
   * `workspaceAccounts` is admin-only, so a plain member has no roster to
   * resolve the owner against. They learn that somebody is carrying this and
   * nothing more — in particular not a fault they could not verify.
   */
  it("leaves the name off, and claims no fault, for a member who cannot see the roster", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: false,
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.displayName).toBeNull();
    expect(result[0]?.accountLabels).toEqual([]);
    expect(result[0]?.broken).toBe(false);
  });

  it("tells an admin when the account a policy names has been withdrawn", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: true,
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
        workspaceAccounts: [
          workspaceAccount({ userId: OTHER, accountId: "team", isShared: false }),
        ],
      }),
    );
    expect(result[0]?.broken).toBe(true);
  });

  it("tells an admin when the account a policy names is gone entirely", () => {
    const result = readWorkspaceCarriers(
      overview({
        canManage: true,
        policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
      }),
    );
    expect(result[0]?.broken).toBe(true);
  });

  it("ignores a shared policy that names nobody", () => {
    expect(readWorkspaceCarriers(overview({ policies: [policy({ mode: "shared" })] }))).toEqual([]);
  });
});

describe("readMemberBacking", () => {
  it("answers for one roster row exactly as the workspace list does", () => {
    const result = overview({
      canManage: true,
      policies: [policy({ mode: "shared", owner: OTHER, accountId: "team" })],
      workspaceAccounts: [workspaceAccount({ userId: OTHER, accountId: "team", isShared: true })],
    });
    expect(readMemberBacking(result, OTHER)).toEqual(readWorkspaceCarriers(result)[0]);
    expect(readMemberBacking(result, VIEWER)).toBeNull();
  });
});
