import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CreateShareLinkInput,
  GetShareLinkByTokenInput,
  ListShareLinkRecipientsForWorkspaceInput,
  ListShareLinkRecipientsInput,
  ListShareLinksForProjectInput,
  ListShareLinksForWorkspaceInput,
  ListShareLinkViewsInput,
  RecordShareLinkViewInput,
  RevokeShareLinkInput,
  type ShareLinkRecipientRecord,
  type ShareLinkRecord,
  ShareLinkRepository,
  type ShareLinkRepositoryShape,
  type ShareLinkViewRecord,
} from "../Services/ShareLinks.ts";

const ShareLinkRow = Schema.Struct({
  linkId: Schema.String,
  token: Schema.String,
  scope: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  filePath: Schema.NullOr(Schema.String),
  createdByUserId: Schema.String,
  audience: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  lastViewedAt: Schema.NullOr(Schema.String),
  viewCount: Schema.Int,
});

const ShareLinkRecipientRow = Schema.Struct({
  linkId: Schema.String,
  email: Schema.String,
  createdAt: Schema.String,
});

const ShareLinkViewRow = Schema.Struct({
  viewId: Schema.String,
  linkId: Schema.String,
  viewedAt: Schema.String,
  viewerUserId: Schema.NullOr(Schema.String),
  viewerFingerprint: Schema.NullOr(Schema.String),
});

const linkColumns = `link_id AS "linkId",
  token,
  scope,
  tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  project_id AS "projectId",
  file_path AS "filePath",
  created_by_user_id AS "createdByUserId",
  audience,
  label,
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  revoked_at AS "revokedAt",
  last_viewed_at AS "lastViewedAt",
  view_count AS "viewCount"`;

const recipientColumns = `link_id AS "linkId",
  email,
  created_at AS "createdAt"`;

/** The same three columns, qualified for the read that joins to `share_links`. */
const joinedRecipientColumns = `r.link_id AS "linkId",
  r.email,
  r.created_at AS "createdAt"`;

const viewColumns = `view_id AS "viewId",
  link_id AS "linkId",
  viewed_at AS "viewedAt",
  viewer_user_id AS "viewerUserId",
  viewer_fingerprint AS "viewerFingerprint"`;

const makeShareLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createLinkRow = SqlSchema.findOne({
    Request: CreateShareLinkInput,
    Result: ShareLinkRow,
    // No ON CONFLICT anywhere. Both unique constraints here are supposed to be
    // impossible: a repeated link id is a broken id generator, and a repeated
    // token is a broken CSPRNG. Quietly upserting past either would replace one
    // person's link with another's and hand their visitors the wrong content,
    // so the INSERT is left to fail and be seen.
    execute: (input) =>
      sql`
        INSERT INTO share_links (
          link_id,
          token,
          scope,
          tenant_id,
          workspace_id,
          project_id,
          file_path,
          created_by_user_id,
          audience,
          label,
          created_at,
          expires_at,
          revoked_at,
          last_viewed_at,
          view_count
        )
        VALUES (
          ${input.linkId},
          ${input.token},
          ${input.scope},
          ${input.tenantId},
          ${input.workspaceId},
          ${input.projectId},
          ${input.filePath},
          ${input.createdByUserId},
          ${input.audience},
          ${input.label},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL,
          0
        )
        RETURNING ${sql.literal(linkColumns)}
      `,
  });

  const listLinksForWorkspaceRows = SqlSchema.findAll({
    Request: ListShareLinksForWorkspaceInput,
    Result: ShareLinkRow,
    // Newest first: someone opening this panel is looking for the link they
    // just made, or the one they now regret.
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(linkColumns)} FROM share_links
          WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
          ORDER BY created_at DESC, link_id ASC`,
  });

  const listLinksForProjectRows = SqlSchema.findAll({
    Request: ListShareLinksForProjectInput,
    Result: ShareLinkRow,
    execute: ({ tenantId, projectId }) =>
      sql`SELECT ${sql.literal(linkColumns)} FROM share_links
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          ORDER BY created_at DESC, link_id ASC`,
  });

  const getLinkByTokenRow = SqlSchema.findOneOption({
    Request: GetShareLinkByTokenInput,
    Result: ShareLinkRow,
    // Expiry and revocation are read, not filtered on. A visitor holding a
    // switched-off link has to be told which kind of "no" they got, and both
    // answers come off this one row — so the redemption path never issues a
    // second query, and there is no window in which a link works for one more
    // request after being revoked.
    execute: ({ token }) =>
      sql`SELECT ${sql.literal(linkColumns)} FROM share_links
          WHERE token = ${token}`,
  });

  const findLinkRowById = SqlSchema.findOneOption({
    Request: RevokeShareLinkInput,
    Result: ShareLinkRow,
    execute: (input) =>
      sql`
        SELECT ${sql.literal(linkColumns)}
        FROM share_links
        WHERE link_id = ${input.linkId}
          AND tenant_id = ${input.tenantId}
          AND workspace_id = ${input.workspaceId}
      `,
  });

  const revokeLinkRow = SqlSchema.findOneOption({
    Request: RevokeShareLinkInput,
    Result: ShareLinkRow,
    // Guarded on `revoked_at IS NULL`, so this UPDATE touches a live link and
    // nothing else — the first revocation time never moves, which is what an
    // incident review asks for.
    //
    // It used to COALESCE and let the caller compare the returned timestamp
    // with the one it sent to tell "just revoked" from "already was". That
    // reads correctly and is wrong: `nowIso()` has millisecond resolution, so
    // two revokes in the same millisecond produce the same string and the
    // second one reports success. `revokeLink` therefore pairs this with a
    // lookup and answers the question directly instead of inferring it.
    execute: (input) =>
      sql`
        UPDATE share_links
        SET revoked_at = ${input.revokedAt}
        WHERE link_id = ${input.linkId}
          AND tenant_id = ${input.tenantId}
          AND workspace_id = ${input.workspaceId}
          AND revoked_at IS NULL
        RETURNING ${sql.literal(linkColumns)}
      `,
  });

  const bumpLinkViewCountersRow = SqlSchema.findOneOption({
    Request: RecordShareLinkViewInput,
    Result: ShareLinkRow,
    // `view_count + 1` in SQL rather than read-modify-write in TypeScript: two
    // visitors arriving at once would otherwise both read the same number and
    // write the same increment, losing one of the views the series below
    // records — which is exactly the disagreement between summary and detail
    // this pair exists to avoid.
    execute: (input) =>
      sql`
        UPDATE share_links
        SET view_count = view_count + 1,
            last_viewed_at = ${input.viewedAt}
        WHERE link_id = ${input.linkId}
        RETURNING ${sql.literal(linkColumns)}
      `,
  });

  const insertViewRow = SqlSchema.void({
    Request: RecordShareLinkViewInput,
    execute: (input) =>
      sql`
        INSERT INTO share_link_views (
          view_id,
          link_id,
          viewed_at,
          viewer_user_id,
          viewer_fingerprint
        )
        VALUES (
          ${input.viewId},
          ${input.linkId},
          ${input.viewedAt},
          ${input.viewerUserId},
          ${input.viewerFingerprint}
        )
      `,
  });

  const listRecipientsRows = SqlSchema.findAll({
    Request: ListShareLinkRecipientsInput,
    Result: ShareLinkRecipientRow,
    execute: ({ linkId }) =>
      sql`SELECT ${sql.literal(recipientColumns)} FROM share_link_recipients
          WHERE link_id = ${linkId}
          ORDER BY email ASC`,
  });

  const listRecipientsForWorkspaceRows = SqlSchema.findAll({
    Request: ListShareLinkRecipientsForWorkspaceInput,
    Result: ShareLinkRecipientRow,
    // Joined rather than filtered in the caller: a recipient row carries no
    // tenant of its own, and handing back rows for links the caller was never
    // authorised to read would make the panel's own filtering the only thing
    // standing between one workspace and another's recipient lists.
    execute: ({ tenantId, workspaceId }) =>
      sql`SELECT ${sql.literal(joinedRecipientColumns)}
          FROM share_link_recipients r
          JOIN share_links l ON l.link_id = r.link_id
          WHERE l.tenant_id = ${tenantId} AND l.workspace_id = ${workspaceId}
          ORDER BY r.link_id ASC, r.email ASC`,
  });

  const listViewsRows = SqlSchema.findAll({
    Request: ListShareLinkViewsInput,
    Result: ShareLinkViewRow,
    execute: ({ linkId, limit }) =>
      sql`SELECT ${sql.literal(viewColumns)} FROM share_link_views
          WHERE link_id = ${linkId}
          ORDER BY viewed_at DESC, view_id ASC
          LIMIT ${limit}`,
  });

  /**
   * The link and the people it is for, in one transaction.
   *
   * Not two calls, because the gap between them is a window in which a
   * restricted link exists with an empty recipient list — and an empty list is
   * exactly what the redemption check reads when it decides nobody may enter.
   * A half-written link that lets nobody in is recoverable; the reverse
   * ordering would be a link that briefly lets everybody in, and it is not
   * worth reasoning about which of the two a crash would leave behind.
   */
  const createLink: ShareLinkRepositoryShape["createLink"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const row = yield* createLinkRow(input);
          yield* Effect.forEach(
            input.recipientEmails,
            (email) =>
              sql`
                INSERT INTO share_link_recipients (link_id, email, created_at)
                VALUES (${input.linkId}, ${email}, ${input.createdAt})
              `,
            { discard: true },
          );
          return toShareLink(row);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ShareLinkRepository.createLink:query")));

  const listLinksForWorkspace: ShareLinkRepositoryShape["listLinksForWorkspace"] = (input) =>
    listLinksForWorkspaceRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.listLinksForWorkspace:query")),
      Effect.map((rows) => rows.map(toShareLink)),
    );

  const listLinksForProject: ShareLinkRepositoryShape["listLinksForProject"] = (input) =>
    listLinksForProjectRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.listLinksForProject:query")),
      Effect.map((rows) => rows.map(toShareLink)),
    );

  const getLinkByToken: ShareLinkRepositoryShape["getLinkByToken"] = (input) =>
    getLinkByTokenRow(input).pipe(
      // The failure label names the operation and not the token, and must go on
      // doing so: this error is raised on an unauthenticated request, and a
      // token in a log line is a credential in a log line.
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.getLinkByToken:query")),
      Effect.map((row) => (Option.isSome(row) ? Option.some(toShareLink(row.value)) : row)),
    );

  /**
   * Three outcomes, told apart without guessing: no such link, a link this call
   * revoked, and a link somebody else already had. The guarded UPDATE answers
   * the middle one; the lookup that follows separates the other two, and only
   * runs when the UPDATE changed nothing.
   */
  const revokeLink: ShareLinkRepositoryShape["revokeLink"] = (input) =>
    Effect.gen(function* () {
      const revoked = yield* revokeLinkRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ShareLinkRepository.revokeLink:query")),
      );
      if (Option.isSome(revoked)) {
        return Option.some({ record: toShareLink(revoked.value), alreadyRevoked: false });
      }

      const existing = yield* findLinkRowById(input).pipe(
        Effect.mapError(toPersistenceSqlError("ShareLinkRepository.revokeLink:lookup")),
      );
      return Option.isSome(existing)
        ? Option.some({ record: toShareLink(existing.value), alreadyRevoked: true })
        : Option.none();
    });

  // One transaction, because the counter and the series are two views of the
  // same click. Appending the row without the bump would make the list
  // understate a link's traffic; bumping without the row would leave a count
  // the detail page cannot account for, and the notch would show a view with
  // nothing behind it.
  const recordView: ShareLinkRepositoryShape["recordView"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const updated = yield* bumpLinkViewCountersRow(input);
          // No link, no view row: an orphan here would be counted by the
          // analytics page against a link it can never name.
          if (Option.isNone(updated)) {
            return Option.none<ShareLinkRecord>();
          }
          yield* insertViewRow(input);
          return Option.some(toShareLink(updated.value));
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ShareLinkRepository.recordView:query")));

  const listViews: ShareLinkRepositoryShape["listViews"] = (input) =>
    listViewsRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.listViews:query")),
      Effect.map((rows) => rows.map(toShareLinkView)),
    );

  const listRecipients: ShareLinkRepositoryShape["listRecipients"] = (input) =>
    listRecipientsRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.listRecipients:query")),
      Effect.map((rows) => rows.map(toShareLinkRecipient)),
    );

  const listRecipientsForWorkspace: ShareLinkRepositoryShape["listRecipientsForWorkspace"] = (
    input,
  ) =>
    listRecipientsForWorkspaceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ShareLinkRepository.listRecipientsForWorkspace:query"),
      ),
      Effect.map((rows) => rows.map(toShareLinkRecipient)),
    );

  return {
    createLink,
    listLinksForWorkspace,
    listLinksForProject,
    getLinkByToken,
    revokeLink,
    recordView,
    listViews,
    listRecipients,
    listRecipientsForWorkspace,
  } satisfies ShareLinkRepositoryShape;
});

function toShareLink(row: typeof ShareLinkRow.Type): ShareLinkRecord {
  return {
    linkId: row.linkId,
    token: row.token,
    scope: row.scope,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    filePath: row.filePath,
    createdByUserId: row.createdByUserId,
    audience: row.audience,
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastViewedAt: row.lastViewedAt,
    viewCount: row.viewCount,
  };
}

function toShareLinkRecipient(row: typeof ShareLinkRecipientRow.Type): ShareLinkRecipientRecord {
  return {
    linkId: row.linkId,
    email: row.email,
    createdAt: row.createdAt,
  };
}

function toShareLinkView(row: typeof ShareLinkViewRow.Type): ShareLinkViewRecord {
  return {
    viewId: row.viewId,
    linkId: row.linkId,
    viewedAt: row.viewedAt,
    viewerUserId: row.viewerUserId,
    viewerFingerprint: row.viewerFingerprint,
  };
}

export const ShareLinkRepositoryLive: Layer.Layer<ShareLinkRepository, never, SqlClient.SqlClient> =
  Layer.effect(ShareLinkRepository, makeShareLinkRepository);
