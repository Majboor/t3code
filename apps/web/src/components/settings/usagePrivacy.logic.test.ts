import type { CollaborationConsentResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildUsageConsentUpdate,
  deriveUsageSharingState,
  describeUsageSharing,
  listUsagePrivacyScopes,
  reconcileSelectedScopeKey,
  resolveUsagePrivacyScope,
  type UsagePrivacyScope,
} from "./usagePrivacy.logic";

const project = (
  environmentId: string,
  ownership: {
    tenantId: string;
    workspaceId: string;
    tenant?: string;
    workspace?: string;
  } | null,
) =>
  ({
    environmentId,
    ownership: ownership
      ? {
          tenantId: ownership.tenantId,
          tenantDisplayName: ownership.tenant ?? "Acme",
          workspaceId: ownership.workspaceId,
          workspaceTitle: ownership.workspace ?? "Payments",
          organizationId: null,
          organizationDisplayName: null,
          ownerUserId: null,
          ownerDisplayName: null,
        }
      : null,
  }) as never;

const scope = (overrides: Readonly<Record<string, string>> = {}): UsagePrivacyScope =>
  ({
    key: "env-1::tenant-1::workspace-1",
    environmentId: "env-1",
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    tenantName: "Acme",
    workspaceName: "Payments",
    label: "Acme · Payments",
    ...overrides,
  }) as unknown as UsagePrivacyScope;

const consentResult = (effective: {
  shareProfile: boolean;
  shareUsage: boolean;
  isDecided: boolean;
}): CollaborationConsentResult =>
  ({
    consent: effective.isDecided
      ? {
          tenantId: "tenant-1",
          workspaceId: "workspace-1",
          userId: "user-1",
          shareProfile: effective.shareProfile,
          shareUsage: effective.shareUsage,
          decidedAt: "2026-08-15T00:00:00.000Z",
        }
      : null,
    effective,
  }) as never;

describe("listUsagePrivacyScopes", () => {
  it("lists one entry per workspace, deduped across projects", () => {
    const scopes = listUsagePrivacyScopes([
      project("env-1", { tenantId: "tenant-1", workspaceId: "workspace-1" }),
      project("env-1", { tenantId: "tenant-1", workspaceId: "workspace-1" }),
      project("env-1", {
        tenantId: "tenant-2",
        workspaceId: "workspace-2",
        tenant: "Globex",
        workspace: "Billing",
      }),
    ]);

    expect(scopes).toHaveLength(2);
    expect(scopes[0]?.label).toBe("Acme · Payments");
    expect(scopes[1]?.label).toBe("Globex · Billing");
  });

  it("keeps the same workspace id separate per environment", () => {
    const scopes = listUsagePrivacyScopes([
      project("env-1", { tenantId: "tenant-1", workspaceId: "workspace-1" }),
      project("env-2", { tenantId: "tenant-1", workspaceId: "workspace-1" }),
    ]);

    expect(scopes.map((entry) => entry.environmentId)).toEqual(["env-1", "env-2"]);
  });

  it("skips projects that belong to no workspace", () => {
    expect(listUsagePrivacyScopes([project("env-1", null)])).toEqual([]);
  });

  it("has nothing to offer when there are no projects at all", () => {
    expect(listUsagePrivacyScopes([])).toEqual([]);
  });
});

describe("resolveUsagePrivacyScope", () => {
  it("uses the only workspace without asking", () => {
    const only = scope();
    expect(resolveUsagePrivacyScope([only], null)).toBe(only);
  });

  it("refuses to guess between several workspaces", () => {
    const first = scope();
    const second = scope({
      key: "env-1::tenant-2::workspace-2",
      workspaceId: "workspace-2",
    });

    expect(resolveUsagePrivacyScope([first, second], null)).toBeNull();
  });

  it("uses the picked workspace once there is one", () => {
    const first = scope();
    const second = scope({
      key: "env-1::tenant-2::workspace-2",
      workspaceId: "workspace-2",
    });

    expect(resolveUsagePrivacyScope([first, second], second.key)).toBe(second);
  });

  it("resolves to nothing when there is no workspace", () => {
    expect(resolveUsagePrivacyScope([], null)).toBeNull();
  });

  it("resolves to nothing when the picked workspace is gone", () => {
    expect(resolveUsagePrivacyScope([scope()], "env-9::tenant-9::workspace-9")).toBeNull();
  });
});

