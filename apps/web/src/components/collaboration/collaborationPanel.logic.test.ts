import {
  CollaborationActivityId,
  ProviderAccountId,
  ProviderUsageRequestId,
  TenantId,
  UserId,
  WorkspaceId,
  type CollaborationActivity,
  type CollaborationBranchClaim,
  type CollaborationMember,
  type CollaborationPresence,
  type ProviderConnectedAccount,
  type ProviderSharingOverviewResult,
  type ProviderUsageRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildActivitySparkline,
  buildCollaborationOverview,
  closeCollaborationSection,
  COLLABORATION_PANEL_ROOT,
  COLLABORATION_SECTION_ORDER,
  formatActivitySpan,
  formatCompactTokens,
  openCollaborationSection,
  presenceInitials,
  resolveVisibleSection,
  type CollaborationOverviewInput,
  type CollaborationOverviewRow,
  type CollaborationSectionId,
} from "./collaborationPanel.logic";

const TENANT_ID = TenantId.make("tenant-panel");
const WORKSPACE_ID = WorkspaceId.make("workspace-panel");
const VIEWER = UserId.make("user-viewer");
const OTHER = UserId.make("user-other");
const NOW = Date.parse("2026-08-19T12:00:00.000Z");

function makeActivity(minutesAgo: number, patch: Partial<CollaborationActivity> = {}) {
  return {
    id: CollaborationActivityId.make(`activity-${minutesAgo}`),
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    threadId: null,
    userId: VIEWER,
    kind: "prompted" as const,
    summary: `Something happened ${minutesAgo} minutes ago`,
    hiddenAt: null,
    createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    ...patch,
  } satisfies CollaborationActivity;
}

function makePresence(
  userId: string,
  status: CollaborationPresence["status"],
  patch: Partial<CollaborationPresence> = {},
): CollaborationPresence {
  return {
    userId: UserId.make(userId),
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    threadId: null,
    displayName: "Ada Lovelace",
    avatarInitials: "AL",
    status,
    lastSeenAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

function makeMember(patch: Partial<CollaborationMember> = {}): CollaborationMember {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: VIEWER,
    displayName: "Ada Lovelace",
    email: null,
    avatarInitials: "AL",
    color: "hsl(215 80% 58%)",
    colorIsCustom: false,
    roles: ["developer"],
    isLead: false,
    isApprover: false,
    status: "idle",
    lastSeenAt: new Date(NOW).toISOString(),
    joinedAt: null,
    sharesProfile: true,
    sharesUsage: false,
    promptCount: null,
    pendingApprovalCount: null,
    tokensUsed: null,
    ...patch,
  };
}

function makeClaim(patch: Partial<CollaborationBranchClaim> = {}): CollaborationBranchClaim {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: VIEWER,
    displayName: "Ada Lovelace",
    branch: "collab/ada",
    baseBranch: "main",
    worktreePath: "/tmp/work-ada",
    claimedAt: new Date(NOW).toISOString(),
    ...patch,
  } as CollaborationBranchClaim;
}

function makeAccount(provider: "claude" | "codex", id = "personal"): ProviderConnectedAccount {
  return {
    accountId: ProviderAccountId.make(id),
    provider,
    label: `${provider} ${id}`,
    createdAt: new Date(NOW).toISOString(),
    isDefault: true,
  };
}

function makeSharing(
  patch: Partial<ProviderSharingOverviewResult> = {},
): ProviderSharingOverviewResult {
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

function makeRequest(
  patch: Omit<Partial<ProviderUsageRequest>, "id"> & { id: string },
): ProviderUsageRequest {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    requesterUserId: OTHER,
    requesterDisplayName: "Bo",
    provider: "claude",
    reason: "no-account",
    note: null,
    status: "pending",
    createdAt: new Date(NOW).toISOString(),
    respondedAt: null,
    respondedByUserId: null,
    ...patch,
    id: ProviderUsageRequestId.make(patch.id),
  };
}

function makeInput(patch: Partial<CollaborationOverviewInput> = {}): CollaborationOverviewInput {
  return {
    now: NOW,
    activities: [],
    presence: [],
    members: null,
    governance: {
      loaded: false,
      approvalMode: null,
      pendingApprovalCount: 0,
      canDecide: false,
      contendedCount: 0,
      branchClaims: [],
      myBranchClaim: null,
    },
    sharing: null,
    requests: null,
    ...patch,
  };
}

function makeGovernance(
  patch: Partial<CollaborationOverviewInput["governance"]> = {},
): CollaborationOverviewInput["governance"] {
  return {
    loaded: true,
    approvalMode: "blocking",
    pendingApprovalCount: 0,
    canDecide: false,
    contendedCount: 0,
    branchClaims: [],
    myBranchClaim: null,
    ...patch,
  };
}

