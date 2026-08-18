import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderAccountId,
  ProviderUsageError,
  ProviderUsageRequest,
  ProviderUsageRequestCreateInput,
  ProviderUsageRequestId,
  ProviderUsageRequestListResult,
  ProviderUsageRequestRespondInput,
  ProviderUsageRequestStatus,
  TenantId,
  UserId,
  WorkspaceId,
  WS_METHODS,
} from "./index.ts";

const decodeRequest = Schema.decodeUnknownSync(ProviderUsageRequest);
const decodeCreate = Schema.decodeUnknownSync(ProviderUsageRequestCreateInput);
const decodeRespond = Schema.decodeUnknownSync(ProviderUsageRequestRespondInput);
const decodeList = Schema.decodeUnknownSync(ProviderUsageRequestListResult);

const tenantId = TenantId.make("tenant-acme");
const workspaceId = WorkspaceId.make("workspace-platform");
const requesterUserId = UserId.make("user-bo");
const requestId = ProviderUsageRequestId.make("usage-req-1");

const pendingRequest = {
  id: requestId,
  tenantId,
  workspaceId,
  requesterUserId,
  requesterDisplayName: "Bo",
  provider: "claude",
  reason: "no-account",
  note: null,
  status: "pending",
  createdAt: "2026-08-16T09:00:00.000Z",
  respondedAt: null,
  respondedByUserId: null,
};

describe("provider usage request contracts", () => {
  it("shares the store's provider vocabulary with sharing, not the runtime's", () => {
    expect(decodeRequest({ ...pendingRequest, provider: "codex" }).provider).toBe("codex");
    expect(() => decodeRequest({ ...pendingRequest, provider: "claudeAgent" })).toThrow();
  });

  it("keeps the reason the requester gave rather than one derived later", () => {
    const asked = decodeRequest({ ...pendingRequest, reason: "limit-reached" });

    // A request granted long after the fact still says why it was made.
    const answered = decodeRequest({
      ...asked,
      status: "granted",
      respondedAt: "2026-08-16T10:00:00.000Z",
      respondedByUserId: "user-ana",
    });

    expect(answered.reason).toBe("limit-reached");
  });

  it("separates a withdrawal from a decline, and leaves neither responder implied", () => {
    const withdrawn = decodeRequest({
      ...pendingRequest,
      status: "withdrawn",
      respondedAt: "2026-08-16T09:30:00.000Z",
      respondedByUserId: null,
    });
    const declined = decodeRequest({
      ...pendingRequest,
      status: "declined",
      respondedAt: "2026-08-16T09:30:00.000Z",
      respondedByUserId: "user-ana",
    });

    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.respondedByUserId).toBeNull();
    expect(declined.respondedByUserId).toBe("user-ana");
    expect(Schema.decodeUnknownSync(ProviderUsageRequestStatus)("granted")).toBe("granted");
  });

  it("never lets the input name the requester", () => {
    const parsed = decodeCreate({
      tenantId,
      workspaceId,
      provider: "claude",
      reason: "no-account",
      requesterUserId: "user-someone-else",
    });

    expect("requesterUserId" in parsed).toBe(false);
  });

  it("takes an omitted note and a cleared one alike", () => {
    const omitted = decodeCreate({
      tenantId,
      workspaceId,
      provider: "claude",
      reason: "asked",
    });
    const cleared = decodeCreate({
      tenantId,
      workspaceId,
      provider: "claude",
      reason: "asked",
      note: null,
    });
    const written = decodeCreate({
      tenantId,
      workspaceId,
      provider: "claude",
      reason: "asked",
      note: "  just for the migration  ",
    });

    expect("note" in omitted).toBe(false);
    expect(cleared.note).toBeNull();
    expect(written.note).toBe("just for the migration");
  });

  it("names an account on a grant and needs none on a decline", () => {
    const granted = decodeRespond({
      tenantId,
      workspaceId,
      requestId,
      decision: "grant",
      accountId: ProviderAccountId.make("acct-work"),
    });
    const declined = decodeRespond({
      tenantId,
      workspaceId,
      requestId,
      decision: "decline",
    });

    expect(granted.accountId).toBe("acct-work");
    expect("accountId" in declined).toBe(false);
    expect(() => decodeRespond({ tenantId, workspaceId, requestId, decision: "maybe" })).toThrow();
  });

  it("reports whether the viewer can respond even with nothing to respond to", () => {
    const parsed = decodeList({ requests: [], canRespond: true });

    expect(parsed.requests).toEqual([]);
    expect(parsed.canRespond).toBe(true);
  });

  it("carries no credential material on a request", () => {
    for (const key of Object.keys(decodeRequest(pendingRequest))) {
      expect(key).not.toMatch(/token|secret|credential|auth/i);
    }
  });

  it("keeps the request lifecycle codes out of the sharing error's vocabulary", () => {
    const error = new ProviderUsageError({
      message: "That request has already been answered.",
      code: "request-already-decided",
    });

    expect(error._tag).toBe("ProviderUsageError");
    expect(error.code).toBe("request-already-decided");
  });

  it("exposes the four usage-request methods under the spec's names", () => {
    expect(WS_METHODS.providerUsageRequestCreate).toBe("providerUsage.request.create");
    expect(WS_METHODS.providerUsageRequestList).toBe("providerUsage.request.list");
    expect(WS_METHODS.providerUsageRequestRespond).toBe("providerUsage.request.respond");
    expect(WS_METHODS.providerUsageRequestWithdraw).toBe("providerUsage.request.withdraw");
  });
});
