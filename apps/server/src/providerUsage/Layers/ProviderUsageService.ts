import {
  ProviderUsageError,
  type CollaborationMember,
  type ProviderAccountId,
  type ProviderAuthKind,
  type ProviderUsageRequest,
  type ProviderUsageRequestId,
  type ProviderUsageRequestReason,
  type ProviderUsageRequestStatus,
  type TenantId,
  type UserId,
  type WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderSharingRepository } from "../../persistence/Services/ProviderSharing.ts";
import {
  ProviderUsageRequestRepository,
  type ProviderUsageRequestRecord,
} from "../../persistence/Services/ProviderUsageRequests.ts";
import { listProviderAccounts, type StoredProviderAccount } from "../../providerAuth/store.ts";
import {
  ProviderUsageService,
  type ProviderUsageActor,
  type ProviderUsageServiceShape,
} from "../Services/ProviderUsageService.ts";

/** One workspace, as every read and write here is scoped. */
interface UsageScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A failed read or write of storage, in the only vocabulary this error has.
 *
 * `ProviderUsageError` lists product outcomes and has no infrastructure member,
 * for the reason `ProviderSharingError` gives: from the caller's side a
 * workspace whose rows cannot be reached and a workspace that is not there are
 * the same non-answer, and the cause travels with it for the log.
 */
function storageFailure(message: string) {
  return (cause: unknown) =>
    new ProviderUsageError({ code: "workspace-not-found", message, cause });
}

/**
 * Storage keeps primitives, so every literal union is re-narrowed on the way
 * out. A row naming a value this build has never heard of costs its own row and
 * not the whole queue — the same trade migration 052 made by leaving `status`
 * unconstrained so an older binary could still read a newer row.
 */
function toProviderAuthKind(value: string): ProviderAuthKind | null {
  return value === "codex" || value === "claude" ? value : null;
}

function toStatus(value: string): ProviderUsageRequestStatus | null {
  return value === "pending" || value === "granted" || value === "declined" || value === "withdrawn"
    ? value
    : null;
}

function toReason(value: string): ProviderUsageRequestReason | null {
  return value === "no-account" || value === "limit-reached" || value === "asked" ? value : null;
}

/**
 * Ids are cast rather than re-parsed: they were branded when they were written,
 * and re-validating a stored id would turn one malformed row into a failed read
 * of everything around it.
 */
function asUserId(value: string): UserId {
  return value as UserId;
}

function asRequestId(value: string): ProviderUsageRequestId {
  return value as ProviderUsageRequestId;
}

function asAccountId(value: string): ProviderAccountId {
  return value as ProviderAccountId;
}

/**
 * The contract refuses to encode an empty name, and an id is a worse name than
 * a name but a better one than a blank.
 */
function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value !== null && value !== undefined && value.trim().length > 0 ? value : fallback;
}

function mapDefined<A, B>(items: ReadonlyArray<A>, map: (item: A) => B | null): ReadonlyArray<B> {
  const mapped: B[] = [];
  for (const item of items) {
    const next = map(item);
    if (next !== null) {
      mapped.push(next);
    }
  }
  return mapped;
}

/**
 * `requesterDisplayName` is resolved here rather than read back, because the
 * table has no column for it: 052 stores the request, and the roster stores who
 * people are. The contract still carries the name so a responder is told who is
 * asking, and the requester's own id is the fallback for someone the roster has
 * since forgotten — which is the case the denormalisation was meant to survive.
 */
