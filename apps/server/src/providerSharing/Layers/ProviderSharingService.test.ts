import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderAccountId, TenantId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProviderSharingServiceLive } from "./ProviderSharingService.ts";
import { ProviderSharingService } from "../Services/ProviderSharingService.ts";
import { CollaborationServiceLive } from "../../collaboration/Layers/CollaborationService.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderSharingRepositoryLive } from "../../persistence/Layers/ProviderSharing.ts";
import { ProviderSharingRepository } from "../../persistence/Services/ProviderSharing.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { createProviderAccount, writeClaudeToken } from "../../providerAuth/store.ts";

const tenantId = TenantId.make("tenant-sharing");
const workspaceId = WorkspaceId.make("workspace-sharing");
const scope = { tenantId, workspaceId };

const lead = { userId: UserId.make("user-lead"), displayName: "Lead" };
const member = { userId: UserId.make("user-member"), displayName: "Member" };
const stranger = { userId: UserId.make("user-stranger"), displayName: "Stranger" };

/**
 * A fresh database and a fresh credential directory per test. The workspace is
 * never written, so nobody is lead until somebody configures it — which is how
 * these tests earn an admin, and why a plain member's view is the default one.
 */
function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-sharing-"));
  return ProviderSharingServiceLive.pipe(
    Layer.provideMerge(CollaborationServiceLive),
    Layer.provideMerge(ProviderSharingRepositoryLive),
    Layer.provideMerge(TenancyRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(tempDir, tempDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** An account with a credential actually on disk, as the connect flow leaves it. */
const connectClaude = (stateDir: string, userId: string, label: string) =>
  Effect.promise(async () => {
    const accountId = await createProviderAccount(stateDir, userId, "claude", label);
    await writeClaudeToken(stateDir, userId, `sk-ant-${accountId}`, accountId);
    return ProviderAccountId.make(accountId);
  });

/** Someone the workspace can see: presence is enough to appear on the roster. */
const beVisible = (actor: { userId: UserId; displayName: string }) =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.upsertPresence(actor, { ...scope, threadId: null, status: "active" });
  });

/** The first caller to configure the workspace becomes its lead. */
const beLead = Effect.gen(function* () {
  const collaboration = yield* CollaborationService;
  yield* collaboration.updateSettings(lead, { ...scope, approvalMode: "open" });
});

it.effect("offers only the accounts that are genuinely connected", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sharing = yield* ProviderSharingService;

    const connected = yield* connectClaude(config.stateDir, member.userId, "Personal");
    yield* Effect.promise(() =>
      createProviderAccount(config.stateDir, member.userId, "claude", "Never finished"),
    );

    const overview = yield* sharing.getOverview(member, scope);

    assert.deepStrictEqual(
      overview.viewerAccounts.map((account) => account.accountId),
      [connected],
    );
    assert.strictEqual(overview.viewerAccounts[0]?.label, "Personal");
    // A member sees the same shape an admin does, with the admin halves empty.
    assert.strictEqual(overview.canManage, false);
    assert.deepStrictEqual(overview.grants, []);
    assert.deepStrictEqual(overview.workspaceAccounts, []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("only lets somebody contribute an account they hold", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sharing = yield* ProviderSharingService;
    const accountId = yield* connectClaude(config.stateDir, member.userId, "Personal");

    const refused = yield* sharing
      .updateShare(member, {
        ...scope,
        provider: "claude",
        accountId: ProviderAccountId.make("somebody-elses"),
        enabled: true,
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "account-not-found");

    const shared = yield* sharing.updateShare(member, {
      ...scope,
      provider: "claude",
      accountId,
      enabled: true,
    });
    assert.strictEqual(shared.share.ownerUserId, member.userId);
    assert.strictEqual(shared.share.enabled, true);

    const overview = yield* sharing.getOverview(member, scope);
    assert.strictEqual(overview.viewerShares.length, 1);
    assert.strictEqual(overview.viewerShares[0]?.accountId, accountId);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses a policy pointing at an account nobody contributed", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sharing = yield* ProviderSharingService;
    const accountId = yield* connectClaude(config.stateDir, member.userId, "Personal");
    yield* beLead;

    const forbidden = yield* sharing
      .updatePolicy(member, {
        ...scope,
        provider: "claude",
        mode: "shared",
        sharedOwnerUserId: member.userId,
        sharedAccountId: accountId,
      })
      .pipe(Effect.flip);
    assert.strictEqual(forbidden.code, "forbidden");

    const unshared = yield* sharing
      .updatePolicy(lead, {
        ...scope,
        provider: "claude",
        mode: "shared",
        sharedOwnerUserId: member.userId,
        sharedAccountId: accountId,
      })
      .pipe(Effect.flip);
    assert.strictEqual(unshared.code, "account-not-shared");

    yield* sharing.updateShare(member, { ...scope, provider: "claude", accountId, enabled: true });
    const stored = yield* sharing.updatePolicy(lead, {
      ...scope,
      provider: "claude",
      mode: "shared",
      sharedOwnerUserId: member.userId,
      sharedAccountId: accountId,
    });
    assert.strictEqual(stored.policy.mode, "shared");
    assert.strictEqual(stored.policy.sharedAccountId, accountId);

    // The owner's off switch does not rewrite the policy, but nothing may pin
    // that account again while it is off.
    yield* sharing.updateShare(member, { ...scope, provider: "claude", accountId, enabled: false });
    const withdrawn = yield* sharing
      .updatePolicy(lead, { ...scope, provider: "claude", mode: "shared" })
      .pipe(Effect.flip);
    assert.strictEqual(withdrawn.code, "account-not-shared");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("clears the pinned account when the workspace goes back to own", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sharing = yield* ProviderSharingService;
    const accountId = yield* connectClaude(config.stateDir, member.userId, "Personal");
    yield* beLead;
    yield* sharing.updateShare(member, { ...scope, provider: "claude", accountId, enabled: true });
    yield* sharing.updatePolicy(lead, {
      ...scope,
      provider: "claude",
      mode: "shared",
      sharedOwnerUserId: member.userId,
      sharedAccountId: accountId,
    });

    const contradictory = yield* sharing
      .updatePolicy(lead, {
        ...scope,
        provider: "claude",
        mode: "own",
        sharedAccountId: accountId,
      })
      .pipe(Effect.flip);
    assert.strictEqual(contradictory.code, "invalid-policy");

    const reverted = yield* sharing.updatePolicy(lead, {
      ...scope,
      provider: "claude",
      mode: "own",
    });
    assert.strictEqual(reverted.policy.sharedOwnerUserId, null);
    assert.strictEqual(reverted.policy.sharedAccountId, null);

    const overview = yield* sharing.getOverview(lead, scope);
    assert.strictEqual(overview.policies.length, 1);
    assert.strictEqual(overview.policies[0]?.mode, "own");
    assert.strictEqual(overview.policies[0]?.sharedAccountId, null);

    // Nothing left to run on, so `shared` with no pointers cannot be stored.
    const empty = yield* sharing
      .updatePolicy(lead, { ...scope, provider: "claude", mode: "shared" })
      .pipe(Effect.flip);
    assert.strictEqual(empty.code, "invalid-policy");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("grants per-member access only for a member, and only from an admin", () =>
  Effect.gen(function* () {
    const sharing = yield* ProviderSharingService;
    yield* beVisible(member);
    yield* beLead;

    const forbidden = yield* sharing
      .updateMemberAccess(member, {
        ...scope,
        userId: member.userId,
        provider: "claude",
        access: "workspace",
      })
      .pipe(Effect.flip);
    assert.strictEqual(forbidden.code, "forbidden");

    const missing = yield* sharing
      .updateMemberAccess(lead, {
        ...scope,
        userId: stranger.userId,
        provider: "claude",
        access: "workspace",
      })
      .pipe(Effect.flip);
    assert.strictEqual(missing.code, "member-not-found");

    const granted = yield* sharing.updateMemberAccess(lead, {
      ...scope,
      userId: member.userId,
      provider: "claude",
      access: "workspace",
    });
    assert.strictEqual(granted.grant.access, "workspace");

    const asMember = yield* sharing.getOverview(member, scope);
    assert.strictEqual(asMember.viewerGrants.length, 1);
    assert.deepStrictEqual(asMember.grants, []);

    const asLead = yield* sharing.getOverview(lead, scope);
    assert.strictEqual(asLead.canManage, true);
    assert.strictEqual(asLead.grants.length, 1);
    // The lead's own grants are unaffected by somebody else's.
    assert.deepStrictEqual(asLead.viewerGrants, []);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("shows an admin every member's account, with who is lending what", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sharing = yield* ProviderSharingService;
    const repository = yield* ProviderSharingRepository;

    const accountId = yield* connectClaude(config.stateDir, member.userId, "Personal");
    // The roster reads the index, which the connect flow writes; the store is
    // this user's disk and cannot be enumerated for anybody else.
    yield* repository.upsertAccount({
      userId: member.userId,
      provider: "claude",
      accountId,
      label: "Personal",
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: null,
    });
    yield* beVisible(member);
    yield* beLead;
    yield* sharing.updateShare(member, { ...scope, provider: "claude", accountId, enabled: true });
    yield* sharing.updatePolicy(lead, {
      ...scope,
      provider: "claude",
      mode: "shared",
      sharedOwnerUserId: member.userId,
      sharedAccountId: accountId,
    });

    const asLead = yield* sharing.getOverview(lead, scope);
    assert.strictEqual(asLead.workspaceAccounts.length, 1);
    const row = asLead.workspaceAccounts[0];
    assert.strictEqual(row?.userId, member.userId);
    assert.strictEqual(row?.displayName, "Member");
    assert.strictEqual(row?.label, "Personal");
    assert.strictEqual(row?.isShared, true);
    assert.strictEqual(row?.isWorkspaceDefault, true);

    // Same workspace, no management right, no view of other people's accounts.
    const asMember = yield* sharing.getOverview(member, scope);
    assert.deepStrictEqual(asMember.workspaceAccounts, []);
  }).pipe(Effect.provide(makeLayer())),
);
