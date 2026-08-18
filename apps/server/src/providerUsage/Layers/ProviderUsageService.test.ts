import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderAccountId, TenantId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProviderUsageServiceLive } from "./ProviderUsageService.ts";
import { ProviderUsageService } from "../Services/ProviderUsageService.ts";
import { CollaborationServiceLive } from "../../collaboration/Layers/CollaborationService.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderSharingRepositoryLive } from "../../persistence/Layers/ProviderSharing.ts";
import { ProviderSharingRepository } from "../../persistence/Services/ProviderSharing.ts";
import { ProviderUsageRequestRepositoryLive } from "../../persistence/Layers/ProviderUsageRequests.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";
import { createProviderAccount, writeClaudeToken } from "../../providerAuth/store.ts";

const tenantId = TenantId.make("tenant-usage");
const workspaceId = WorkspaceId.make("workspace-usage");
const scope = { tenantId, workspaceId };

const asker = { userId: UserId.make("user-asker"), displayName: "Asker" };
const holder = { userId: UserId.make("user-holder"), displayName: "Holder" };
const bystander = { userId: UserId.make("user-bystander"), displayName: "Bystander" };
const stranger = { userId: UserId.make("user-stranger"), displayName: "Stranger" };

/** A fresh database and credential directory per test, as sharing's suite does. */
function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-usage-"));
  return ProviderUsageServiceLive.pipe(
    Layer.provideMerge(CollaborationServiceLive),
    Layer.provideMerge(ProviderSharingRepositoryLive),
    Layer.provideMerge(ProviderUsageRequestRepositoryLive),
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

/** Someone the workspace can see: presence is enough to be on the roster. */
const beVisible = (actor: { userId: UserId; displayName: string }) =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.upsertPresence(actor, { ...scope, threadId: null, status: "active" });
  });