function toRequest(
  record: ProviderUsageRequestRecord,
  displayName: string,
): ProviderUsageRequest | null {
  const provider = toProviderAuthKind(record.provider);
  const status = toStatus(record.status);
  const reason = toReason(record.reason);
  if (provider === null || status === null || reason === null) {
    return null;
  }
  return {
    id: asRequestId(record.requestId),
    tenantId: record.tenantId as TenantId,
    workspaceId: record.workspaceId as WorkspaceId,
    requesterUserId: asUserId(record.requesterUserId),
    requesterDisplayName: nonEmpty(displayName, record.requesterUserId),
    provider,
    reason,
    // A blank note is nothing said, not something blank said; the contract
    // encodes only the former.
    note: record.note !== null && record.note.trim().length > 0 ? record.note : null,
    status,
    createdAt: record.createdAt,
    respondedAt: record.respondedAt,
    respondedByUserId:
      record.respondedByUserId === null ? null : asUserId(record.respondedByUserId),
  };
}

const makeProviderUsageService = Effect.gen(function* () {
  const repository = yield* ProviderUsageRequestRepository;
  const sharingRepository = yield* ProviderSharingRepository;
  const collaboration = yield* CollaborationService;
  const config = yield* ServerConfig;

  /**
   * The same roster the sharing panel draws, for the same reason: a second
   * definition of "who is in this workspace" would eventually disagree with the
   * one the user is looking at, and this feature decides who may ask on it.
   */
  const readMembers = (
    actor: ProviderUsageActor,
    scope: UsageScope,
  ): Effect.Effect<ReadonlyArray<CollaborationMember>, ProviderUsageError> =>
    collaboration.listMembers(actor, scope).pipe(
      Effect.mapError(storageFailure("Could not read who belongs to this workspace.")),
      Effect.map((result) => result.members),
    );

  /**
   * Membership, and the name the workspace knows the caller by. Asking a
   * workspace you are not in is not a request, and answering its queue is not
   * yours to do — both are `forbidden` rather than a quiet empty result, so the
   * panel can say why.
   */
  const requireMember = (actor: ProviderUsageActor, scope: UsageScope) =>
    readMembers(actor, scope).pipe(
      Effect.flatMap((members) => {
        const self = members.find((member) => member.userId === actor.userId);
        return self === undefined
          ? Effect.fail(
              new ProviderUsageError({
                code: "forbidden",
                message: "Only a member of this workspace can ask it for provider usage.",
              }),
            )
          : Effect.succeed({ members, displayName: self.displayName });
      }),
    );

  /**
   * The store, never the index, is asked what somebody actually holds: the
   * index is a projection the connect flow maintains, while the disk is where a
   * credential either is or is not. Only connected accounts count — lending one
   * that was never finished would grant a request the requester cannot spend.
   */
  const readConnectedAccounts = (
    userId: UserId,
    provider?: ProviderAuthKind,
  ): Effect.Effect<ReadonlyArray<StoredProviderAccount>, ProviderUsageError> =>
    Effect.tryPromise({
      try: () => listProviderAccounts(config.stateDir, userId, provider),
      catch: (cause) =>
        new ProviderUsageError({
          code: "not-a-contributor",
          message: "Could not read the provider accounts connected for this user.",
          cause,
        }),
    }).pipe(Effect.map((accounts) => accounts.filter((account) => account.connected)));

  const decodeRequest = (record: ProviderUsageRequestRecord, displayName: string) => {
    const request = toRequest(record, displayName);
    return request === null
      ? Effect.fail(
          new ProviderUsageError({
            code: "request-not-found",
            // Written by a build that knew a value this one does not. Reporting
            // it as missing is honest: nothing here can act on it.
            message: "This request could not be read by this version of the server.",
          }),
        )
      : Effect.succeed(request);
  };

  /**
   * Request ids are surrogate and workspace-agnostic, so the scope has to be
   * re-checked against the row. A request from another workspace reads as
   * missing rather than forbidden, so an id cannot be probed for existence.
   */
  const readRequestInScope = (requestId: ProviderUsageRequestId, scope: UsageScope) =>
    repository.getRequest({ requestId }).pipe(
      Effect.mapError(storageFailure("Could not read this request.")),
      Effect.flatMap((found) =>
        Option.isSome(found) &&
        found.value.tenantId === scope.tenantId &&
        found.value.workspaceId === scope.workspaceId
          ? Effect.succeed(found.value)
          : Effect.fail(
              new ProviderUsageError({
                code: "request-not-found",
                message: "That request no longer exists.",
              }),
            ),
      ),
    );

  const alreadyDecided = () =>
    new ProviderUsageError({
      code: "request-already-decided",
      message: "Somebody has already answered this request.",
    });

  const createRequest: ProviderUsageServiceShape["createRequest"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: UsageScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      const { displayName } = yield* requireMember(actor, scope);

      // The id is minted here but may be discarded: the repository upserts, so
      // a second ask while one is open re-states the open row and returns its
      // original id and createdAt. Everything below reads the returned record.
      const record = yield* repository
        .createRequest({
          requestId: crypto.randomUUID(),
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          requesterUserId: actor.userId,
          provider: input.provider,
          reason: input.reason,
          note: input.note ?? null,
          createdAt: nowIso(),
        })
        .pipe(Effect.mapError(storageFailure("Could not record this request.")));

      return { request: yield* decodeRequest(record, displayName) };
    });

  const listRequests: ProviderUsageServiceShape["listRequests"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: UsageScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };

      // Deliberately not gated on membership: seeing what you yourself asked is
      // never a disclosure, and someone whose membership lapsed still has to be
      // able to find and withdraw their own open request.
      const { ownRecords, pendingRecords, accounts } = yield* Effect.all(
        {
          ownRecords: repository
            .listRequestsForUser({ ...scope, requesterUserId: actor.userId })
            .pipe(Effect.mapError(storageFailure("Could not read this user's requests."))),
          pendingRecords: repository
            .listRequestsForWorkspace({ ...scope, status: "pending" })
            .pipe(
              Effect.mapError(storageFailure("Could not read this workspace's open requests.")),
            ),
          accounts: readConnectedAccounts(actor.userId),
        },
        { concurrency: "unbounded" },
      );

      const lendable = new Set(accounts.map((account) => account.provider as string));
      // Two filters, one rule: only show what this person could actually
      // answer. Their own ask is not theirs to grant, and a Claude holder shown
      // a Codex request is the same dead end `canRespond` exists to prevent.
      const answerable = pendingRecords.filter(
        (record) => record.requesterUserId !== actor.userId && lendable.has(record.provider),
      );

      const members = answerable.length === 0 ? [] : yield* readMembers(actor, scope);
      const displayNames = new Map(
        members.map((member) => [member.userId as string, member.displayName]),
      );

      const ownName = nonEmpty(actor.displayName, actor.userId);
      return {
        requests: [
          ...mapDefined(ownRecords, (record) => toRequest(record, ownName)),
          ...mapDefined(answerable, (record) =>
            toRequest(
              record,
              nonEmpty(displayNames.get(record.requesterUserId), record.requesterUserId),
            ),
          ),
        ],
        canRespond: answerable.length > 0,
      };
    });

  const respondToRequest: ProviderUsageServiceShape["respondToRequest"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: UsageScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      const { members } = yield* requireMember(actor, scope);
      const record = yield* readRequestInScope(input.requestId, scope);

      if (record.requesterUserId === actor.userId) {
        return yield* new ProviderUsageError({
          code: "forbidden",
          message: "You cannot answer your own request.",
        });
      }
      // The repository's guard is the one that decides the race; this only
      // saves a granted request from lending an account nobody is waiting for.
      if (record.status !== "pending") {
        return yield* alreadyDecided();
      }

      const provider = toProviderAuthKind(record.provider);
      if (provider === null) {
        // Asked for a provider this build has never heard of: there is no
        // account it could name, so it cannot be answered here either.
        return yield* new ProviderUsageError({
          code: "request-not-found",
          message: "This request could not be read by this version of the server.",
        });
      }

      const connected = yield* readConnectedAccounts(actor.userId, provider);
      if (connected.length === 0) {
        return yield* new ProviderUsageError({
          code: "not-a-contributor",
          message: "Connect an account for this provider before answering a request for it.",
        });
      }

      let lentAccountId: ProviderAccountId | null = null;
      if (input.decision === "grant") {
        const chosen =
          input.accountId === undefined
            ? undefined
            : connected.find((account) => account.accountId === input.accountId);
        if (chosen === undefined) {
          return yield* new ProviderUsageError({
            code: "account-not-found",
            message: "Granting a request needs one of your own connected accounts to lend.",
          });
        }
        lentAccountId = asAccountId(chosen.accountId);

        const updatedAt = nowIso();
        // Two rows, because a grant is two facts and neither is the other: the
        // share is the owner offering this account to this workspace, the grant
        // is the requester being told to run on the workspace's rather than
        // their own. A share without a grant lends to nobody, and a grant
        // without a share points at an account that is not lent — either way
        // the request would read as granted while the turn still refused.
        yield* sharingRepository
          .upsertShare({
            ...scope,
            ownerUserId: actor.userId,
            provider,
            accountId: lentAccountId,
            enabled: true,
            updatedAt,
          })
          .pipe(Effect.mapError(storageFailure("Could not contribute that account.")));
        yield* sharingRepository
          .upsertGrant({
            ...scope,
            userId: record.requesterUserId,
            provider,
            access: "workspace",
            updatedAt,
          })
          .pipe(
            Effect.mapError(storageFailure("Could not give the requester access to the account.")),
          );
      }

      // Last, so a failure above cannot leave a request reading as granted with
      // nothing behind it. The cost is the reverse: losing the race after both
      // writes leaves this account contributed, which is a switch its owner
      // still holds and the panel still shows.
      const updated = yield* repository
        .updateRequestStatus({
          requestId: record.requestId,
          status: input.decision === "grant" ? "granted" : "declined",
          respondedAt: nowIso(),
          respondedByUserId: actor.userId,
          respondedAccountId: lentAccountId,
        })
        .pipe(Effect.mapError(storageFailure("Could not record the answer to this request.")));
      if (Option.isNone(updated)) {
        return yield* alreadyDecided();
      }

      const requesterName = members.find(
        (member) => member.userId === record.requesterUserId,
      )?.displayName;
      return {
        request: yield* decodeRequest(
          updated.value,
          nonEmpty(requesterName, record.requesterUserId),
        ),
      };
    });

  const withdrawRequest: ProviderUsageServiceShape["withdrawRequest"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: UsageScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      const record = yield* readRequestInScope(input.requestId, scope);

      // No roster read: taking back your own words needs nothing from the
      // workspace, and someone whose membership lapsed must still be able to.
      if (record.requesterUserId !== actor.userId) {
        return yield* new ProviderUsageError({
          code: "forbidden",
          message: "Only the person who asked can withdraw a request.",
        });
      }
      if (record.status !== "pending") {
        return yield* alreadyDecided();
      }

      const updated = yield* repository
        .updateRequestStatus({
          requestId: record.requestId,
          status: "withdrawn",
          respondedAt: nowIso(),
          // Nobody answered, so nobody is named: a withdrawal that recorded the
          // requester here would read as them declining themselves.
          respondedByUserId: null,
          respondedAccountId: null,
        })
        .pipe(Effect.mapError(storageFailure("Could not withdraw this request.")));
      if (Option.isNone(updated)) {
        return yield* alreadyDecided();
      }

      return {
        request: yield* decodeRequest(updated.value, nonEmpty(actor.displayName, actor.userId)),
      };
    });

  return {
    createRequest,
    listRequests,
    respondToRequest,
    withdrawRequest,
  } satisfies ProviderUsageServiceShape;
});

export const ProviderUsageServiceLive: Layer.Layer<
  ProviderUsageService,
  never,
  ProviderUsageRequestRepository | ProviderSharingRepository | CollaborationService | ServerConfig
> = Layer.effect(ProviderUsageService, makeProviderUsageService);
