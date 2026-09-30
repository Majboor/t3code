import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId, ThreadId, UserId, WorkspaceId,
  MembershipId,
  OrganizationId,
} from "@t3tools/contracts";
import { decideFilePresence } from "@t3tools/shared/filePresence";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  CollaborationServiceLive,
  defaultMemberColor,
  deriveUsageObservation,
} from "./CollaborationService.ts";
import { CollaborationService } from "../Services/CollaborationService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import type { CollaborationMemberUsageRecord } from "../../persistence/Services/Tenancy.ts";
import {
  ActivityNoteRepositoryLive,
  SharedPromptRepositoryLive,
} from "../../persistence/Layers/ActivityNotes.ts";

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
    // `provideMerge` rather than `provide`: a couple of tests need to write
    // through the repository directly (an organization membership lives in a
    // table the collaboration service never writes), so it has to stay in the
    // context rather than being consumed on the way in.
    Layer.provideMerge(TenancyRepositoryLive),
    Layer.provide(ActivityNoteRepositoryLive),
    Layer.provide(SharedPromptRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "tenancy.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

// Removal has to mean removal — a removed member used to get write access back
// the instant their row was deleted, because "no membership on record" was read
// as "not governed yet". But the fix for that nearly took the ability to start a
// turn away from every ORGANIZATION-scoped member, who legitimately has no row
// in the collaboration map: `loadCollaboration()` reads only
// `organization_id IS NULL`, and they live in the other half of the table.
it.effect("lets an organization member write, and still refuses a removed one", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const repository = yield* TenancyRepository;

    // A lead exists, so the workspace is governed and the ungoverned-desktop
    // allowance does not apply.
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "open" });

    const orgMember = {
      userId: UserId.make("user-org-member"),
      displayName: "Org Member",
    };

    // Nobody at all: refused, which is the removed-member case.
    const stranger = yield* collaboration.checkWriteAccessForTurn(orgMember, scope);
    assert.strictEqual(stranger.mayRun, false, "a caller with no membership anywhere may not write");

    // Now give them a membership through the ORGANIZATION side of the table.
    const organizations = yield* repository.loadOrganizations();
    yield* repository.saveOrganizations({
      ...organizations,
      memberships: [
        ...organizations.memberships,
        {
          id: MembershipId.make("membership:org-member"),
          tenantId: scope.tenantId,
          userId: orgMember.userId,
          organizationId: OrganizationId.make("org-1"),
          roles: ["developer"],
          createdAt: "2026-01-01T00:00:00.000Z",
          disabledAt: null,
        },
      ],
    });

    const allowed = yield* collaboration.checkWriteAccessForTurn(orgMember, scope);
    assert.strictEqual(allowed.mayRun, true, "an organization member may start a turn");
  }).pipe(Effect.provide(makeLayer())),
);

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