describe("reconcileSelectedScopeKey", () => {
  it("keeps a selection that still exists", () => {
    expect(reconcileSelectedScopeKey([scope()], scope().key)).toBe(scope().key);
  });

  it("drops a selection whose workspace disappeared", () => {
    expect(reconcileSelectedScopeKey([scope()], "env-9::tenant-9::workspace-9")).toBeNull();
  });

  it("leaves an empty selection empty", () => {
    expect(reconcileSelectedScopeKey([scope()], null)).toBeNull();
  });
});

describe("deriveUsageSharingState", () => {
  it("renders as on for someone who was never asked", () => {
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: true,
        isDecided: false,
      }),
    );

    expect(state).toEqual({
      shareUsage: true,
      shareProfile: false,
      isDecided: false,
    });
  });

  it("renders as off for an explicit opt-out", () => {
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: false,
        isDecided: true,
      }),
    );

    expect(state).toEqual({
      shareUsage: false,
      shareProfile: false,
      isDecided: true,
    });
  });

  it("renders as on for someone who explicitly chose to share", () => {
    const state = deriveUsageSharingState(
      consentResult({ shareProfile: true, shareUsage: true, isDecided: true }),
    );

    expect(state).toEqual({
      shareUsage: true,
      shareProfile: true,
      isDecided: true,
    });
  });
});

describe("buildUsageConsentUpdate", () => {
  it("turns usage off while leaving shared profile sharing on", () => {
    const state = deriveUsageSharingState(
      consentResult({ shareProfile: true, shareUsage: true, isDecided: true }),
    );

    expect(buildUsageConsentUpdate({ scope: scope(), state, shareUsage: false })).toEqual({
      tenantId: "tenant-1",
      workspaceId: "workspace-1",
      shareProfile: true,
      shareUsage: false,
    });
  });

  it("turns usage off without switching profile sharing on", () => {
    const state = deriveUsageSharingState(
      consentResult({ shareProfile: false, shareUsage: true, isDecided: true }),
    );

    expect(buildUsageConsentUpdate({ scope: scope(), state, shareUsage: false })).toEqual({
      tenantId: "tenant-1",
      workspaceId: "workspace-1",
      shareProfile: false,
      shareUsage: false,
    });
  });

  it("turns usage back on and still preserves profile sharing", () => {
    const state = deriveUsageSharingState(
      consentResult({ shareProfile: true, shareUsage: false, isDecided: true }),
    );

    expect(buildUsageConsentUpdate({ scope: scope(), state, shareUsage: true })).toEqual({
      tenantId: "tenant-1",
      workspaceId: "workspace-1",
      shareProfile: true,
      shareUsage: true,
    });
  });

  it("writes the profile default unchanged for an undecided member", () => {
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: true,
        isDecided: false,
      }),
    );

    expect(buildUsageConsentUpdate({ scope: scope(), state, shareUsage: false }).shareProfile).toBe(
      false,
    );
  });

  it("addresses the workspace that was picked, not the first one", () => {
    const picked = scope({
      key: "env-2::tenant-2::workspace-2",
      tenantId: "tenant-2",
      workspaceId: "workspace-2",
    });
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: true,
        isDecided: false,
      }),
    );

    expect(buildUsageConsentUpdate({ scope: picked, state, shareUsage: false })).toMatchObject({
      tenantId: "tenant-2",
      workspaceId: "workspace-2",
    });
  });
});

describe("describeUsageSharing", () => {
  it("calls sharing the default when nobody was ever asked", () => {
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: true,
        isDecided: false,
      }),
    );

    expect(describeUsageSharing(state, scope())).toBe(
      "Shared with Payments. This is the default — you have not changed it.",
    );
  });

  it("calls sharing their own choice once they made one", () => {
    const state = deriveUsageSharingState(
      consentResult({ shareProfile: false, shareUsage: true, isDecided: true }),
    );

    expect(describeUsageSharing(state, scope())).toBe("Shared with Payments. You chose this.");
  });

  it("says what is still visible after opting out", () => {
    const state = deriveUsageSharingState(
      consentResult({
        shareProfile: false,
        shareUsage: false,
        isDecided: true,
      }),
    );

    expect(describeUsageSharing(state, scope())).toBe(
      "Hidden from other members of Payments. You still see your own numbers, and workspace billing still counts them.",
    );
  });
});
