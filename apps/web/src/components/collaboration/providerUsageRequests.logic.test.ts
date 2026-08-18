import {
  ProviderAccountId,
  ProviderUsageRequestId,
  TenantId,
  UserId,
  WorkspaceId,
  type ProviderConnectedAccount,
  type ProviderUsageRequest,
  type ProviderWorkspaceAccount,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeAskReason,
  describeUsageFailure,
  defaultAskReason,
  formatNames,
  pickDefaultAccount,
  readIncomingRequests,
  readPossibleResponders,
  readUsageErrorCode,
  readViewerUsage,
} from "./providerUsageRequests.logic";

const TENANT_ID = TenantId.make("tenant-usage");
const WORKSPACE_ID = WorkspaceId.make("workspace-usage");
const VIEWER = UserId.make("user-viewer");
const OTHER = UserId.make("user-other");

function request(
  patch: Omit<Partial<ProviderUsageRequest>, "id"> & { id: string },
): ProviderUsageRequest {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    requesterUserId: VIEWER,
    requesterDisplayName: "Ana",
    provider: "claude",
    reason: "no-account",
    note: null,
    status: "pending",
    createdAt: "2026-08-16T10:00:00.000Z",
    respondedAt: null,
    respondedByUserId: null,
    ...patch,
    id: ProviderUsageRequestId.make(patch.id),
  };
}

function account(accountId: string, isDefault: boolean): ProviderConnectedAccount {
  return {
    accountId: ProviderAccountId.make(accountId),
    provider: "claude",
    label: accountId,
    createdAt: "2026-08-16T09:00:00.000Z",
    isDefault,
  };
}

function workspaceAccount(patch: {
  userId: UserId;
  displayName: string;
  accountId: string;
}): ProviderWorkspaceAccount {
  return {
    userId: patch.userId,
    displayName: patch.displayName,
    provider: "claude",
    accountId: ProviderAccountId.make(patch.accountId),
    label: patch.accountId,
    createdAt: "2026-08-16T09:00:00.000Z",
    isShared: true,
    isWorkspaceDefault: false,
  };
}

