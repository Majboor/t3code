import type { CollaborationMember, TenantId, WorkspaceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  __collaborationMembersCacheForTests as cache,
  __resetCollaborationMembersCacheForTests,
} from "./useCollaborationMembers";

const tenantId = "tenant-1" as TenantId;
const workspaceId = "workspace-1" as WorkspaceId;
const otherWorkspaceId = "workspace-2" as WorkspaceId;
const scope = { tenantId, workspaceId };

const viewerMember: CollaborationMember = {
  userId: "user-viewer",
  displayName: "Ada",
  avatarInitials: "AL",
  color: "blue",
} as CollaborationMember;

beforeEach(() => {
  __resetCollaborationMembersCacheForTests();
});

describe("useCollaborationMembers roster cache", () => {
  // Regression test for the reported bug: a freshly-sent message rendering
  // with the "Someone else" placeholder for the sender's own name, even
  // though this browser had already resolved the roster (and its own
  // viewer id) for that workspace moments earlier. That happens because
  // sending the first message of a local draft thread promotes it onto a
  // different route, remounting the chat view — and, with it, a fresh
  // `useCollaborationMembers()` instance that used to always start from
  // `viewerUserId: null` regardless of what an earlier mount had already
  // learned. The cache is what lets a remount into an already-known
  // workspace skip that cold start.

  it("has nothing cached for a workspace this browser has not resolved yet", () => {
    expect(cache.read(scope)).toBeNull();
  });

  it("returns what a previous mount resolved, for a later mount in the same workspace", () => {
    cache.write(scope, { members: [viewerMember], viewerUserId: viewerMember.userId });

    expect(cache.read(scope)).toEqual({
      members: [viewerMember],
      viewerUserId: viewerMember.userId,
    });
  });

  it("keeps entries for different workspaces apart", () => {
    cache.write(scope, { members: [viewerMember], viewerUserId: viewerMember.userId });

    expect(cache.read({ tenantId, workspaceId: otherWorkspaceId })).toBeNull();
  });

  it("returns nothing when there is no scope to look up (no workspace known yet)", () => {
    expect(cache.read(null)).toBeNull();
  });

  it("overwrites a stale entry with the latest resolved roster", () => {
    cache.write(scope, { members: [], viewerUserId: null });
    cache.write(scope, { members: [viewerMember], viewerUserId: viewerMember.userId });

    expect(cache.read(scope)).toEqual({
      members: [viewerMember],
      viewerUserId: viewerMember.userId,
    });
  });
});