function rowFor(
  rows: readonly CollaborationOverviewRow[],
  id: CollaborationSectionId,
): CollaborationOverviewRow | undefined {
  return rows.find((row) => row.id === id);
}

describe("presenceInitials", () => {
  it("prefers what the server worked out", () => {
    expect(presenceInitials({ avatarInitials: "ZZ", displayName: "Ada Lovelace" })).toBe("ZZ");
  });

  it("derives two letters when there is nothing saved", () => {
    expect(presenceInitials({ avatarInitials: null, displayName: "ada lovelace king" })).toBe("AL");
  });

  it("never renders nothing at all", () => {
    expect(presenceInitials({ avatarInitials: "   ", displayName: "   " })).toBe("U");
  });
});

describe("buildActivitySparkline", () => {
  it("counts entries into equal slices of the window they cover", () => {
    const sparkline = buildActivitySparkline(
      [makeActivity(60), makeActivity(30), makeActivity(1), makeActivity(2)],
      { now: NOW, buckets: 4 },
    );

    expect(sparkline).not.toBeNull();
    expect(sparkline?.buckets.map((bucket) => bucket.count)).toEqual([1, 0, 1, 2]);
    expect(sparkline?.total).toBe(4);
    expect(sparkline?.max).toBe(2);
    expect(sparkline?.spanMs).toBe(60 * 60_000);
  });

  it("refuses to draw a chart from a single entry", () => {
    expect(buildActivitySparkline([makeActivity(5)], { now: NOW })).toBeNull();
    expect(buildActivitySparkline([], { now: NOW })).toBeNull();
  });

  it("ignores timestamps it cannot read rather than plotting them at zero", () => {
    const sparkline = buildActivitySparkline(
      [makeActivity(10), { createdAt: "not a date" }, makeActivity(0)],
      { now: NOW, buckets: 2 },
    );

    expect(sparkline?.total).toBe(2);
  });

  it("survives a clock that runs behind the entries it is plotting", () => {
    // `now` before the newest entry would otherwise give a negative span and a
    // bucket index off the end of the array.
    const sparkline = buildActivitySparkline([makeActivity(10), makeActivity(-5)], {
      now: NOW - 20 * 60_000,
      buckets: 3,
    });

    expect(sparkline?.total).toBe(2);
    expect(sparkline?.buckets).toHaveLength(3);
    expect(sparkline?.buckets.every((bucket) => bucket.count >= 0)).toBe(true);
  });
});

describe("formatActivitySpan", () => {
  it("names the coarsest unit that is still true", () => {
    expect(formatActivitySpan(20_000)).toBe("under a minute");
    expect(formatActivitySpan(60_000)).toBe("1 min");
    expect(formatActivitySpan(45 * 60_000)).toBe("45 min");
    expect(formatActivitySpan(3 * 60 * 60_000)).toBe("3h");
    expect(formatActivitySpan(5 * 24 * 60 * 60_000)).toBe("5 days");
  });
});

describe("formatCompactTokens", () => {
  it("keeps small counts exact and shortens big ones", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(942)).toBe("942");
    expect(formatCompactTokens(12_400)).toBe("12.4K");
    expect(formatCompactTokens(3_000_000)).toBe("3M");
  });
});

