import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProviderUsageRequestRepositoryLive } from "./ProviderUsageRequests.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProviderUsageRequestRepository } from "../Services/ProviderUsageRequests.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProviderUsageRequestRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProviderUsageRequestRepository", (it) => {
  it.effect("records a request and reads it back by id and by workspace", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;
      const scope = { tenantId: "tenant-ask", workspaceId: "workspace-ask" };

      const created = yield* repository.createRequest({
        ...scope,
        requestId: "request-ada",
        requesterUserId: "ask-ada",
        provider: "claude",
        reason: "no-account",
        note: "Starting on the billing migration today.",
        createdAt: "2026-08-01T09:00:00.000Z",
      });

      assert.equal(created.requestId, "request-ada");
      assert.equal(created.status, "pending");
      assert.equal(created.reason, "no-account");
      assert.equal(created.respondedAt, null);
      assert.equal(created.respondedByUserId, null);
      assert.equal(created.respondedAccountId, null);

      const fetched = yield* repository.getRequest({ requestId: "request-ada" });
      assert.equal(Option.isSome(fetched), true);
      assert.equal(
        Option.getOrUndefined(fetched)?.note,
        "Starting on the billing migration today.",
      );

      const missing = yield* repository.getRequest({ requestId: "request-nobody" });
      assert.equal(Option.isNone(missing), true);

      const all = yield* repository.listRequestsForWorkspace(scope);
      assert.deepStrictEqual(
        all.map((request) => request.requestId),
        ["request-ada"],
      );
    }),
  );

  it.effect("keeps a note absent rather than blank when none was written", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;

      const created = yield* repository.createRequest({
        tenantId: "tenant-note",
        workspaceId: "workspace-note",
        requestId: "request-silent",
        requesterUserId: "note-grace",
        provider: "codex",
        reason: "limit-reached",
        note: null,
        createdAt: "2026-08-01T10:00:00.000Z",
      });

      assert.strictEqual(created.note, null);
    }),
  );

  it.effect("folds a second ask into the request already pending", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;
      const scope = { tenantId: "tenant-dup", workspaceId: "workspace-dup" };

      yield* repository.createRequest({
        ...scope,
        requestId: "request-first",
        requesterUserId: "dup-ada",
        provider: "claude",
        reason: "limit-reached",
        note: "Nearly out.",
        createdAt: "2026-08-02T09:00:00.000Z",
      });

      // The same person, provider and workspace again, with a fresh id: the
      // existing row must win, carrying its own id and its original wait.
      const second = yield* repository.createRequest({
        ...scope,
        requestId: "request-second",
        requesterUserId: "dup-ada",
        provider: "claude",
        reason: "no-account",
        note: "Actually out now.",
        createdAt: "2026-08-03T09:00:00.000Z",
      });

      assert.equal(second.requestId, "request-first");
      assert.equal(second.createdAt, "2026-08-02T09:00:00.000Z");
      assert.equal(second.reason, "no-account");
      assert.equal(second.note, "Actually out now.");

      const pending = yield* repository.listRequestsForWorkspace({ ...scope, status: "pending" });
      assert.equal(pending.length, 1);

      // A different provider is a different ask, and so is a different person.
      yield* repository.createRequest({
        ...scope,
        requestId: "request-codex",
        requesterUserId: "dup-ada",
        provider: "codex",
        reason: "asked",
        note: null,
        createdAt: "2026-08-03T10:00:00.000Z",
      });
      yield* repository.createRequest({
        ...scope,
        requestId: "request-grace",
        requesterUserId: "dup-grace",
        provider: "claude",
        reason: "no-account",
        note: null,
        createdAt: "2026-08-03T11:00:00.000Z",
      });

      const stillPending = yield* repository.listRequestsForWorkspace({
        ...scope,
        status: "pending",
      });
      assert.deepStrictEqual(
        stillPending.map((request) => request.requestId),
        ["request-first", "request-codex", "request-grace"],
      );
    }),
  );

  it.effect("lets the same person ask again once the first was answered", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;
      const scope = { tenantId: "tenant-again", workspaceId: "workspace-again" };

      yield* repository.createRequest({
        ...scope,
        requestId: "again-first",
        requesterUserId: "again-ada",
        provider: "claude",
        reason: "no-account",
        note: null,
        createdAt: "2026-08-04T09:00:00.000Z",
      });
      yield* repository.updateRequestStatus({
        requestId: "again-first",
        status: "declined",
        respondedAt: "2026-08-04T10:00:00.000Z",
        respondedByUserId: "again-admin",
        respondedAccountId: null,
      });

      const second = yield* repository.createRequest({
        ...scope,
        requestId: "again-second",
        requesterUserId: "again-ada",
        provider: "claude",
        reason: "asked",
        note: null,
        createdAt: "2026-08-05T09:00:00.000Z",
      });

      // A new row, because the declined one is history and must survive.
      assert.equal(second.requestId, "again-second");
      const both = yield* repository.listRequestsForWorkspace(scope);
      assert.deepStrictEqual(
        both.map((request) => [request.requestId, request.status]),
        [
          ["again-first", "declined"],
          ["again-second", "pending"],
        ],
      );
    }),
  );

  it.effect("answers a pending request once and refuses the second answer", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;
      const scope = { tenantId: "tenant-answer", workspaceId: "workspace-answer" };

      yield* repository.createRequest({
        ...scope,
        requestId: "answer-request",
        requesterUserId: "answer-ada",
        provider: "claude",
        reason: "limit-reached",
        note: null,
        createdAt: "2026-08-06T09:00:00.000Z",
      });

      const granted = yield* repository.updateRequestStatus({
        requestId: "answer-request",
        status: "granted",
        respondedAt: "2026-08-06T09:30:00.000Z",
        respondedByUserId: "answer-grace",
        respondedAccountId: "answer-grace-claude",
      });
      assert.equal(Option.isSome(granted), true);
      assert.equal(Option.getOrUndefined(granted)?.status, "granted");
      assert.equal(Option.getOrUndefined(granted)?.respondedAccountId, "answer-grace-claude");

      // Second admin, same request: the first answer stands.
      const raced = yield* repository.updateRequestStatus({
        requestId: "answer-request",
        status: "declined",
        respondedAt: "2026-08-06T09:31:00.000Z",
        respondedByUserId: "answer-alan",
        respondedAccountId: null,
      });
      assert.equal(Option.isNone(raced), true);

      const settled = yield* repository.getRequest({ requestId: "answer-request" });
      assert.equal(Option.getOrUndefined(settled)?.status, "granted");
      assert.equal(Option.getOrUndefined(settled)?.respondedByUserId, "answer-grace");

      const gone = yield* repository.updateRequestStatus({
        requestId: "answer-missing",
        status: "withdrawn",
        respondedAt: "2026-08-06T09:32:00.000Z",
        respondedByUserId: null,
        respondedAccountId: null,
      });
      assert.equal(Option.isNone(gone), true);
    }),
  );

  it.effect("separates one workspace's queue from another and one asker's own list", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderUsageRequestRepository;
      const scope = { tenantId: "tenant-scope", workspaceId: "workspace-scope" };

      yield* repository.createRequest({
        ...scope,
        requestId: "scope-ada-claude",
        requesterUserId: "scope-ada",
        provider: "claude",
        reason: "no-account",
        note: null,
        createdAt: "2026-08-07T09:00:00.000Z",
      });
      yield* repository.createRequest({
        ...scope,
        requestId: "scope-ada-codex",
        requesterUserId: "scope-ada",
        provider: "codex",
        reason: "asked",
        note: null,
        createdAt: "2026-08-07T10:00:00.000Z",
      });
      yield* repository.createRequest({
        ...scope,
        requestId: "scope-grace-claude",
        requesterUserId: "scope-grace",
        provider: "claude",
        reason: "limit-reached",
        note: null,
        createdAt: "2026-08-07T11:00:00.000Z",
      });
      // Same tenant, different workspace: must not appear in either read above.
      yield* repository.createRequest({
        tenantId: "tenant-scope",
        workspaceId: "workspace-elsewhere",
        requestId: "scope-elsewhere",
        requesterUserId: "scope-ada",
        provider: "claude",
        reason: "no-account",
        note: null,
        createdAt: "2026-08-07T12:00:00.000Z",
      });

      yield* repository.updateRequestStatus({
        requestId: "scope-ada-codex",
        status: "withdrawn",
        respondedAt: "2026-08-07T10:30:00.000Z",
        respondedByUserId: "scope-ada",
        respondedAccountId: null,
      });

      const queue = yield* repository.listRequestsForWorkspace({ ...scope, status: "pending" });
      assert.deepStrictEqual(
        queue.map((request) => request.requestId),
        ["scope-ada-claude", "scope-grace-claude"],
      );

      // The asker's own view is newest first, and shows the withdrawn one too.
      const mine = yield* repository.listRequestsForUser({
        ...scope,
        requesterUserId: "scope-ada",
      });
      assert.deepStrictEqual(
        mine.map((request) => request.requestId),
        ["scope-ada-codex", "scope-ada-claude"],
      );
    }),
  );
});