// An invite names a person. Redeeming one addressed to somebody else used to
// grant a membership in their tenant — and with it read and write on every
// project root that tenant owns — to whoever happened to open the link.
it.effect("refuses an invite addressed to somebody else", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const invite = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "member@example.com",
      scope: "workspace",
      roles: ["developer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const mallory = {
      userId: UserId.make("user-mallory"),
      displayName: "Mallory",
      email: "mallory@example.com",
    };
    const refused = yield* Effect.flip(
      collaboration.acceptInvite(mallory, { inviteId: invite.invite.id }),
    );
    assert.strictEqual(refused.code, "invalid-invite");

    // Still redeemable by the person it was actually sent to.
    const accepted = yield* collaboration.acceptInvite(
      { ...member, email: "Member@Example.com " },
      { inviteId: invite.invite.id },
    );
    assert.ok(accepted);
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

it.effect("remembers that two people touched the same file, not just the last one", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.touchFiles(member, { ...scope, paths: ["app.py"] });
    yield* collaboration.touchFiles(lead, { ...scope, paths: ["app.py"] });

    const listed = yield* collaboration.listFileTouches(scope);
    const authors = listed.touches
      .filter((touch) => touch.path === "app.py")
      .map((touch) => touch.userId);

    // Keying by path alone overwrote the first author, which made two people in
    // one file indistinguishable from one person in it twice.
    assert.strictEqual(authors.length, 2);
    assert.ok(authors.includes(member.userId));
    assert.ok(authors.includes(lead.userId));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("attributes an agent's writes to the person whose turn it was", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    // Presence is how the workspace learns what to call somebody, and an agent
    // turn has none of its own — so the name has to come from the roster rather
    // than from the caller, which has only a user id to offer.
    yield* collaboration.upsertPresence(member, { ...scope, threadId, status: "active" });

    yield* collaboration.touchFilesForUser(member.userId, { ...scope, paths: ["agent.py"] });

    const listed = yield* collaboration.listFileTouches(scope);
    const touch = listed.touches.find((entry) => entry.path === "agent.py");
    assert.strictEqual(touch?.userId, member.userId);
    assert.strictEqual(touch?.displayName, member.displayName);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lets a turn fill in an unclaimed file but never take somebody else's", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.touchFiles(lead, { ...scope, paths: ["app.py"] });
    yield* collaboration.touchFilesForUser(member.userId, {
      ...scope,
      paths: ["app.py", "worker.py"],
    });

    const listed = yield* collaboration.listFileTouches(scope);
    const authorsOfApp = listed.touches
      .filter((touch) => touch.path === "app.py")
      .map((touch) => touch.userId);
    const authorsOfWorker = listed.touches
      .filter((touch) => touch.path === "worker.py")
      .map((touch) => touch.userId);

    // A turn is told which files differ from the checkpoint it started at, and
    // that set is wider than what the turn changed whenever the checkpoint is
    // older than the turn. Handing the lead's file to the member on that
    // evidence would put the wrong name and colour against it.
    assert.deepStrictEqual(authorsOfApp, [lead.userId]);
    assert.deepStrictEqual(authorsOfWorker, [member.userId]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps one entry per person per file, however often they touch it", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.touchFiles(member, { ...scope, paths: ["app.py"] });
    yield* collaboration.touchFiles(member, { ...scope, paths: ["app.py"] });
    yield* collaboration.touchFiles(member, { ...scope, paths: ["app.py"] });

    const listed = yield* collaboration.listFileTouches(scope);
    assert.strictEqual(listed.touches.filter((touch) => touch.path === "app.py").length, 1);
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

it.effect("counts a member who has never been asked about sharing usage", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const recorded = yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 500,
    });
    // Your own usage is never hidden from you.
    assert.strictEqual(recorded.member.tokensUsed, 500);

    // Usage is shared by default: a workspace that cannot see what it is
    // collectively spending cannot manage it, so silence counts as sharing.
    const asLead = yield* collaboration.listMembers(lead, scope);
    assert.strictEqual(
      asLead.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      500,
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("hides the usage of a member who has explicitly opted out", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 500,
    });

    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: false,
      shareUsage: false,
    });

    const asLead = yield* collaboration.listMembers(lead, scope);
    const hidden = asLead.members.find((entry) => entry.userId === member.userId);
    assert.strictEqual(hidden?.sharesUsage, false);
    assert.strictEqual(hidden?.tokensUsed, null);
    assert.strictEqual(hidden?.promptCount, null);

    // Opting out hides you from the workspace, not from yourself.
    const asSelf = yield* collaboration.listMembers(member, scope);
    assert.strictEqual(
      asSelf.members.find((entry) => entry.userId === member.userId)?.tokensUsed,
      500,
    );

    // And it is reversible.
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

it.effect("keeps sharing an email address something someone has to opt into", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 10,
    });

    // The two defaults deliberately disagree: usage is on, profile is off.
    const asLead = yield* collaboration.listMembers(lead, scope);
    const undecided = asLead.members.find((entry) => entry.userId === member.userId);
    assert.strictEqual(undecided?.sharesUsage, true);
    assert.strictEqual(undecided?.sharesProfile, false);
    assert.strictEqual(undecided?.email, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("tells an undecided member apart from one who chose to share", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const before = yield* collaboration.getConsent(member, scope);
    assert.strictEqual(before.consent, null);
    assert.strictEqual(before.effective.isDecided, false);
    assert.strictEqual(before.effective.shareUsage, true);
    assert.strictEqual(before.effective.shareProfile, false);

    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: true,
      shareUsage: true,
    });

    const after = yield* collaboration.getConsent(member, scope);
    assert.strictEqual(after.consent?.shareUsage, true);
    assert.strictEqual(after.effective.isDecided, true);
    assert.strictEqual(after.effective.shareUsage, true);

    // An opt-out is a decision too, and reads back as one.
    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: true,
      shareUsage: false,
    });
    const opted = yield* collaboration.getConsent(member, scope);
    assert.strictEqual(opted.consent?.shareUsage, false);
    assert.strictEqual(opted.effective.isDecided, true);
    assert.strictEqual(opted.effective.shareUsage, false);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps every author of a path, and the latest is still recoverable", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.touchFiles(member, { ...scope, paths: ["a.txt", "b.txt"] });
    yield* collaboration.touchFiles(lead, { ...scope, paths: ["a.txt"] });

    const touches = yield* collaboration.listFileTouches(scope);
    // This used to keep one entry per path, which read as "the latest author"
    // and quietly threw away the fact that two people had been in a.txt. The
    // latest is still derivable; the second author is not recoverable once
    // dropped, so the list keeps both.
    const forA = touches.touches.filter((touch) => touch.path === "a.txt");
    assert.strictEqual(forA.length, 2);

    const latestForA = forA.toSorted((left, right) =>
      left.touchedAt < right.touchedAt ? 1 : -1,
    )[0];
    assert.strictEqual(latestForA?.userId, lead.userId);

    const forB = touches.touches.filter((touch) => touch.path === "b.txt");
    assert.strictEqual(forB.length, 1);
    assert.strictEqual(forB[0]?.userId, member.userId);
  }).pipe(Effect.provide(makeLayer())),
);