describe("buildCollaborationOverview", () => {
  it("leaves out sections that have not answered yet, rather than calling them empty", () => {
    const rows = buildCollaborationOverview(makeInput());
    expect(rows.map((row) => row.id)).toEqual(["activity"]);
  });

  it("keeps the sections in one order however many are available", () => {
    const rows = buildCollaborationOverview(
      makeInput({
        presence: [makePresence("user-viewer", "active")],
        members: [makeMember()],
        governance: {
          loaded: true,
          approvalMode: "open",
          pendingApprovalCount: 0,
          canDecide: false,
          contendedCount: 0,
          branchClaims: [],
          myBranchClaim: null,
        },
        sharing: makeSharing(),
        requests: {
          requests: [],
          canRespond: false,
          viewerUserId: VIEWER,
          viewerAccounts: [makeAccount("claude"), makeAccount("codex")],
        },
      }),
    );

    expect(rows.map((row) => row.id)).toEqual([...COLLABORATION_SECTION_ORDER]);
  });

  describe("activity", () => {
    it("summarises the window the chart covers", () => {
      const rows = buildCollaborationOverview(
        makeInput({ activities: [makeActivity(120), makeActivity(4)] }),
      );
      const row = rowFor(rows, "activity");

      expect(row?.summary).toBe("2 updates over 2h");
      expect(row?.sparkline).not.toBeNull();
      expect(row?.quiet).toBe(false);
    });

    it("says how long ago instead of drawing one bar", () => {
      const rows = buildCollaborationOverview(makeInput({ activities: [makeActivity(9)] }));
      const row = rowFor(rows, "activity");

      expect(row?.summary).toBe("1 update, 9 min ago");
      expect(row?.sparkline).toBeNull();
    });

    it("says nothing has been shared rather than drawing an empty axis", () => {
      const row = rowFor(buildCollaborationOverview(makeInput()), "activity");

      expect(row?.summary).toBe("Nothing shared in this thread yet");
      expect(row?.sparkline).toBeNull();
      expect(row?.quiet).toBe(true);
    });
  });

  describe("people", () => {
    it("counts who is here against the roster, and who is working", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            presence: [
              makePresence("user-viewer", "active"),
              makePresence("user-other", "idle"),
              makePresence("user-gone", "offline"),
            ],
            members: [
              makeMember(),
              makeMember({ userId: OTHER }),
              makeMember({ userId: UserId.make("user-third") }),
            ],
          }),
        ),
        "people",
      );

      expect(row?.summary).toBe("2 of 3 here · 1 working");
    });

    it("counts tokens only across the people who agreed to be counted", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            presence: [makePresence("user-viewer", "active")],
            members: [
              makeMember({ tokensUsed: 12_000 }),
              makeMember({ userId: OTHER, tokensUsed: 400 }),
              makeMember({ userId: UserId.make("user-private"), tokensUsed: null }),
            ],
          }),
        ),
        "people",
      );

      expect(row?.summary).toBe("1 of 3 here · 1 working · 12.4K tokens");
    });

    it("says nothing about tokens when nobody shares them", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            presence: [makePresence("user-viewer", "idle")],
            members: [makeMember({ tokensUsed: null })],
          }),
        ),
        "people",
      );

      expect(row?.summary).toBe("1 of 1 here");
    });

    it("still has something to say before the roster arrives", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({ presence: [makePresence("user-viewer", "active")] }),
        ),
        "people",
      );

      expect(row?.summary).toBe("1 person here · 1 working");
    });

    it("stays quiet rather than absent once a roster is known but empty of presence", () => {
      const row = rowFor(
        buildCollaborationOverview(makeInput({ members: [makeMember()] })),
        "people",
      );

      expect(row?.summary).toBe("1 member, none here now");
      expect(row?.quiet).toBe(true);
    });
  });

  describe("approvals", () => {
    it("only asks the person who can actually clear the queue", () => {
      const mine = rowFor(
        buildCollaborationOverview(
          makeInput({ governance: makeGovernance({ pendingApprovalCount: 2, canDecide: true }) }),
        ),
        "approvals",
      );
      expect(mine?.summary).toBe("2 prompts waiting for you");
      expect(mine?.attention).toBe(true);
      expect(mine?.badge).toBe(2);

      const theirs = rowFor(
        buildCollaborationOverview(
          makeInput({ governance: makeGovernance({ pendingApprovalCount: 1, canDecide: false }) }),
        ),
        "approvals",
      );
      expect(theirs?.summary).toBe("1 prompt waiting for a lead");
      expect(theirs?.attention).toBe(false);
      expect(theirs?.badge).toBe(1);
    });

    it("raises contention when there is nothing waiting for a decision", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({ governance: makeGovernance({ contendedCount: 2 }) }),
        ),
        "approvals",
      );

      expect(row?.summary).toBe("2 files have two people in them");
      expect(row?.attention).toBe(true);
    });

    it("falls back to the rule in force", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({ governance: makeGovernance({ approvalMode: "open" }) }),
        ),
        "approvals",
      );

      expect(row?.summary).toBe("Anyone here can prompt the agent");
      expect(row?.quiet).toBe(true);
    });
  });

  describe("branches", () => {
    it("names the viewer's own branch and counts the rest", () => {
      const mine = makeClaim();
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            governance: makeGovernance({
              myBranchClaim: mine,
              branchClaims: [mine, makeClaim({ userId: OTHER, branch: "collab/bo" })],
            }),
          }),
        ),
        "branch",
      );

      expect(row?.summary).toBe("collab/ada from main · 1 other");
    });

    it("points out a missing branch only where the workspace expects one", () => {
      const staged = rowFor(
        buildCollaborationOverview(
          makeInput({ governance: makeGovernance({ approvalMode: "staged" }) }),
        ),
        "branch",
      );
      expect(staged?.attention).toBe(true);

      const open = rowFor(
        buildCollaborationOverview(makeInput({ governance: makeGovernance({}) })),
        "branch",
      );
      expect(open?.summary).toBe("Everyone is on the shared branch");
      expect(open?.attention).toBe(false);
      expect(open?.quiet).toBe(true);
    });

    it("counts other people's branches when the viewer has none", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            governance: makeGovernance({ branchClaims: [makeClaim({ userId: OTHER })] }),
          }),
        ),
        "branch",
      );

      expect(row?.summary).toBe("1 person is on their own branch");
    });
  });

  describe("provider accounts", () => {
    it("tells apart nothing connected from nothing shared", () => {
      const none = rowFor(
        buildCollaborationOverview(makeInput({ sharing: makeSharing() })),
        "sharing",
      );
      expect(none?.summary).toBe("No provider account connected");

      const connected = rowFor(
        buildCollaborationOverview(
          makeInput({ sharing: makeSharing({ viewerAccounts: [makeAccount("claude")] }) }),
        ),
        "sharing",
      );
      expect(connected?.summary).toBe("Claude connected, nothing shared");
    });

    it("names what is shared and what is not", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            sharing: makeSharing({
              viewerAccounts: [makeAccount("claude"), makeAccount("codex", "cx")],
              viewerShares: [
                {
                  tenantId: TENANT_ID,
                  workspaceId: WORKSPACE_ID,
                  ownerUserId: VIEWER,
                  provider: "claude",
                  accountId: ProviderAccountId.make("personal"),
                  enabled: true,
                  updatedAt: new Date(NOW).toISOString(),
                },
              ],
            }),
          }),
        ),
        "sharing",
      );

      expect(row?.summary).toBe("Sharing Claude · Codex not shared");
    });

    it("raises a share pointing at an account that is gone", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            sharing: makeSharing({
              viewerAccounts: [makeAccount("claude")],
              viewerShares: [
                {
                  tenantId: TENANT_ID,
                  workspaceId: WORKSPACE_ID,
                  ownerUserId: VIEWER,
                  provider: "claude",
                  accountId: ProviderAccountId.make("disconnected"),
                  enabled: true,
                  updatedAt: new Date(NOW).toISOString(),
                },
              ],
            }),
          }),
        ),
        "sharing",
      );

      expect(row?.summary).toBe("Claude is shared, but that account is gone");
      expect(row?.attention).toBe(true);
    });
  });

  describe("usage requests", () => {
    const requests = (patch: Partial<NonNullable<CollaborationOverviewInput["requests"]>>) => ({
      requests: [],
      canRespond: false,
      viewerUserId: VIEWER as string,
      viewerAccounts: [makeAccount("claude"), makeAccount("codex", "cx")],
      ...patch,
    });

    it("puts somebody else's ask ahead of the viewer's own state", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            requests: requests({
              canRespond: true,
              requests: [makeRequest({ id: "req-bo" })],
            }),
          }),
        ),
        "requests",
      );

      expect(row?.summary).toBe("Bo is asking to use your account");
      expect(row?.attention).toBe(true);
      expect(row?.badge).toBe(1);
    });

    it("reports a request the viewer is still waiting on", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({
            requests: requests({
              requests: [makeRequest({ id: "req-mine", requesterUserId: VIEWER })],
            }),
          }),
        ),
        "requests",
      );

      expect(row?.summary).toBe("Waiting on Claude");
    });

    it("says plainly when a provider has no account behind it", () => {
      const row = rowFor(
        buildCollaborationOverview(
          makeInput({ requests: requests({ viewerAccounts: [makeAccount("codex", "cx")] }) }),
        ),
        "requests",
      );

      expect(row?.summary).toBe("No Claude account — those turns are refused");
      expect(row?.attention).toBe(true);
    });

    it("tells a contributor nobody has asked, and everybody else nothing to ask for", () => {
      const contributor = rowFor(
        buildCollaborationOverview(makeInput({ requests: requests({ canRespond: true }) })),
        "requests",
      );
      expect(contributor?.summary).toBe("Nobody has asked to use your accounts");

      const member = rowFor(
        buildCollaborationOverview(makeInput({ requests: requests({}) })),
        "requests",
      );
      expect(member?.summary).toBe("Nothing to ask for");
    });
  });
});

describe("navigation", () => {
  const rows = buildCollaborationOverview(
    makeInput({ activities: [makeActivity(60), makeActivity(2)], sharing: makeSharing() }),
  );

  it("opens and closes a section", () => {
    const opened = openCollaborationSection("sharing");
    expect(opened.section).toBe("sharing");
    expect(closeCollaborationSection()).toEqual(COLLABORATION_PANEL_ROOT);
  });

  it("draws the section that is open", () => {
    expect(resolveVisibleSection(openCollaborationSection("sharing"), rows)).toBe("sharing");
    expect(resolveVisibleSection(COLLABORATION_PANEL_ROOT, rows)).toBeNull();
  });

  it("returns somebody to the overview when the section they were in disappears", () => {
    // A request list that empties, or a roster that fails on a reconnect, would
    // otherwise leave a blank panel with a back button on it.
    expect(resolveVisibleSection(openCollaborationSection("requests"), rows)).toBeNull();
  });
});
