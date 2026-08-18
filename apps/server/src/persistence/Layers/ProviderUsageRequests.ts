import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CreateProviderUsageRequestInput,
  GetProviderUsageRequestInput,
  ListProviderUsageRequestsForUserInput,
  ListProviderUsageRequestsForWorkspaceInput,
  ProviderUsageRequestRepository,
  type ProviderUsageRequestRecord,
  type ProviderUsageRequestRepositoryShape,
  UpdateProviderUsageRequestStatusInput,
} from "../Services/ProviderUsageRequests.ts";

const ProviderUsageRequestRow = Schema.Struct({
  requestId: Schema.String,
  tenantId: Schema.String,
  workspaceId: Schema.String,
  requesterUserId: Schema.String,
  provider: Schema.String,
  reason: Schema.String,
  note: Schema.NullOr(Schema.String),
  status: Schema.String,
  createdAt: Schema.String,
  respondedAt: Schema.NullOr(Schema.String),
  respondedByUserId: Schema.NullOr(Schema.String),
  respondedAccountId: Schema.NullOr(Schema.String),
});

const requestColumns = `request_id AS "requestId",
  tenant_id AS "tenantId",
  workspace_id AS "workspaceId",
  requester_user_id AS "requesterUserId",
  provider,
  reason,
  note,
  status,
  created_at AS "createdAt",
  responded_at AS "respondedAt",
  responded_by_user_id AS "respondedByUserId",
  responded_account_id AS "respondedAccountId"`;

const makeProviderUsageRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createRequestRow = SqlSchema.findOne({
    Request: CreateProviderUsageRequestInput,
    Result: ProviderUsageRequestRow,
    // The conflict target repeats the partial index's WHERE clause because
    // that is how SQLite is told which index is meant; without it the upsert
    // matches no unique index and the statement is rejected outright.
    execute: (input) =>
      sql`
        INSERT INTO provider_usage_requests (
          request_id,
          tenant_id,
          workspace_id,
          requester_user_id,
          provider,
          reason,
          note,
          status,
          created_at,
          responded_at,
          responded_by_user_id,
          responded_account_id
        )
        VALUES (
          ${input.requestId},
          ${input.tenantId},
          ${input.workspaceId},
          ${input.requesterUserId},
          ${input.provider},
          ${input.reason},
          ${input.note},
          'pending',
          ${input.createdAt},
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT (tenant_id, workspace_id, requester_user_id, provider)
        WHERE status = 'pending'
        DO UPDATE SET
          reason = excluded.reason,
          note = excluded.note
          -- created_at deliberately stays put. It is how long someone has been
          -- waiting, and it is what the queue sorts on; letting a re-ask move
          -- it would push the person who has waited longest to the bottom.
        RETURNING ${sql.literal(requestColumns)}
      `,
  });

  const listRequestsForWorkspaceRows = SqlSchema.findAll({
    Request: ListProviderUsageRequestsForWorkspaceInput,
    Result: ProviderUsageRequestRow,
    execute: ({ tenantId, workspaceId, status }) =>
      status === undefined
        ? sql`SELECT ${sql.literal(requestColumns)} FROM provider_usage_requests
            WHERE tenant_id = ${tenantId} AND workspace_id = ${workspaceId}
            ORDER BY created_at ASC, request_id ASC`
        : sql`SELECT ${sql.literal(requestColumns)} FROM provider_usage_requests
            WHERE tenant_id = ${tenantId}
              AND workspace_id = ${workspaceId}
              AND status = ${status}
            ORDER BY created_at ASC, request_id ASC`,
  });

  const listRequestsForUserRows = SqlSchema.findAll({
    Request: ListProviderUsageRequestsForUserInput,
    Result: ProviderUsageRequestRow,
    // Newest first: this is the asker looking at what they sent, and the last
    // thing they did is the thing they are looking for. The reviewer's queue
    // above sorts the other way for the opposite reason.
    execute: ({ tenantId, workspaceId, requesterUserId }) =>
      sql`SELECT ${sql.literal(requestColumns)} FROM provider_usage_requests
          WHERE tenant_id = ${tenantId}
            AND workspace_id = ${workspaceId}
            AND requester_user_id = ${requesterUserId}
          ORDER BY created_at DESC, request_id ASC`,
  });

  const getRequestRow = SqlSchema.findOneOption({
    Request: GetProviderUsageRequestInput,
    Result: ProviderUsageRequestRow,
    execute: ({ requestId }) =>
      sql`SELECT ${sql.literal(requestColumns)} FROM provider_usage_requests
          WHERE request_id = ${requestId}`,
  });

  const updateRequestStatusRow = SqlSchema.findOneOption({
    Request: UpdateProviderUsageRequestStatusInput,
    Result: ProviderUsageRequestRow,
    // The status guard makes two admins answering at once safe: the first
    // UPDATE moves the row out of pending, the second matches nothing and
    // returns none rather than overwriting a decision that was already made
    // and already told to the asker.
    execute: (input) =>
      sql`
        UPDATE provider_usage_requests
        SET status = ${input.status},
            responded_at = ${input.respondedAt},
            responded_by_user_id = ${input.respondedByUserId},
            responded_account_id = ${input.respondedAccountId}
        WHERE request_id = ${input.requestId}
          AND status = 'pending'
        RETURNING ${sql.literal(requestColumns)}
      `,
  });

  const createRequest: ProviderUsageRequestRepositoryShape["createRequest"] = (input) =>
    createRequestRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderUsageRequestRepository.createRequest:query")),
      Effect.map(toProviderUsageRequest),
    );

  const listRequestsForWorkspace: ProviderUsageRequestRepositoryShape["listRequestsForWorkspace"] =
    (input) =>
      listRequestsForWorkspaceRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderUsageRequestRepository.listRequestsForWorkspace:query"),
        ),
        Effect.map((rows) => rows.map(toProviderUsageRequest)),
      );

  const listRequestsForUser: ProviderUsageRequestRepositoryShape["listRequestsForUser"] = (input) =>
    listRequestsForUserRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderUsageRequestRepository.listRequestsForUser:query"),
      ),
      Effect.map((rows) => rows.map(toProviderUsageRequest)),
    );

  const getRequest: ProviderUsageRequestRepositoryShape["getRequest"] = (input) =>
    getRequestRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderUsageRequestRepository.getRequest:query")),
      Effect.map((row) =>
        Option.isSome(row) ? Option.some(toProviderUsageRequest(row.value)) : row,
      ),
    );

  const updateRequestStatus: ProviderUsageRequestRepositoryShape["updateRequestStatus"] = (input) =>
    updateRequestStatusRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProviderUsageRequestRepository.updateRequestStatus:query"),
      ),
      Effect.map((row) =>
        Option.isSome(row) ? Option.some(toProviderUsageRequest(row.value)) : row,
      ),
    );

  return {
    createRequest,
    listRequestsForWorkspace,
    listRequestsForUser,
    getRequest,
    updateRequestStatus,
  } satisfies ProviderUsageRequestRepositoryShape;
});

function toProviderUsageRequest(
  row: typeof ProviderUsageRequestRow.Type,
): ProviderUsageRequestRecord {
  return {
    requestId: row.requestId,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    requesterUserId: row.requesterUserId,
    provider: row.provider,
    reason: row.reason,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt,
    respondedByUserId: row.respondedByUserId,
    respondedAccountId: row.respondedAccountId,
  };
}

export const ProviderUsageRequestRepositoryLive: Layer.Layer<
  ProviderUsageRequestRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(ProviderUsageRequestRepository, makeProviderUsageRequestRepository);