const emptySnapshot = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The stored row shape the delta rules read, with the fields under test. */
function storedUsage(
  fields: Partial<CollaborationMemberUsageRecord>,
): CollaborationMemberUsageRecord {
  return {
    tenantId,
    workspaceId,
    userId: member.userId,
    threadId,
    totalTokens: 0,
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...fields,
  };
}

it("treats a thread's first report as the whole total", () => {
  const observed = deriveUsageObservation(undefined, {
    ...emptySnapshot,
    totalTokens: 1_000,
    inputTokens: 800,
    outputTokens: 200,
  });
  assert.strictEqual(observed.delta?.totalTokens, 1_000);
  assert.strictEqual(observed.delta?.inputTokens, 800);
  assert.strictEqual(observed.highWaterTotal, 1_000);
});

it("emits nothing for a repeated identical report", () => {
  const previous = storedUsage({
    totalTokens: 1_000,
    lastTotalTokens: 1_000,
    lastInputTokens: 800,
    lastOutputTokens: 200,
  });
  const observed = deriveUsageObservation(previous, {
    ...emptySnapshot,
    totalTokens: 1_000,
    inputTokens: 800,
    outputTokens: 200,
  });
  assert.strictEqual(observed.delta, null);
  assert.strictEqual(observed.changed, false);
});

it("records only the difference when a cumulative report grows", () => {
  const previous = storedUsage({
    totalTokens: 1_000,
    lastTotalTokens: 1_000,
    lastInputTokens: 800,
    lastOutputTokens: 200,
  });
  const observed = deriveUsageObservation(previous, {
    ...emptySnapshot,
    totalTokens: 1_500,
    inputTokens: 1_100,
    outputTokens: 400,
  });
  assert.strictEqual(observed.delta?.totalTokens, 500);
  assert.strictEqual(observed.delta?.inputTokens, 300);
  assert.strictEqual(observed.delta?.outputTokens, 200);
  assert.strictEqual(observed.highWaterTotal, 1_500);
});

