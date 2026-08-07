import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CollaborationServiceLive } from "./CollaborationService.ts";
import { CollaborationService } from "../Services/CollaborationService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";

const tenantId = TenantId.make("tenant-collab");
const workspaceId = WorkspaceId.make("workspace-collab");
const scope = { tenantId, workspaceId };

const lead = { userId: UserId.make("user-lead"), displayName: "Lead" };
const member = { userId: UserId.make("user-member"), displayName: "Member" };
const delegate = { userId: UserId.make("user-delegate"), displayName: "Delegate" };

/**
 * A fresh database per test. The workspace is never written, so `leadUserId`
 * starts null and the first caller to configure the workspace becomes lead —
 * the bootstrap path the service is built around.
 */
function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-collab-governance-"));
  return CollaborationServiceLive.pipe(
    Layer.provide(TenancyRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "tenancy.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("leaves prompts alone until a workspace turns approvals on", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const before = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "ship it",
    });
    assert.strictEqual(before.mayRun, true);
    assert.strictEqual(before.approval, null);

    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });

    const after = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "ship it",
    });
    assert.strictEqual(after.mayRun, false);
    assert.strictEqual(after.approval?.status, "pending");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lets an approver's own prompt through without queueing it", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });

    const result = yield* collaboration.submitPromptForApproval(lead, {
      ...scope,
      prompt: "lead prompt",
    });

    assert.strictEqual(result.mayRun, true);
    assert.strictEqual(result.approval, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("staged mode runs the prompt but still records it for review", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "staged" });

    const result = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "staged work",
    });

    assert.strictEqual(result.mayRun, true);
    assert.strictEqual(result.approval?.status, "pending");
    assert.strictEqual(result.approval?.mode, "staged");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("only lets approvers decide, and only once", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });
    const submitted = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "needs a yes",
    });
    const approvalId = submitted.approval?.id;
    assert.ok(approvalId);

    const refused = yield* collaboration
      .decideApproval(member, { ...scope, approvalId, decision: "approved" })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "not-an-approver");

    const decided = yield* collaboration.decideApproval(lead, {
      ...scope,
      approvalId,
      decision: "approved",
    });
    assert.strictEqual(decided.approval.status, "approved");
    assert.strictEqual(decided.approval.decidedByUserId, lead.userId);

    const again = yield* collaboration
      .decideApproval(lead, { ...scope, approvalId, decision: "rejected" })
      .pipe(Effect.flip);
    assert.strictEqual(again.code, "approval-already-decided");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("hands approval rights to a delegate without making them lead", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, {
      ...scope,
      approvalMode: "blocking",
      approverUserIds: [delegate.userId],
    });

    const delegateView = yield* collaboration.listApprovals(delegate, scope);
    assert.strictEqual(delegateView.canDecide, true);

    const memberView = yield* collaboration.listApprovals(member, scope);
    assert.strictEqual(memberView.canDecide, false);

    // A delegate is an approver, so their own prompts skip the queue too.
    const delegatePrompt = yield* collaboration.submitPromptForApproval(delegate, {
      ...scope,
      prompt: "delegate prompt",
    });
    assert.strictEqual(delegatePrompt.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps view preferences private to each person", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const initial = yield* collaboration.getViewPreferences(member, scope);
    assert.strictEqual(initial.preferences.showOthersPrompts, true);
    assert.strictEqual(initial.preferences.showOthersFiles, true);

    yield* collaboration.updateViewPreferences(member, {
      ...scope,
      showOthersPrompts: false,
      showOthersFiles: false,
    });

    const mine = yield* collaboration.getViewPreferences(member, scope);
    assert.strictEqual(mine.preferences.showOthersPrompts, false);

    const theirs = yield* collaboration.getViewPreferences(lead, scope);
    assert.strictEqual(theirs.preferences.showOthersPrompts, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("tracks one branch claim per person and releases it", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.claimBranch(member, {
      ...scope,
      branch: "member/work",
      baseBranch: "main",
      worktreePath: "/tmp/member",
    });
    yield* collaboration.claimBranch(lead, {
      ...scope,
      branch: "lead/work",
      baseBranch: "main",
      worktreePath: "/tmp/lead",
    });

    const claimed = yield* collaboration.listBranchClaims(scope);
    assert.strictEqual(claimed.claims.length, 2);

    // Re-claiming replaces rather than accumulates.
    yield* collaboration.claimBranch(member, {
      ...scope,
      branch: "member/other",
      baseBranch: "main",
      worktreePath: "/tmp/member-2",
    });
    const replaced = yield* collaboration.listBranchClaims(scope);
    assert.strictEqual(replaced.claims.length, 2);
    assert.ok(replaced.claims.some((claim) => claim.branch === "member/other"));

    const released = yield* collaboration.releaseBranch(member, scope);
    assert.strictEqual(released.released, true);
    const remaining = yield* collaboration.listBranchClaims(scope);
    assert.strictEqual(remaining.claims.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("records the latest person to touch each path", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.touchFiles(member, { ...scope, paths: ["a.txt", "b.txt"] });
    yield* collaboration.touchFiles(lead, { ...scope, paths: ["a.txt"] });

    const touches = yield* collaboration.listFileTouches(scope);
    assert.strictEqual(touches.touches.length, 2);
    const forA = touches.touches.find((touch) => touch.path === "a.txt");
    assert.strictEqual(forA?.userId, lead.userId);
    const forB = touches.touches.find((touch) => touch.path === "b.txt");
    assert.strictEqual(forB?.userId, member.userId);
  }).pipe(Effect.provide(makeLayer())),
);
