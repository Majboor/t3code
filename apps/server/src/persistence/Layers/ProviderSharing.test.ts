import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProviderSharingRepositoryLive } from "./ProviderSharing.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderSharingRepository } from "../Services/ProviderSharing.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProviderSharingRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProviderSharingRepository", (it) => {
  it.effect("indexes accounts per user and updates in place on re-index", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;

      yield* repository.upsertAccount({
        userId: "user-ada",
        provider: "claude",
        accountId: "account-work",
        label: "Work",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: null,
      });
      yield* repository.upsertAccount({
        userId: "user-ada",
        provider: "codex",
        accountId: "default",
        label: null,
        createdAt: "2026-06-01T00:00:01.000Z",
        lastUsedAt: null,
      });

      const initial = yield* repository.listAccountsForUser({ userId: "user-ada" });
      assert.equal(initial.length, 2);
      assert.equal(initial.find((account) => account.provider === "claude")?.label, "Work");
      assert.equal(initial.find((account) => account.provider === "codex")?.label, null);

      // The same key again: a relabel, not a second account, and `createdAt`
      // must survive because the roster sorts on it.
      yield* repository.upsertAccount({
        userId: "user-ada",
        provider: "claude",
        accountId: "account-work",
        label: "Work (renamed)",
        createdAt: "2026-06-09T00:00:00.000Z",
        lastUsedAt: null,
      });

      const relabelled = yield* repository.listAccountsForUser({ userId: "user-ada" });
      assert.equal(relabelled.length, 2);
      const claude = relabelled.find((account) => account.provider === "claude");
      assert.equal(claude?.label, "Work (renamed)");
      assert.equal(claude?.createdAt, "2026-06-01T00:00:00.000Z");
    }),
  );

  it.effect("records last use and forgets a disconnected account", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;

      yield* repository.upsertAccount({
        userId: "user-touch",
        provider: "codex",
        accountId: "account-touch",
        label: "Personal",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: null,
      });
      yield* repository.touchAccountUsed({
        userId: "user-touch",
        provider: "codex",
        accountId: "account-touch",
        lastUsedAt: "2026-06-02T09:30:00.000Z",
      });

      const touched = yield* repository.listAccountsForUser({ userId: "user-touch" });
      assert.equal(touched[0]?.lastUsedAt, "2026-06-02T09:30:00.000Z");

      // A re-index carrying no last-use figure must not erase the one on disk.
      yield* repository.upsertAccount({
        userId: "user-touch",
        provider: "codex",
        accountId: "account-touch",
        label: "Personal",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: null,
      });
      const reindexed = yield* repository.listAccountsForUser({ userId: "user-touch" });
      assert.equal(reindexed[0]?.lastUsedAt, "2026-06-02T09:30:00.000Z");

      yield* repository.removeAccount({
        userId: "user-touch",
        provider: "codex",
        accountId: "account-touch",
      });
      const removed = yield* repository.listAccountsForUser({ userId: "user-touch" });
      assert.equal(removed.length, 0);
    }),
  );

  it.effect("gathers the roster across a set of members and no one else", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;
      const members = ["roster-ada", "roster-grace", "roster-alan"];

      for (const [offset, userId] of members.entries()) {
        yield* repository.upsertAccount({
          userId,
          provider: "claude",
          accountId: `${userId}-claude`,
          label: userId,
          createdAt: `2026-06-0${offset + 1}T00:00:00.000Z`,
          lastUsedAt: null,
        });
      }
      yield* repository.upsertAccount({
        userId: "roster-grace",
        provider: "codex",
        accountId: "roster-grace-codex",
        label: "Grace codex",
        createdAt: "2026-06-04T00:00:00.000Z",
        lastUsedAt: null,
      });
      // Belongs to a different workspace's member: must not leak into the roster.
      yield* repository.upsertAccount({
        userId: "roster-outsider",
        provider: "claude",
        accountId: "roster-outsider-claude",
        label: "Outsider",
        createdAt: "2026-06-05T00:00:00.000Z",
        lastUsedAt: null,
      });

      const roster = yield* repository.listAccountsForUsers({
        userIds: ["roster-ada", "roster-grace"],
      });
      assert.deepStrictEqual(
        roster.map((account) => account.accountId),
        ["roster-ada-claude", "roster-grace-claude", "roster-grace-codex"],
      );

      const empty = yield* repository.listAccountsForUsers({ userIds: [] });
      assert.equal(empty.length, 0);
    }),
  );

  it.effect("round-trips a share's enabled flag as a boolean through both states", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;
      const scope = { tenantId: "tenant-share", workspaceId: "workspace-share" };

      yield* repository.upsertShare({
        ...scope,
        ownerUserId: "share-ada",
        provider: "claude",
        accountId: "share-ada-claude",
        enabled: true,
        updatedAt: "2026-06-10T00:00:00.000Z",
      });
      yield* repository.upsertShare({
        ...scope,
        ownerUserId: "share-grace",
        provider: "claude",
        accountId: "share-grace-claude",
        enabled: false,
        updatedAt: "2026-06-10T00:00:01.000Z",
      });

      const shares = yield* repository.listSharesForWorkspace(scope);
      assert.equal(shares.length, 2);
      const ada = shares.find((share) => share.ownerUserId === "share-ada");
      const grace = shares.find((share) => share.ownerUserId === "share-grace");
      assert.strictEqual(ada?.enabled, true);
      assert.strictEqual(grace?.enabled, false);

      // Toggling off keeps one row and swaps the account, so re-enabling later
      // restores a choice rather than asking for it again.
      yield* repository.upsertShare({
        ...scope,
        ownerUserId: "share-ada",
        provider: "claude",
        accountId: "share-ada-claude-second",
        enabled: false,
        updatedAt: "2026-06-11T00:00:00.000Z",
      });

      const mine = yield* repository.listSharesForUser({ ...scope, ownerUserId: "share-ada" });
      assert.equal(mine.length, 1);
      assert.strictEqual(mine[0]?.enabled, false);
      assert.equal(mine[0]?.accountId, "share-ada-claude-second");
      assert.equal(mine[0]?.updatedAt, "2026-06-11T00:00:00.000Z");
    }),
  );

  it.effect("stores one policy per provider and rewrites it on change", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;
      const scope = { tenantId: "tenant-policy", workspaceId: "workspace-policy" };

      yield* repository.upsertPolicy({
        ...scope,
        provider: "claude",
        mode: "own",
        sharedOwnerUserId: null,
        sharedAccountId: null,
        updatedAt: "2026-06-12T00:00:00.000Z",
      });
      yield* repository.upsertPolicy({
        ...scope,
        provider: "codex",
        mode: "shared",
        sharedOwnerUserId: "policy-grace",
        sharedAccountId: "policy-grace-codex",
        updatedAt: "2026-06-12T00:00:01.000Z",
      });

      const initial = yield* repository.listPoliciesForWorkspace(scope);
      assert.deepStrictEqual(
        initial.map((policy) => [policy.provider, policy.mode]),
        [
          ["claude", "own"],
          ["codex", "shared"],
        ],
      );
      assert.equal(initial[0]?.sharedOwnerUserId, null);
      assert.equal(initial[1]?.sharedAccountId, "policy-grace-codex");

      yield* repository.upsertPolicy({
        ...scope,
        provider: "codex",
        mode: "own",
        sharedOwnerUserId: null,
        sharedAccountId: null,
        updatedAt: "2026-06-13T00:00:00.000Z",
      });

      const reverted = yield* repository.listPoliciesForWorkspace(scope);
      assert.equal(reverted.length, 2);
      const codex = reverted.find((policy) => policy.provider === "codex");
      assert.equal(codex?.mode, "own");
      assert.equal(codex?.sharedOwnerUserId, null);
      assert.equal(codex?.sharedAccountId, null);
    }),
  );

  it.effect("keeps grants per member and reports absence as none", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSharingRepository;
      const scope = { tenantId: "tenant-grant", workspaceId: "workspace-grant" };

      yield* repository.upsertGrant({
        ...scope,
        userId: "grant-ada",
        provider: "claude",
        access: "workspace",
        updatedAt: "2026-06-14T00:00:00.000Z",
      });
      yield* repository.upsertGrant({
        ...scope,
        userId: "grant-grace",
        provider: "claude",
        access: "own",
        updatedAt: "2026-06-14T00:00:01.000Z",
      });

      const grants = yield* repository.listGrantsForWorkspace(scope);
      assert.deepStrictEqual(
        grants.map((grant) => [grant.userId, grant.access]),
        [
          ["grant-ada", "workspace"],
          ["grant-grace", "own"],
        ],
      );

      yield* repository.upsertGrant({
        ...scope,
        userId: "grant-ada",
        provider: "claude",
        access: "own",
        updatedAt: "2026-06-15T00:00:00.000Z",
      });

      const afterRevoke = yield* repository.listGrantsForWorkspace(scope);
      assert.equal(afterRevoke.length, 2);

      const ada = yield* repository.getGrant({
        ...scope,
        userId: "grant-ada",
        provider: "claude",
      });
      assert.equal(Option.isSome(ada), true);
      assert.equal(Option.getOrUndefined(ada)?.access, "own");
      assert.equal(Option.getOrUndefined(ada)?.updatedAt, "2026-06-15T00:00:00.000Z");

      // No row is not the same as `own`: it means "follow the policy".
      const unset = yield* repository.getGrant({
        ...scope,
        userId: "grant-ada",
        provider: "codex",
      });
      assert.equal(Option.isNone(unset), true);
    }),
  );
});