it("never emits a negative sample when a provider compacts or resets", () => {
  const previous = storedUsage({
    totalTokens: 100_000,
    lastTotalTokens: 100_000,
    lastInputTokens: 90_000,
    lastOutputTokens: 10_000,
  });
  const compacted = deriveUsageObservation(previous, {
    ...emptySnapshot,
    totalTokens: 12_000,
    inputTokens: 10_000,
    outputTokens: 2_000,
  });
  assert.strictEqual(compacted.delta, null);
  // The high-water figure the People panel sums must not go backwards...
  assert.strictEqual(compacted.highWaterTotal, 100_000);
  // ...but the delta baseline follows the provider down, so the tokens spent
  // climbing back are counted rather than silently discarded.
  assert.strictEqual(compacted.baseline.totalTokens, 12_000);

  const afterCompaction = deriveUsageObservation(
    storedUsage({
      totalTokens: 100_000,
      lastTotalTokens: compacted.baseline.totalTokens,
      lastInputTokens: compacted.baseline.inputTokens,
      lastOutputTokens: compacted.baseline.outputTokens,
    }),
    {
      ...emptySnapshot,
      totalTokens: 15_000,
      inputTokens: 12_000,
      outputTokens: 3_000,
    },
  );
  assert.strictEqual(afterCompaction.delta?.totalTokens, 3_000);
});

it("adopts a pre-migration row as a baseline instead of replaying its history", () => {
  // 115 rows in the user's dev database look like this: a real accumulated
  // total with no baseline behind it. Emitting that total as one sample would
  // put months of spend on a single day.
  const previous = storedUsage({
    totalTokens: 2_883_650,
    lastTotalTokens: null,
  });
  const observed = deriveUsageObservation(previous, {
    ...emptySnapshot,
    totalTokens: 2_884_000,
    inputTokens: 2_000_000,
    outputTokens: 800_000,
  });
  assert.strictEqual(observed.delta, null);
  assert.strictEqual(observed.changed, true);
  assert.strictEqual(observed.baseline.totalTokens, 2_884_000);
});

it.effect("builds a usage report with a cost estimate, split by model and hour", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 1_000_000,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
    });
    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId: otherThreadId,
      totalTokens: 500,
      inputTokens: 400,
      outputTokens: 100,
      provider: "codex",
      // Deliberately absent from the rate table.
      model: "gpt-5.3-codex-spark",
    });

    const report = yield* collaboration.queryUsage(member, scope);

    assert.strictEqual(report.totals.totalTokens, 1_000_500);
    assert.strictEqual(report.byHourOfDay.length, 24);
    assert.strictEqual(
      report.byHourOfDay.reduce((sum, bucket) => sum + bucket.totals.totalTokens, 0),
      1_000_500,
    );
    assert.strictEqual(report.leaderboard[0]?.userId, member.userId);
    assert.strictEqual(report.leaderboard[0]?.isViewer, true);

    // 1M input at $3/MTok plus 1M output at $15/MTok. The unpriced model is
    // reported separately rather than quietly costing nothing.
    assert.strictEqual(report.estimatedCost.estimatedInputCost, 3);
    assert.strictEqual(report.estimatedCost.estimatedOutputCost, 15);
    assert.strictEqual(report.estimatedCost.unpricedTokens, 500);
    assert.deepStrictEqual(report.estimatedCost.unpricedModels, ["gpt-5.3-codex-spark"]);

    const providers = report.byProvider.map((entry) => entry.provider).toSorted();
    assert.deepStrictEqual(providers, ["claudeAgent", "codex"]);
    assert.strictEqual(
      report.byModel.find((entry) => entry.model === "gpt-5.3-codex-spark")?.isPriced,
      false,
    );
    assert.strictEqual(
      report.byModel.find((entry) => entry.model === "claude-sonnet-4-6")?.isPriced,
      true,
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaves an opted-out member out of every total the workspace can see", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.recordUsage(member, {
      ...scope,
      threadId,
      totalTokens: 900,
      inputTokens: 900,
      provider: "codex",
      model: "gpt-5.4",
    });
    yield* collaboration.recordUsage(delegate, {
      ...scope,
      threadId: otherThreadId,
      totalTokens: 100,
      inputTokens: 100,
      provider: "codex",
      model: "gpt-5.4",
    });
    yield* collaboration.updateConsent(member, {
      ...scope,
      shareProfile: false,
      shareUsage: false,
    });

    const asLead = yield* collaboration.queryUsage(lead, scope);
    assert.strictEqual(asLead.totals.totalTokens, 100);
    assert.strictEqual(asLead.hiddenMemberCount, 1);
    assert.strictEqual(
      asLead.leaderboard.some((entry) => entry.userId === member.userId),
      false,
    );

    // Nobody is hidden from themselves.
    const asSelf = yield* collaboration.queryUsage(member, scope);
    assert.strictEqual(asSelf.totals.totalTokens, 1_000);
    assert.strictEqual(asSelf.hiddenMemberCount, 0);
  }).pipe(Effect.provide(makeLayer())),
);