describe("readViewerUsage", () => {
  it("says nothing when this person has never asked", () => {
    const view = readViewerUsage({
      requests: [],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("none");
    expect(view.request).toBeNull();
    expect(view.canAsk).toBe(true);
  });

  it("refuses to offer an ask that the server would reject as already pending", () => {
    const view = readViewerUsage({
      requests: [request({ id: "req-1" })],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("pending");
    expect(view.canAsk).toBe(false);
  });

  it("ignores requests from other people and other providers", () => {
    const view = readViewerUsage({
      requests: [
        request({ id: "req-other", requesterUserId: OTHER }),
        request({ id: "req-codex", provider: "codex" }),
      ],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("none");
  });

  it("treats a withdrawn request as if it had never been asked", () => {
    const view = readViewerUsage({
      requests: [request({ id: "req-1", status: "withdrawn" })],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("none");
    expect(view.canAsk).toBe(true);
  });

  it("reports the most recent answer when several were given", () => {
    const view = readViewerUsage({
      requests: [
        request({
          id: "req-old",
          status: "declined",
          respondedAt: "2026-08-16T11:00:00.000Z",
        }),
        request({
          id: "req-new",
          status: "granted",
          respondedAt: "2026-08-16T12:00:00.000Z",
        }),
      ],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("granted");
    expect(view.request?.id).toBe("req-new");
  });

  it("prefers an open request over any answered one", () => {
    const view = readViewerUsage({
      requests: [
        request({ id: "req-done", status: "declined", respondedAt: "2026-08-16T12:00:00.000Z" }),
        request({ id: "req-open", createdAt: "2026-08-16T13:00:00.000Z" }),
      ],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: false,
    });
    expect(view.state).toBe("pending");
    expect(view.request?.id).toBe("req-open");
  });

  it("notices somebody who asked for want of an account and then connected one", () => {
    const view = readViewerUsage({
      requests: [request({ id: "req-1", reason: "no-account" })],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: true,
    });
    expect(view.askedThenConnected).toBe(true);
  });

  it("does not call it a change of circumstance when they always had one", () => {
    const view = readViewerUsage({
      requests: [request({ id: "req-1", reason: "limit-reached" })],
      viewerUserId: VIEWER,
      provider: "claude",
      hasOwnAccount: true,
    });
    expect(view.askedThenConnected).toBe(false);
  });
});

describe("readIncomingRequests", () => {
  it("shows the longest wait first and never the viewer's own request", () => {
    const incoming = readIncomingRequests({
      requests: [
        request({ id: "req-mine" }),
        request({
          id: "req-late",
          requesterUserId: OTHER,
          createdAt: "2026-08-16T12:00:00.000Z",
        }),
        request({
          id: "req-early",
          requesterUserId: OTHER,
          createdAt: "2026-08-16T08:00:00.000Z",
        }),
      ],
      viewerUserId: VIEWER,
      viewerAccounts: [account("personal", true)],
    });
    expect(incoming.map((entry) => entry.request.id)).toEqual(["req-early", "req-late"]);
  });

  it("leaves out anything already answered", () => {
    const incoming = readIncomingRequests({
      requests: [request({ id: "req-1", requesterUserId: OTHER, status: "granted" })],
      viewerUserId: VIEWER,
      viewerAccounts: [account("personal", true)],
    });
    expect(incoming).toHaveLength(0);
  });

  it("keeps a request it cannot grant, and says so, rather than hiding it", () => {
    const incoming = readIncomingRequests({
      requests: [request({ id: "req-1", requesterUserId: OTHER, provider: "codex" })],
      viewerUserId: VIEWER,
      viewerAccounts: [account("personal", true)],
    });
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.canGrant).toBe(false);
    expect(incoming[0]?.defaultAccountId).toBeNull();
  });

  it("offers the default account as what a grant would spend", () => {
    const incoming = readIncomingRequests({
      requests: [request({ id: "req-1", requesterUserId: OTHER })],
      viewerUserId: VIEWER,
      viewerAccounts: [account("work", false), account("personal", true)],
    });
    expect(incoming[0]?.defaultAccountId).toBe("personal");
    expect(incoming[0]?.accounts).toHaveLength(2);
  });
});

describe("pickDefaultAccount", () => {
  it("falls back to the first account when none is marked default", () => {
    expect(
      pickDefaultAccount([account("work", false), account("personal", false)])?.accountId,
    ).toBe("work");
    expect(pickDefaultAccount([])).toBeNull();
  });
});

describe("readPossibleResponders", () => {
  it("names everybody with an account for that provider, once each, minus the viewer", () => {
    const names = readPossibleResponders({
      workspaceAccounts: [
        workspaceAccount({ userId: OTHER, displayName: "Bo", accountId: "one" }),
        workspaceAccount({ userId: OTHER, displayName: "Bo", accountId: "two" }),
        workspaceAccount({ userId: VIEWER, displayName: "Ana", accountId: "mine" }),
      ],
      provider: "claude",
      viewerUserId: VIEWER,
    });
    expect(names).toEqual(["Bo"]);
  });

  it("is empty for a member who cannot see the roster", () => {
    expect(
      readPossibleResponders({ workspaceAccounts: [], provider: "claude", viewerUserId: VIEWER }),
    ).toEqual([]);
  });
});

describe("formatNames", () => {
  it("reads as a sentence at every length", () => {
    expect(formatNames(["Bo"])).toBe("Bo");
    expect(formatNames(["Bo", "Cy"])).toBe("Bo and Cy");
    expect(formatNames(["Bo", "Cy", "Di"])).toBe("Bo, Cy and 1 other");
    expect(formatNames(["Bo", "Cy", "Di", "Ed"])).toBe("Bo, Cy and 2 others");
  });
});

describe("describeAskReason", () => {
  it("tells a blocked colleague apart from one who has run out", () => {
    const blocked = describeAskReason("no-account", "Claude");
    const spent = describeAskReason("limit-reached", "Claude");
    const preference = describeAskReason("asked", "Claude");
    expect(blocked).not.toBe(spent);
    expect(blocked).toContain("refused");
    expect(spent).toContain("run out");
    expect(preference).toContain("already");
  });
});

describe("defaultAskReason", () => {
  it("asks for want of an account only when there is none", () => {
    expect(defaultAskReason(false)).toBe("no-account");
    expect(defaultAskReason(true)).toBe("asked");
  });
});

describe("readUsageErrorCode", () => {
  it("reads a known code and refuses to invent one", () => {
    expect(readUsageErrorCode({ code: "request-already-decided" })).toBe("request-already-decided");
    expect(readUsageErrorCode({ code: "something-else" })).toBeNull();
    expect(readUsageErrorCode(new Error("boom"))).toBeNull();
    expect(readUsageErrorCode(null)).toBeNull();
  });
});

describe("describeUsageFailure", () => {
  const context = { fallbackTitle: "Could not ask for Claude", providerLabel: "Claude" };

  it("treats losing the race as news rather than a mistake", () => {
    const notice = describeUsageFailure({ code: "request-already-decided" }, context);
    expect(notice.tone).toBe("info");
    expect(notice.title).toBe("Somebody answered first");
  });

  it("treats a duplicate ask as information too", () => {
    expect(describeUsageFailure({ code: "request-already-pending" }, context).tone).toBe("info");
  });

  it("keeps a real refusal an error, and names the provider", () => {
    const notice = describeUsageFailure({ code: "not-a-contributor" }, context);
    expect(notice.tone).toBe("error");
    expect(notice.title).toContain("Claude");
  });

  it("falls back to the caller's title and the thrown message", () => {
    const notice = describeUsageFailure(new Error("socket closed"), context);
    expect(notice.title).toBe("Could not ask for Claude");
    expect(notice.description).toBe("socket closed");
  });
});
