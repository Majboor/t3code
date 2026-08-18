import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CreateShareLinkInput,
  GetShareLinkByTokenInput,
  ListShareLinksForProjectInput,
  ListShareLinksForWorkspaceInput,
  ListShareLinkViewsInput,
  RecordShareLinkViewInput,
  RevokeShareLinkInput,
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
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  lastViewedAt: Schema.NullOr(Schema.String),
  viewCount: Schema.Int,
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
  label,
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  revoked_at AS "revokedAt",
  last_viewed_at AS "lastViewedAt",
  view_count AS "viewCount"`;

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

  const revokeLinkRow = SqlSchema.findOneOption({
    Request: RevokeShareLinkInput,
    Result: ShareLinkRow,
    // COALESCE rather than a `revoked_at IS NULL` guard. A guard would make a
    // second revoke return nothing, which is indistinguishable from the link
    // not existing; this way the row always comes back and the caller compares
    // the returned timestamp with the one it sent to tell "just revoked" from
    // "already was". The original time is what an incident review asks for, so
    // it must not move.
    execute: (input) =>
      sql`
        UPDATE share_links
        SET revoked_at = COALESCE(revoked_at, ${input.revokedAt})
        WHERE link_id = ${input.linkId}
          AND tenant_id = ${input.tenantId}
          AND workspace_id = ${input.workspaceId}
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

  const listViewsRows = SqlSchema.findAll({
    Request: ListShareLinkViewsInput,
    Result: ShareLinkViewRow,
    execute: ({ linkId, limit }) =>
      sql`SELECT ${sql.literal(viewColumns)} FROM share_link_views
          WHERE link_id = ${linkId}
          ORDER BY viewed_at DESC, view_id ASC
          LIMIT ${limit}`,
  });

  const createLink: ShareLinkRepositoryShape["createLink"] = (input) =>
    createLinkRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.createLink:query")),
      Effect.map(toShareLink),
    );

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

  const revokeLink: ShareLinkRepositoryShape["revokeLink"] = (input) =>
    revokeLinkRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ShareLinkRepository.revokeLink:query")),
      Effect.map((row) => (Option.isSome(row) ? Option.some(toShareLink(row.value)) : row)),
    );

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

  return {
    createLink,
    listLinksForWorkspace,
    listLinksForProject,
    getLinkByToken,
    revokeLink,
    recordView,
    listViews,
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
    label: row.label,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastViewedAt: row.lastViewedAt,
    viewCount: row.viewCount,
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