/**
 * The other half of a contract. `memberColorForUserId` in the web app's
 * collaborationRoster.logic.ts is a deliberate copy of `defaultMemberColor`,
 * and asserts these same two values — that is how the transcript can colour a
 * message from somebody the roster no longer lists without their colour
 * changing. If this test and its twin ever disagree, the copy has drifted.
 */
it.effect("hands out the member colours the web app derives for itself", () =>
  Effect.sync(() => {
    assert.strictEqual(defaultMemberColor("user-ada"), "hsl(276 70% 55%)");
    assert.strictEqual(
      defaultMemberColor("local:6d0229b2-9974-43a2-878a-4c9a2a1de273"),
      "hsl(251 70% 55%)",
    );
  }),
);

it.effect("tells a person in a file apart from an agent writing it", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "page:1",
    });
    yield* collaboration.markFilePresenceForAgent(lead.userId, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "thread:1",
    });

    const { presence } = yield* collaboration.listFilePresence(scope);
    assert.strictEqual(presence.length, 2);
    assert.deepStrictEqual(presence.map((entry) => entry.kind).toSorted(), ["agent", "person"]);

    const verdict = decideFilePresence({
      path: "src/app.ts",
      entries: presence,
      nowMs: Date.now(),
    });
    assert.strictEqual(verdict.outcome, "agent-over-person");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a person and their own agent as two claims on one file", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    // The same human, both ways round. Collapsing these would erase the
    // commonest way somebody loses unsaved work: their own turn rewriting the
    // buffer they are sitting in.
    yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "page:1",
    });
    yield* collaboration.markFilePresenceForAgent(member.userId, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "thread:1",
    });

    const { presence } = yield* collaboration.listFilePresence(scope);
    assert.strictEqual(presence.length, 2);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("treats a heartbeat as one claim, not a second body", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const first = yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "page:1",
    });
    const again = yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "page:1",
    });

    const { presence } = yield* collaboration.listFilePresence(scope);
    assert.strictEqual(presence.length, 1);
    // The deadline moves; how long they have been in the file does not.
    assert.strictEqual(again.presence[0]?.startedAt, first.presence[0]?.startedAt);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lets a page give up everything it holds without naming the files", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["a.ts", "b.ts"],
      sourceId: "page:1",
    });
    yield* collaboration.markFilePresence(lead, {
      ...scope,
      paths: ["a.ts"],
      sourceId: "page:2",
    });

    yield* collaboration.releaseFilePresence(member, { ...scope, paths: [], sourceId: "page:1" });

    const { presence } = yield* collaboration.listFilePresence(scope);
    // Only that page's claims went. The other person is still in the file.
    assert.strictEqual(presence.length, 1);
    assert.strictEqual(presence[0]?.userId, lead.userId);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("does not hand out a claim from another workspace", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const otherWorkspace = WorkspaceId.make("workspace-collab-other");

    yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "page:1",
    });

    const { presence } = yield* collaboration.listFilePresence({
      tenantId,
      workspaceId: otherWorkspace,
    });
    assert.deepStrictEqual(presence, []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("names the files somebody has open before a turn starts", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    const quiet = yield* collaboration.warnBeforeAgentWrites(lead.userId, scope);
    assert.deepStrictEqual(quiet.heldPaths, []);

    yield* collaboration.markFilePresence(member, {
      ...scope,
      paths: ["src/app.ts", "src/other.ts"],
      sourceId: "page:1",
    });

    const warned = yield* collaboration.warnBeforeAgentWrites(lead.userId, scope);
    assert.deepStrictEqual(warned.heldPaths, ["src/app.ts", "src/other.ts"]);

    // The warning is a fact in the shared history, not a return value nobody
    // sees: every browser watching the workspace learns about it.
    const { activities } = yield* collaboration.listActivity(member, scope);
    const warning = activities.find((activity) => activity.kind === "agent-may-overwrite");
    assert.ok(warning);
    assert.ok(warning.summary.includes("src/app.ts"));
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("does not warn about an agent's own claim, only a person's", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;

    yield* collaboration.markFilePresenceForAgent(lead.userId, {
      ...scope,
      paths: ["src/app.ts"],
      sourceId: "thread:1",
    });

    const result = yield* collaboration.warnBeforeAgentWrites(lead.userId, scope);
    assert.deepStrictEqual(result.heldPaths, []);
  }).pipe(Effect.provide(makeLayer())),
);

