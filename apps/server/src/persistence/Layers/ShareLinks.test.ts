import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ShareLinkRepositoryLive } from "./ShareLinks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { generateShareLinkToken, ShareLinkRepository } from "../Services/ShareLinks.ts";

const layer = it.layer(
  Layer.mergeAll(
    ShareLinkRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const workspaceScope = { tenantId: "tenant-acme", workspaceId: "workspace-platform" };

const fileLink = {
  ...workspaceScope,
  linkId: "link-file",
  token: "token-file",
  scope: "file",
  projectId: "project-atlas",
  filePath: "src/index.ts",
  createdByUserId: "user-ana",
  audience: "public",
  recipientEmails: [],
  label: "Handover",
  createdAt: "2026-08-16T09:00:00.000Z",
  expiresAt: null,
};

layer("ShareLinkRepository", (it) => {
  it.effect("stores a link and finds it by its token alone", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      const created = yield* repository.createLink(fileLink);
      assert.equal(created.scope, "file");
      assert.equal(created.filePath, "src/index.ts");
      assert.equal(created.viewCount, 0);
      assert.equal(created.lastViewedAt, null);
      assert.equal(created.revokedAt, null);

      // The token is all a visitor has: no tenant, no workspace, no session.
      const found = yield* repository.getLinkByToken({ token: "token-file" });
      assert.equal(Option.isSome(found), true);
      assert.equal(Option.getOrUndefined(found)?.linkId, "link-file");

      const missing = yield* repository.getLinkByToken({ token: "token-that-was-guessed" });
      assert.equal(Option.isNone(missing), true);
    }),
  );

  it.effect("answers expiry and revocation from the row the token lookup returns", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      yield* repository.createLink({
        ...fileLink,
        linkId: "link-lapsed",
        token: "token-lapsed",
        expiresAt: "2026-08-01T00:00:00.000Z",
      });

      const lapsed = yield* repository.getLinkByToken({ token: "token-lapsed" });
      const row = Option.getOrUndefined(lapsed);
      // Both stopping conditions travel on the one row, so no second query is
      // needed to decide whether the link still works.
      assert.equal(row?.expiresAt, "2026-08-01T00:00:00.000Z");
      assert.equal(row?.revokedAt, null);
    }),
  );

  it.effect("keeps the first revocation time when a link is revoked twice", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      yield* repository.createLink({
        ...fileLink,
        linkId: "link-revoked",
        token: "token-revoked",
      });

      const first = yield* repository.revokeLink({
        ...workspaceScope,
        linkId: "link-revoked",
        revokedAt: "2026-08-18T10:00:00.000Z",
      });
      assert.equal(Option.getOrUndefined(first)?.record.revokedAt, "2026-08-18T10:00:00.000Z");
      assert.equal(Option.getOrUndefined(first)?.alreadyRevoked, false);

      const second = yield* repository.revokeLink({
        ...workspaceScope,
        linkId: "link-revoked",
        revokedAt: "2026-08-19T10:00:00.000Z",
      });
      // Still `some`, so "already revoked" is not reported as "no such link",
      // and the original time — when access actually ended — has not moved.
      assert.equal(Option.isSome(second), true);
      assert.equal(Option.getOrUndefined(second)?.alreadyRevoked, true);
      assert.equal(Option.getOrUndefined(second)?.record.revokedAt, "2026-08-18T10:00:00.000Z");

      // A revoked link is still readable by token: the visitor has to be told
      // which kind of no they got.
      const stillReadable = yield* repository.getLinkByToken({ token: "token-revoked" });
      assert.equal(Option.getOrUndefined(stillReadable)?.revokedAt, "2026-08-18T10:00:00.000Z");
    }),
  );

  it.effect("refuses to revoke a link belonging to another workspace", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      yield* repository.createLink({
        ...fileLink,
        linkId: "link-elsewhere",
        token: "token-elsewhere",
      });

      const foreign = yield* repository.revokeLink({
        tenantId: "tenant-acme",
        workspaceId: "workspace-someone-else",
        linkId: "link-elsewhere",
        revokedAt: "2026-08-18T10:00:00.000Z",
      });
      assert.equal(Option.isNone(foreign), true);

      const untouched = yield* repository.getLinkByToken({ token: "token-elsewhere" });
      assert.equal(Option.getOrUndefined(untouched)?.revokedAt, null);
    }),
  );

  it.effect("lists a workspace's links and a single project's, newest first", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;
      const scope = { tenantId: "tenant-list", workspaceId: "workspace-list" };

      yield* repository.createLink({
        ...fileLink,
        ...scope,
        linkId: "list-project",
        token: "list-project-token",
        scope: "project",
        projectId: "project-one",
        filePath: null,
        createdAt: "2026-08-10T00:00:00.000Z",
      });
      yield* repository.createLink({
        ...fileLink,
        ...scope,
        linkId: "list-file",
        token: "list-file-token",
        projectId: "project-one",
        createdAt: "2026-08-11T00:00:00.000Z",
      });
      // A workspace invitation has no project, so it must appear in the
      // workspace listing and in no project's.
      yield* repository.createLink({
        ...fileLink,
        ...scope,
        linkId: "list-workspace",
        token: "list-workspace-token",
        scope: "workspace",
        projectId: null,
        filePath: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      // Another workspace entirely: must not leak into either listing.
      yield* repository.createLink({
        ...fileLink,
        tenantId: "tenant-list",
        workspaceId: "workspace-other",
        linkId: "list-outsider",
        token: "list-outsider-token",
        projectId: "project-one",
        createdAt: "2026-08-13T00:00:00.000Z",
      });

      const workspaceLinks = yield* repository.listLinksForWorkspace(scope);
      assert.deepStrictEqual(
        workspaceLinks.map((link) => link.linkId),
        ["list-workspace", "list-file", "list-project"],
      );

      const projectLinks = yield* repository.listLinksForProject({
        tenantId: "tenant-list",
        projectId: "project-one",
      });
      assert.deepStrictEqual(
        projectLinks.map((link) => link.linkId),
        ["list-outsider", "list-file", "list-project"],
      );
    }),
  );

  it.effect("counts a view on the link and keeps the click in the series", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      yield* repository.createLink({
        ...fileLink,
        linkId: "link-viewed",
        token: "token-viewed",
      });

      const first = yield* repository.recordView({
        viewId: "view-1",
        linkId: "link-viewed",
        viewedAt: "2026-08-17T10:00:00.000Z",
        viewerUserId: null,
        viewerFingerprint: "sha256:9f2c",
      });
      assert.equal(Option.getOrUndefined(first)?.viewCount, 1);

      yield* repository.recordView({
        viewId: "view-2",
        linkId: "link-viewed",
        viewedAt: "2026-08-17T11:00:00.000Z",
        viewerUserId: "user-grace",
        viewerFingerprint: null,
      });

      const summary = yield* repository.getLinkByToken({ token: "token-viewed" });
      assert.equal(Option.getOrUndefined(summary)?.viewCount, 2);
      assert.equal(Option.getOrUndefined(summary)?.lastViewedAt, "2026-08-17T11:00:00.000Z");

      // The counter says how many; only the series says who and when.
      const views = yield* repository.listViews({ linkId: "link-viewed", limit: 10 });
      assert.deepStrictEqual(
        views.map((view) => [view.viewId, view.viewerUserId]),
        [
          ["view-2", "user-grace"],
          ["view-1", null],
        ],
      );

      const capped = yield* repository.listViews({ linkId: "link-viewed", limit: 1 });
      assert.equal(capped.length, 1);
      assert.equal(capped[0]?.viewId, "view-2");
    }),
  );

  it.effect("records nothing at all for a link that is not there", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      const recorded = yield* repository.recordView({
        viewId: "view-orphan",
        linkId: "link-that-never-existed",
        viewedAt: "2026-08-17T10:00:00.000Z",
        viewerUserId: null,
        viewerFingerprint: null,
      });
      assert.equal(Option.isNone(recorded), true);

      const views = yield* repository.listViews({
        linkId: "link-that-never-existed",
        limit: 10,
      });
      assert.equal(views.length, 0);
    }),
  );

  it.effect("stores a restricted link's recipients alongside it, and scopes the read", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;
      const scope = { tenantId: "tenant-audience", workspaceId: "workspace-audience" };

      yield* repository.createLink({
        ...fileLink,
        ...scope,
        linkId: "link-restricted",
        token: "token-restricted",
        scope: "workspace",
        projectId: null,
        filePath: null,
        audience: "restricted",
        recipientEmails: ["ana@example.test", "bo@example.test"],
      });
      yield* repository.createLink({
        ...fileLink,
        ...scope,
        linkId: "link-open",
        token: "token-open",
        scope: "workspace",
        projectId: null,
        filePath: null,
      });
      // Another workspace's restricted link. Its recipients are the thing a
      // leak here would disclose, so the workspace read must not reach them.
      yield* repository.createLink({
        ...fileLink,
        tenantId: "tenant-audience",
        workspaceId: "workspace-elsewhere",
        linkId: "link-audience-elsewhere",
        token: "token-elsewhere-audience",
        scope: "workspace",
        projectId: null,
        filePath: null,
        audience: "restricted",
        recipientEmails: ["cass@example.test"],
      });

      const stored = yield* repository.getLinkByToken({ token: "token-restricted" });
      assert.equal(Option.getOrUndefined(stored)?.audience, "restricted");
      const open = yield* repository.getLinkByToken({ token: "token-open" });
      assert.equal(Option.getOrUndefined(open)?.audience, "public");

      const forLink = yield* repository.listRecipients({ linkId: "link-restricted" });
      assert.deepStrictEqual(
        forLink.map((recipient) => recipient.email),
        ["ana@example.test", "bo@example.test"],
      );
      assert.equal((yield* repository.listRecipients({ linkId: "link-open" })).length, 0);

      const forWorkspace = yield* repository.listRecipientsForWorkspace(scope);
      assert.deepStrictEqual(
        forWorkspace.map((recipient) => `${recipient.linkId}:${recipient.email}`),
        ["link-restricted:ana@example.test", "link-restricted:bo@example.test"],
      );
    }),
  );

  it.effect("mints tokens that are URL-safe, long, and never repeated", () =>
    Effect.gen(function* () {
      const repository = yield* ShareLinkRepository;

      const tokens = new Set<string>();
      for (let index = 0; index < 200; index += 1) {
        const token = generateShareLinkToken();
        // base64url only: nothing that a URL, a mail client or a copy-paste
        // would re-encode on the way to the recipient.
        assert.match(token, /^[A-Za-z0-9_-]+$/);
        // 32 bytes in base64url is 43 characters, unpadded.
        assert.equal(token.length, 43);
        tokens.add(token);
      }
      assert.equal(tokens.size, 200);

      // And the store treats it as the credential it is: two links can never
      // share one.
      const token = generateShareLinkToken();
      yield* repository.createLink({ ...fileLink, linkId: "link-minted", token });
      const found = yield* repository.getLinkByToken({ token });
      assert.equal(Option.getOrUndefined(found)?.linkId, "link-minted");

      const collision = yield* Effect.result(
        repository.createLink({ ...fileLink, linkId: "link-collision", token }),
      );
      assert.equal(collision._tag, "Failure");
    }),
  );
});
