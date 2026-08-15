import {
  TenantId,
  UserId,
  WorkspaceId,
  type CollaborationMember,
  type CollaborationPresence,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { applyPresenceToRoster } from "./collaborationRoster.logic";

const TENANT_ID = TenantId.make("tenant-roster");
const WORKSPACE_ID = WorkspaceId.make("workspace-roster");

function makeMember(overrides: Partial<CollaborationMember>): CollaborationMember {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: UserId.make("user-1"),
    displayName: "Ada",
    email: null,
    avatarInitials: "A",
    color: "hsl(215 80% 58%)",
    colorIsCustom: false,
    roles: ["developer"],
    isLead: false,
    isApprover: false,
    status: "idle",
    lastSeenAt: "2026-05-09T12:00:00.000Z",
    joinedAt: null,
    sharesProfile: true,
    sharesUsage: false,
    promptCount: null,
    pendingApprovalCount: null,
    tokensUsed: null,
    ...overrides,
  };
}

function makeHeartbeat(
  userId: string,
  status: CollaborationPresence["status"],
  lastSeenAt: string,
): Pick<CollaborationPresence, "userId" | "status" | "lastSeenAt"> {
  return { userId: UserId.make(userId), status, lastSeenAt };
}

describe("applyPresenceToRoster", () => {
  it("moves a known person's status without asking for the roster", () => {
    const members = [
      makeMember({ userId: UserId.make("user-1") }),
      makeMember({ userId: UserId.make("user-2") }),
    ];

    const outcome = applyPresenceToRoster(
      members,
      makeHeartbeat("user-1", "active", "2026-05-09T12:00:30.000Z"),
    );

    expect(outcome.isKnownMember).toBe(true);
    expect(outcome.members[0]?.status).toBe("active");
    expect(outcome.members[0]?.lastSeenAt).toBe("2026-05-09T12:00:30.000Z");
    expect(outcome.members[1]).toBe(members[1]);
  });

  it("keeps the same array when a heartbeat says nothing new", () => {
    const members = [makeMember({ userId: UserId.make("user-1"), status: "active" })];

    const outcome = applyPresenceToRoster(
      members,
      makeHeartbeat("user-1", "active", "2026-05-09T12:00:00.000Z"),
    );

    expect(outcome.isKnownMember).toBe(true);
    expect(outcome.members).toBe(members);
  });

  it("reports an unfamiliar person, because that is a real roster change", () => {
    const members = [makeMember({ userId: UserId.make("user-1") })];

    const outcome = applyPresenceToRoster(
      members,
      makeHeartbeat("user-9", "active", "2026-05-09T12:00:30.000Z"),
    );

    expect(outcome.isKnownMember).toBe(false);
    expect(outcome.members).toBe(members);
  });

  it("reports an unfamiliar person against an empty roster too", () => {
    const outcome = applyPresenceToRoster(
      [],
      makeHeartbeat("user-9", "active", "2026-05-09T12:00:30.000Z"),
    );

    expect(outcome.isKnownMember).toBe(false);
    expect(outcome.members).toEqual([]);
  });
});