// Removal used to mean "your row is gone", and a missing row was read as "not
// governed yet", which handed the removed member write access straight back:
// their next turn found no membership, took the ungoverned branch and ran.
it.effect("refuses a removed member's next turn instead of waving it through", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    // Configuring the workspace is what makes this caller the lead.
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

    yield* collaboration.removeMember(lead, { ...scope, userId: member.userId });

    const after = yield* collaboration.checkWriteAccessForTurn(member, scope);
    assert.strictEqual(after.mayRun, false);

    // And the reads close with the turn. The invite row survives removal, so
    // the workspace's history would otherwise stay just as readable.
    const refused = yield* Effect.flip(collaboration.listActivity(member, scope));
    assert.strictEqual(refused.code, "invalid-membership-rule");

    // The lead is untouched: they hold no membership row either, and the whole
    // point of the old branch was not to strand them.
    const leadStillWrites = yield* collaboration.checkWriteAccessForTurn(lead, scope);
    assert.strictEqual(leadStillWrites.mayRun, true);
  }).pipe(Effect.provide(makeLayer())),
);

// An invite names one workspace. The membership it mints names only a tenant,
// so the workspace it was scoped to used to be forgotten the moment it was
// redeemed — and every read here filters on the workspace the CALLER asked
// for. A contractor invited to one workspace asked for the next one along.
it.effect("keeps an invite scoped to one workspace out of the tenant's others", () =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    const otherScope = { tenantId, workspaceId: WorkspaceId.make("workspace-collab-other") };

    // A second workspace in the same tenant, holding a prompt for review.
    yield* collaboration.updateSettings(lead, { ...otherScope, approvalMode: "blocking" });
    const held = yield* collaboration.submitPromptForApproval(delegate, {
      ...otherScope,
      prompt: "rotate the production signing key",
    });
    assert.strictEqual(held.approval?.status, "pending");

    // The contractor is invited to the FIRST workspace and nothing else.
    yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "open" });
    const invite = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "member@example.com",
      scope: "workspace",
      roles: ["developer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(member, { inviteId: invite.invite.id });

    // Their own workspace still answers.
    const mine = yield* collaboration.listApprovals(member, scope);
    assert.deepEqual(mine.approvals, []);

    // The one they were never invited into does not — not an empty list, a
    // refusal, because the held prompt text is the thing being protected.
    const refusedApprovals = yield* Effect.flip(collaboration.listApprovals(member, otherScope));
    assert.strictEqual(refusedApprovals.code, "invalid-membership-rule");

    const refusedActivity = yield* Effect.flip(collaboration.listActivity(member, otherScope));
    assert.strictEqual(refusedActivity.code, "invalid-membership-rule");

    const refusedMembers = yield* Effect.flip(collaboration.listMembers(member, otherScope));
    assert.strictEqual(refusedMembers.code, "invalid-membership-rule");

    const refusedPrompts = yield* Effect.flip(collaboration.listSharedPrompts(member, otherScope));
    assert.strictEqual(refusedPrompts.code, "invalid-membership-rule");

    // And it is not a turn they may start either.
    const write = yield* collaboration.checkWriteAccessForTurn(member, otherScope);
    assert.strictEqual(write.mayRun, false);

    // A tenant-wide invite still reaches the whole tenant, which is what it is
    // for — this is a narrowing of workspace-scoped invites, not of all of them.
    const tenantWide = yield* collaboration.createInvite(lead, {
      ...scope,
      workspaceId: null,
      email: "delegate@example.com",
      scope: "tenant",
      roles: ["developer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(delegate, { inviteId: tenantWide.invite.id });
    const everywhere = yield* collaboration.listApprovals(delegate, otherScope);
    assert.strictEqual(everywhere.approvals.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);
