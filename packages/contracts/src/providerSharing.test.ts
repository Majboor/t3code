import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAccountId,
  ProviderAccountShare,
  ProviderAuthKind,
  ProviderConnectedAccount,
  ProviderSharingOverviewResult,
  ProviderSharingPolicyUpdateInput,
  ProviderWorkspaceAccount,
  ProviderWorkspacePolicy,
  TenantId,
  UserId,
  WorkspaceId,
  WS_METHODS,
} from "./index.ts";

const decodeConnectedAccount = Schema.decodeUnknownSync(ProviderConnectedAccount);
const decodeShare = Schema.decodeUnknownSync(ProviderAccountShare);
const decodePolicy = Schema.decodeUnknownSync(ProviderWorkspacePolicy);
const decodeWorkspaceAccount = Schema.decodeUnknownSync(ProviderWorkspaceAccount);
const decodeOverview = Schema.decodeUnknownSync(ProviderSharingOverviewResult);
const decodePolicyUpdate = Schema.decodeUnknownSync(ProviderSharingPolicyUpdateInput);

const tenantId = TenantId.make("tenant-acme");
const workspaceId = WorkspaceId.make("workspace-platform");
const ownerUserId = UserId.make("user-ana");
const accountId = ProviderAccountId.make("acct-work");

describe("provider sharing contracts", () => {
  it("names the store's providers, not the orchestration runtime's", () => {
    expect(Schema.decodeUnknownSync(ProviderAuthKind)("claude")).toBe("claude");
    expect(() => Schema.decodeUnknownSync(ProviderAuthKind)("claudeAgent")).toThrow();
  });

  it("keeps a switched-off share as a row so the off switch can win", () => {
    const parsed = decodeShare({
      tenantId,
      workspaceId,
      ownerUserId,
      provider: "codex",
      accountId,
      enabled: false,
      updatedAt: "2026-08-16T09:00:00.000Z",
    });

    expect(parsed.enabled).toBe(false);
    expect(parsed.workspaceId).toBe("workspace-platform");
  });

  it("allows a policy with no account pinned under own mode", () => {
    const parsed = decodePolicy({
      tenantId,
      workspaceId,
      provider: "claude",
      mode: "own",
      sharedOwnerUserId: null,
      sharedAccountId: null,
      updatedAt: "2026-08-16T09:00:00.000Z",
    });

    expect(parsed.mode).toBe("own");
    expect(parsed.sharedAccountId).toBeNull();
  });

  it("lets a policy update clear the pinned account explicitly", () => {
    const parsed = decodePolicyUpdate({
      tenantId,
      workspaceId,
      provider: "claude",
      mode: "own",
      sharedOwnerUserId: null,
      sharedAccountId: null,
    });

    expect(parsed.sharedOwnerUserId).toBeNull();

    const omitted = decodePolicyUpdate({
      tenantId,
      workspaceId,
      provider: "claude",
      mode: "shared",
    });

    expect("sharedAccountId" in omitted).toBe(false);
  });

  it("describes accounts by label only, never by credential", () => {
    const account = decodeConnectedAccount({
      accountId,
      provider: "codex",
      label: "work",
      createdAt: "2026-08-01T00:00:00.000Z",
      isDefault: true,
    });
    const rosterRow = decodeWorkspaceAccount({
      userId: ownerUserId,
      displayName: "Ana",
      provider: "codex",
      accountId,
      label: "work",
      createdAt: "2026-08-01T00:00:00.000Z",
      isShared: true,
      isWorkspaceDefault: false,
    });

    for (const key of [...Object.keys(account), ...Object.keys(rosterRow)]) {
      expect(key).not.toMatch(/token|secret|credential|auth/i);
    }
  });

  it("returns the admin-only halves as empty arrays rather than omitting them", () => {
    const parsed = decodeOverview({
      viewerUserId: ownerUserId,
      canManage: false,
      viewerAccounts: [],
      viewerShares: [],
      viewerGrants: [],
      policies: [],
      grants: [],
      workspaceAccounts: [],
    });

    expect(parsed.grants).toEqual([]);
    expect(parsed.workspaceAccounts).toEqual([]);
  });

  it("exposes the four sharing methods under the spec's names", () => {
    expect(WS_METHODS.providerSharingOverviewGet).toBe("providerSharing.overview.get");
    expect(WS_METHODS.providerSharingShareUpdate).toBe("providerSharing.share.update");
    expect(WS_METHODS.providerSharingPolicyUpdate).toBe("providerSharing.policy.update");
    expect(WS_METHODS.providerSharingMemberUpdate).toBe("providerSharing.member.update");
  });
});