it.effect("only lets a member of the workspace ask, and names them from the roster", () =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);

    const forbidden = yield* usage
      .createRequest(stranger, { ...scope, provider: "claude", reason: "no-account" })
      .pipe(Effect.flip);
    assert.strictEqual(forbidden.code, "forbidden");

    const created = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "no-account",
      note: "just for the migration",
    });
    assert.strictEqual(created.request.requesterUserId, asker.userId);
    assert.strictEqual(created.request.requesterDisplayName, "Asker");
    assert.strictEqual(created.request.status, "pending");
    assert.strictEqual(created.request.note, "just for the migration");
    assert.strictEqual(created.request.respondedByUserId, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("re-asking restates the open request instead of queueing a second", () =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);

    const first = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "no-account",
      note: "first",
    });
    const second = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "limit-reached",
      note: null,
    });

    // The id and the wait are the original ones; what they said is the new one.
    assert.strictEqual(second.request.id, first.request.id);
    assert.strictEqual(second.request.createdAt, first.request.createdAt);
    assert.strictEqual(second.request.reason, "limit-reached");
    assert.strictEqual(second.request.note, null);

    const mine = yield* usage.listRequests(asker, scope);
    assert.strictEqual(mine.requests.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("shows the queue only to someone who could answer it", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);
    yield* beVisible(holder);
    yield* connectClaude(config.stateDir, holder.userId, "Personal");
    // A Codex account is no help to a Claude request, so it must not turn the
    // queue on for this person.
    yield* Effect.promise(() => createProviderAccount(config.stateDir, bystander.userId, "codex"));

    yield* usage.createRequest(asker, { ...scope, provider: "claude", reason: "no-account" });

    const asHolder = yield* usage.listRequests(holder, scope);
    assert.strictEqual(asHolder.canRespond, true);
    assert.strictEqual(asHolder.requests.length, 1);
    assert.strictEqual(asHolder.requests[0]?.requesterDisplayName, "Asker");

    const asBystander = yield* usage.listRequests(bystander, scope);
    assert.strictEqual(asBystander.canRespond, false);
    assert.deepStrictEqual(asBystander.requests, []);

    // The asker sees their own without being able to answer it.
    const asAsker = yield* usage.listRequests(asker, scope);
    assert.strictEqual(asAsker.canRespond, false);
    assert.strictEqual(asAsker.requests.length, 1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("granting lends the account and gives the requester workspace access", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const usage = yield* ProviderUsageService;
    const sharing = yield* ProviderSharingRepository;
    yield* beVisible(asker);
    yield* beVisible(holder);
    const accountId = yield* connectClaude(config.stateDir, holder.userId, "Personal");

    const asked = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "no-account",
    });

    const nobodysAccount = yield* usage
      .respondToRequest(holder, {
        ...scope,
        requestId: asked.request.id,
        decision: "grant",
        accountId: ProviderAccountId.make("somebody-elses"),
      })
      .pipe(Effect.flip);
    assert.strictEqual(nobodysAccount.code, "account-not-found");

    // A grant naming nothing is the same dead end as a grant naming an account
    // the responder does not hold.
    const unnamed = yield* usage
      .respondToRequest(holder, { ...scope, requestId: asked.request.id, decision: "grant" })
      .pipe(Effect.flip);
    assert.strictEqual(unnamed.code, "account-not-found");

    const granted = yield* usage.respondToRequest(holder, {
      ...scope,
      requestId: asked.request.id,
      decision: "grant",
      accountId,
    });
    assert.strictEqual(granted.request.status, "granted");
    assert.strictEqual(granted.request.respondedByUserId, holder.userId);
    assert.strictEqual(granted.request.requesterDisplayName, "Asker");

    // The two writes that make the grant mean something.
    const shares = yield* sharing.listSharesForWorkspace(scope);
    assert.strictEqual(shares.length, 1);
    assert.strictEqual(shares[0]?.ownerUserId, holder.userId);
    assert.strictEqual(shares[0]?.accountId, accountId);
    assert.strictEqual(shares[0]?.enabled, true);

    const grants = yield* sharing.listGrantsForWorkspace(scope);
    assert.strictEqual(grants.length, 1);
    assert.strictEqual(grants[0]?.userId, asker.userId);
    assert.strictEqual(grants[0]?.access, "workspace");

    // First answer wins; the second is told so rather than overwriting it.
    const late = yield* usage
      .respondToRequest(holder, {
        ...scope,
        requestId: asked.request.id,
        decision: "decline",
      })
      .pipe(Effect.flip);
    assert.strictEqual(late.code, "request-already-decided");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses an answer from somebody with nothing to lend, and from the asker", () =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);
    yield* beVisible(bystander);

    const asked = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "asked",
    });

    const empty = yield* usage
      .respondToRequest(bystander, { ...scope, requestId: asked.request.id, decision: "decline" })
      .pipe(Effect.flip);
    assert.strictEqual(empty.code, "not-a-contributor");

    const own = yield* usage
      .respondToRequest(asker, { ...scope, requestId: asked.request.id, decision: "grant" })
      .pipe(Effect.flip);
    assert.strictEqual(own.code, "forbidden");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("only the requester withdraws, and a withdrawn request cannot be answered", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);
    yield* beVisible(holder);
    const accountId = yield* connectClaude(config.stateDir, holder.userId, "Personal");

    const asked = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "limit-reached",
    });

    const notYours = yield* usage
      .withdrawRequest(holder, { ...scope, requestId: asked.request.id })
      .pipe(Effect.flip);
    assert.strictEqual(notYours.code, "forbidden");

    const withdrawn = yield* usage.withdrawRequest(asker, {
      ...scope,
      requestId: asked.request.id,
    });
    assert.strictEqual(withdrawn.request.status, "withdrawn");
    // Nobody answered, so nobody is named.
    assert.strictEqual(withdrawn.request.respondedByUserId, null);

    const late = yield* usage
      .respondToRequest(holder, {
        ...scope,
        requestId: asked.request.id,
        decision: "grant",
        accountId,
      })
      .pipe(Effect.flip);
    assert.strictEqual(late.code, "request-already-decided");

    // The queue is empty again, and asking once more is allowed.
    const asHolder = yield* usage.listRequests(holder, scope);
    assert.strictEqual(asHolder.canRespond, false);

    const again = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "no-account",
    });
    assert.notStrictEqual(again.request.id, asked.request.id);
    assert.strictEqual(again.request.status, "pending");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a request from another workspace is not visible by its id", () =>
  Effect.gen(function* () {
    const usage = yield* ProviderUsageService;
    yield* beVisible(asker);

    const asked = yield* usage.createRequest(asker, {
      ...scope,
      provider: "claude",
      reason: "no-account",
    });

    const elsewhere = yield* usage
      .withdrawRequest(asker, {
        tenantId,
        workspaceId: WorkspaceId.make("workspace-other"),
        requestId: asked.request.id,
      })
      .pipe(Effect.flip);
    assert.strictEqual(elsewhere.code, "request-not-found");
  }).pipe(Effect.provide(makeLayer())),
);
