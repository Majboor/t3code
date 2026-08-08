import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, ThreadId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CollaborationServiceLive } from "./CollaborationService.ts";
import { CollaborationService } from "../Services/CollaborationService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";

const tenantId = TenantId.make("tenant-collab");
const workspaceId = WorkspaceId.make("workspace-collab");
const scope = { tenantId, workspaceId };
const threadId = ThreadId.make("thread-collab");
const otherThreadId = ThreadId.make("thread-collab-other");

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

it.effect("refuses a turn until an approval exists, then spends it once", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });

    const blocked = yield* collaboration.consumeApprovalForTurn(member, scope);
    assert.strictEqual(blocked.mayRun, false);

    const submitted = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "needs a yes",
    });
    const approvalId = submitted.approval?.id;
    assert.ok(approvalId);

    // Still refused while the request is only pending.
    const pending = yield* collaboration.consumeApprovalForTurn(member, scope);
    assert.strictEqual(pending.mayRun, false);

    yield* collaboration.decideApproval(lead, { ...scope, approvalId, decision: "approved" });

    const allowed = yield* collaboration.consumeApprovalForTurn(member, scope);
    assert.strictEqual(allowed.mayRun, true);

    // One yes buys exactly one turn.
    const replayed = yield* collaboration.consumeApprovalForTurn(member, scope);
    assert.strictEqual(replayed.mayRun, false);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lets the author re-send an approved prompt instead of queueing it again", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });
    const submitted = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "needs a yes",
    });
    const approvalId = submitted.approval?.id;
    assert.ok(approvalId);
    yield* collaboration.decideApproval(lead, { ...scope, approvalId, decision: "approved" });

    const resent = yield* collaboration.submitPromptForApproval(member, {
      ...scope,
      prompt: "needs a yes",
    });
    assert.strictEqual(resent.mayRun, true);
    assert.strictEqual(resent.approval?.id, approvalId);

    const queue = yield* collaboration.listApprovals(lead, scope);
    assert.strictEqual(queue.approvals.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("does not withhold the run in staged mode", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "staged" });

    const allowed = yield* collaboration.consumeApprovalForTurn(member, scope);
    assert.strictEqual(allowed.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lets an author take one prompt out of the shared history", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const kept = yield* collaboration.recordSharedPrompt(member, {
      ...scope,
      threadId,
      prompt: "keep this one",
    });
    const secret = yield* collaboration.recordSharedPrompt(member, {
      ...scope,
      threadId,
      prompt: "do not share this one",
    });

    yield* collaboration.setActivityVisibility(member, {
      ...scope,
      activityId: secret.activity.id,
      hidden: true,
    });

    // Everyone else sees the rest of the history, minus the hidden entry.
    const asLead = yield* collaboration.listActivity(lead, scope);
    const leadSummaries = asLead.activities.map((activity) => activity.summary);
    assert.ok(leadSummaries.some((summary) => summary.includes("keep this one")));
    assert.ok(!leadSummaries.some((summary) => summary.includes("do not share this one")));

    // The author keeps their own full history.
    const asAuthor = yield* collaboration.listActivity(member, scope);
    const authorSummaries = asAuthor.activities.map((activity) => activity.summary);
    assert.ok(authorSummaries.some((summary) => summary.includes("do not share this one")));

    // And can put it back.
    yield* collaboration.setActivityVisibility(member, {
      ...scope,
      activityId: secret.activity.id,
      hidden: false,
    });
    const restored = yield* collaboration.listActivity(lead, scope);
    assert.ok(
      restored.activities.some((activity) => activity.summary.includes("do not share this one")),
    );
    assert.strictEqual(kept.activity.hiddenAt, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("does not let anyone else edit your shared history", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const recorded = yield* collaboration.recordSharedPrompt(member, {
      ...scope,
      threadId,
      prompt: "mine to curate",
    });

    // Even the lead cannot hide someone else's entry.
    const refused = yield* collaboration
      .setActivityVisibility(lead, { ...scope, activityId: recorded.activity.id, hidden: true })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "not-an-approver");
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

    const claimed = yield* collaboration.listBranchClaims(member, scope);
    assert.strictEqual(claimed.claims.length, 2);
    // The caller gets their own claim picked out, so a browser never has to
    // know which user it is signed in as.
    assert.strictEqual(claimed.mine?.branch, "member/work");
    const asLead = yield* collaboration.listBranchClaims(lead, scope);
    assert.strictEqual(asLead.mine?.branch, "lead/work");

    // Re-claiming replaces rather than accumulates.
    yield* collaboration.claimBranch(member, {
      ...scope,
      branch: "member/other",
      baseBranch: "main",
      worktreePath: "/tmp/member-2",
    });
    const replaced = yield* collaboration.listBranchClaims(member, scope);
    assert.strictEqual(replaced.claims.length, 2);
    assert.ok(replaced.claims.some((claim) => claim.branch === "member/other"));

    const released = yield* collaboration.releaseBranch(member, scope);
    assert.strictEqual(released.released, true);
    const remaining = yield* collaboration.listBranchClaims(member, scope);
    assert.strictEqual(remaining.claims.length, 1);
    assert.strictEqual(remaining.mine, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a viewer-only membership out of the workspace's turns", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    // Nobody with a membership on record yet, so nothing is read-only.
    const unknown = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(unknown.mayRun, true);

    const watchOnly = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "member@example.com",
      scope: "workspace",
      roles: ["viewer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(member, { inviteId: watchOnly.invite.id });

    const refused = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(refused.mayRun, false);

    // A second role alongside `viewer` is enough to work again.
    const alsoDeveloper = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "delegate@example.com",
      scope: "workspace",
      roles: ["viewer", "developer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(delegate, { inviteId: alsoDeveloper.invite.id });

    const allowed = yield* collaboration.checkWriteAccessForTurn(delegate, scope);
    assert.strictEqual(allowed.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("takes a member's write access away and gives it back", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    // Configuring the workspace is what makes this caller the lead, and only a
    // lead or approver may change anyone's membership.
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "open" });

    const invite = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "member@example.com",
      scope: "workspace",
      roles: ["developer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(member, { inviteId: invite.invite.id });
    const before = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(before.mayRun, true);

    yield* collaboration.updateMember(lead, { ...scope, userId: member.userId, readOnly: true });
    const muted = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(muted.mayRun, false);

    yield* collaboration.updateMember(lead, { ...scope, userId: member.userId, readOnly: false });
    const restored = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(restored.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses to make the lead read-only", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    // Configuring the workspace is what makes this caller the lead.
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "blocking" });

    const refused = yield* Effect.flip(
      collaboration.updateMember(lead, { ...scope, userId: lead.userId, readOnly: true }),
    );

    assert.strictEqual(refused.code, "invalid-membership-rule");
    const stillWrites = yield* collaboration.checkWriteAccessForTurn(lead, scope);
    assert.strictEqual(stillWrites.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("adds up the tokens a member has spent across their threads", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: true,
      shareUsage: true,
    });

    yield* collaboration.recordUsage(member, { ...scope, threadId, totalTokens: 120 });
    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId: otherThreadId,
      totalTokens: 80,
    });

    const combined = yield* collaboration.listMembers(lead, scope);
    assert.strictEqual(
      combined.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      200,
    );

    // A thread reports a running total, so the same figure twice adds nothing
    // and a larger one only adds the difference.
    yield* collaboration.recordUsage(member, { ...scope, threadId, totalTokens: 120 });
    yield* collaboration.recordUsage(member, { ...scope, threadId, totalTokens: 300 });

    const grown = yield* collaboration.listMembers(lead, scope);
    assert.strictEqual(
      grown.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      380,
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("withholds a member's tokens until they agree to share usage", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const recorded = yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 500,
    });
    // Your own usage is never hidden from you.
    assert.strictEqual(recorded.member.tokensUsed, 500);

    const asLead = yield* collaboration.listMembers(lead, scope);
    assert.strictEqual(
      asLead.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      null,
    );

    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: false,
      shareUsage: true,
    });

    const shared = yield* collaboration.listMembers(lead, scope);
    assert.strictEqual(
      shared.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      500,
    );
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
