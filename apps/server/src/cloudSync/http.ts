import { ProjectId, TenantId, WorkspaceId } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { AuthError, resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import {
  blobStatus,
  blobStoreRoot,
  finalizeBlob,
  isCloudSyncHash,
  missingBlobs,
  readBlob,
  writeBlobChunk,
} from "./blobStore.ts";
import { CloudSyncService, type CloudSyncActor } from "./Services/CloudSyncService.ts";

/**
 * The content transport for cloud sync: the half of the feature that moves
 * bytes, beside the six RPCs that move decisions.
 *
 * HTTP and not RPC over the WebSocket, on purpose. A first pass over a large
 * tree is a long series of large bodies, and putting those through the socket
 * that also carries every orchestration event would mean a monorepo's first
 * sync stalling the UI that is reporting its progress. HTTP also brings the two
 * things this needs for nothing: a request that can be retried without anybody
 * replaying a stream, and a body that is just bytes.
 *
 * Everything here is content-addressed. The laptop asks which hashes the server
 * is missing, sends only those, and fetches what it lacks the same way — which
 * is why a re-share of a mostly-unchanged tree moves almost nothing. That is
 * the spec's requirement, not an optimisation.
 *
 * Nothing here decides anything. Membership, reconciliation and the deletion
 * guard belong to `CloudSyncService`; these routes carry bytes, and refuse to
 * carry the wrong ones.
 */

export const CLOUD_SYNC_ROUTE_PREFIX = "/api/cloud-sync";

/**
 * How much of one blob a single request may carry.
 *
 * The point of chunking is that a dropped connection costs a chunk rather than
 * a gigabyte, so this is the unit of loss as much as the unit of transfer.
 * Eight megabytes is a second or two on a domestic uplink: small enough that
 * re-sending one is unremarkable, large enough that a big file is hundreds of
 * requests and not hundreds of thousands.
 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** A negotiation is a list of hashes; this bounds how long a list may be. */
const MAX_NEGOTIATED_HASHES = 5_000;

/** And this bounds a manifest, which carries a path per entry as well as a hash. */
const MAX_MANIFEST_ENTRIES = 20_000;

/**
 * A blob is bytes somebody else wrote, served back over this product's own
 * origin. `nosniff` and a sandbox CSP are what stop a synced `index.html`
 * becoming stored XSS against every signed-in person who fetches it, and
 * `no-store` keeps a private file out of every cache between here and there.
 */
const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

const ProjectScopeFields = {
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
};

const EntryFields = {
  path: Schema.String.check(Schema.isNonEmpty()),
  hash: Schema.String.check(Schema.isNonEmpty()),
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

const NegotiateBody = Schema.Struct({
  ...ProjectScopeFields,
  hashes: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_NEGOTIATED_HASHES)),
});

const PassBody = Schema.Struct({
  ...ProjectScopeFields,
  files: Schema.Array(Schema.Struct(EntryFields)).check(Schema.isMaxLength(MAX_MANIFEST_ENTRIES)),
  scanComplete: Schema.Boolean,
});

const CommitBody = Schema.Struct({
  ...ProjectScopeFields,
  files: Schema.Array(Schema.Struct(EntryFields)).check(Schema.isMaxLength(MAX_MANIFEST_ENTRIES)),
  deletions: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_MANIFEST_ENTRIES)),
  conflicts: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isNonEmpty()),
      conflictedCopyPath: Schema.String,
      remote: Schema.Struct(EntryFields),
    }),
  ).check(Schema.isMaxLength(MAX_MANIFEST_ENTRIES)),
  final: Schema.Boolean,
});

const decodeNegotiate = Schema.decodeUnknownEffect(NegotiateBody);
const decodePass = Schema.decodeUnknownEffect(PassBody);
const decodeCommit = Schema.decodeUnknownEffect(CommitBody);

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.jsonUnsafe(body, { status, headers: SAFETY_HEADERS });
}

function badRequest(message: string) {
  return jsonResponse({ error: message }, 400);
}

/**
 * The service's product outcomes become statuses a client can act on.
 *
 * `forbidden` and `not-found` stay distinguishable here, unlike on the public
 * share-link route: this caller has already proved who they are, so collapsing
 * the two would only stop them noticing a mistyped project id.
 */
function statusForCode(code: string): number {
  switch (code) {
    case "forbidden": {
      return 403;
    }
    case "not-found":
    case "conflict-not-found": {
      return 404;
    }
    case "mode-locked": {
      return 409;
    }
    default: {
      return 503;
    }
  }
}

/**
 * Every route here answers to a session, and the actor is built from that
 * session and never from the body — otherwise "sync this project as that
 * person" would be a claim anyone could make.
 */
const currentActor = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  const fallback: CloudSyncActor = {
    userId: resolveAuthenticatedUserId(session),
    displayName: session.subject.trim() || "Authenticated user",
  };
  return yield* serverAuth.resolveUserProfile(session).pipe(
    Effect.map(
      (profile): CloudSyncActor => ({
        userId: profile.userId,
        displayName: profile.displayName,
        avatarInitials: profile.avatarInitials,
      }),
    ),
    // A profile the auth layer cannot expand is no reason to refuse a sync: the
    // session already proved who this is, and the name is only ever used beside
    // an id comparison that does the actual work.
    Effect.catchTag("AuthError", () => Effect.succeed(fallback)),
  );
});

/**
 * The hash out of the path, left exactly as it arrived.
 *
 * No percent-decoding: a hash is 64 hex characters and survives a URL
 * untouched, so decoding would buy nothing and would insert a transformation of
 * an attacker-controlled string between the URL and a filename.
 */
export function hashFromPath(pathname: string): string | null {
  const prefix = `${CLOUD_SYNC_ROUTE_PREFIX}/blobs/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const candidate = pathname.slice(prefix.length).split("/")[0] ?? "";
  return isCloudSyncHash(candidate) ? candidate : null;
}

export interface BlobScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
}

/**
 * The blob routes carry their scope in the query, because their body is bytes.
 * None of the three grants anything on its own — the service checks the roster
 * — so they are taken as written and proved a line later.
 */
export function scopeFromQuery(url: URL): BlobScope | null {
  const tenantId = url.searchParams.get("tenantId")?.trim();
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  const projectId = url.searchParams.get("projectId")?.trim();
  if (!tenantId || !workspaceId || !projectId) {
    return null;
  }
  return {
    tenantId: TenantId.make(tenantId),
    workspaceId: WorkspaceId.make(workspaceId),
    projectId: ProjectId.make(projectId),
  };
}

/**
 * `POST /api/cloud-sync/negotiate` — which of these do you already have.
 *
 * The one call in the exchange allowed to be chatty, because it is what stops
 * everything after it being: a laptop re-sharing yesterday's tree learns in one
 * round trip that it has nothing to send.
 */
const negotiateRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const actor = yield* currentActor;
  const cloudSync = yield* CloudSyncService;
  const config = yield* ServerConfig;

  const body = yield* decodeNegotiate(yield* request.json);
  yield* cloudSync.requireProjectAccess(actor, body);

  // A hash that is not one is refused rather than looked up. It becomes a
  // filename a moment later, and a caller who can choose that filename can
  // choose a path.
  const malformed = body.hashes.filter((hash) => !isCloudSyncHash(hash));
  const wellFormed = body.hashes.filter((hash) => isCloudSyncHash(hash));
  const root = blobStoreRoot(config.stateDir, body.projectId);
  const missing = yield* Effect.promise(() => missingBlobs(root, wellFormed));

  return jsonResponse(
    { missing, refused: malformed.map((hash) => ({ hash, reason: "malformed-hash" })) },
    200,
  );
});

/**
 * `GET /api/cloud-sync/blobs/<hash>?…&probe=1` — how much of this the server
 * already has, so a resumed upload knows where to start. Without `probe`, the
 * bytes themselves.
 *
 * One route rather than two, because both answer "what do you have under this
 * hash", and a client just told a blob is missing should not have to learn a
 * second URL to send it.
 */
const blobRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return badRequest("This request could not be understood.");
  }
  const hash = hashFromPath(url.value.pathname);
  if (hash === null) {
    return badRequest("That is not a content hash.");
  }
  const scope = scopeFromQuery(url.value);
  if (scope === null) {
    return badRequest("A tenant, workspace and project are required.");
  }

  const actor = yield* currentActor;
  const cloudSync = yield* CloudSyncService;
  const config = yield* ServerConfig;
  yield* cloudSync.requireProjectAccess(actor, scope);

  const root = blobStoreRoot(config.stateDir, scope.projectId);
  if (url.value.searchParams.get("probe") !== null) {
    return jsonResponse(yield* Effect.promise(() => blobStatus(root, hash)), 200);
  }

  const bytes = yield* Effect.promise(() => readBlob(root, hash));
  if (bytes === null) {
    return jsonResponse({ error: "The server does not have that content." }, 404);
  }
  // Always `application/octet-stream`, whatever the file is called. Choosing a
  // content type from a path somebody else picked, on this product's own
  // origin, is how a synced `.html` becomes script running as whoever fetched
  // it.
  return HttpServerResponse.uint8Array(bytes, {
    status: 200,
    contentType: "application/octet-stream",
    headers: SAFETY_HEADERS,
  });
});

/**
 * `POST /api/cloud-sync/blobs/<hash>?…&offset=<n>&final=1` — one chunk.
 *
 * Idempotent by construction: the offset is the client's, so a chunk re-sent
 * after a dropped connection lands on exactly the bytes it landed on before.
 * `final=1` asks the server to verify and publish, and content that does not
 * hash to the name it was sent under is destroyed and reported rather than
 * stored — the name is the only thing any later pass compares it against, so a
 * blob filed under the wrong one would be handed out for years as content it is
 * not.
 */
const uploadRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return badRequest("This request could not be understood.");
  }
  const hash = hashFromPath(url.value.pathname);
  if (hash === null) {
    return badRequest("That is not a content hash.");
  }
  const scope = scopeFromQuery(url.value);
  if (scope === null) {
    return badRequest("A tenant, workspace and project are required.");
  }
  const offset = Number(url.value.searchParams.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return badRequest("An offset must be a whole number of bytes.");
  }

  const actor = yield* currentActor;
  const cloudSync = yield* CloudSyncService;
  const config = yield* ServerConfig;
  yield* cloudSync.requireProjectAccess(actor, scope);

  const buffer = yield* request.arrayBuffer;
  if (buffer.byteLength > MAX_CHUNK_BYTES) {
    return jsonResponse(
      { error: `A chunk may be at most ${MAX_CHUNK_BYTES} bytes.`, maxChunkBytes: MAX_CHUNK_BYTES },
      413,
    );
  }

  const root = blobStoreRoot(config.stateDir, scope.projectId);
  const outcome = yield* Effect.promise(() =>
    writeBlobChunk(root, hash, offset, new Uint8Array(buffer)),
  );
  if (outcome.kind === "gap") {
    // Writing past the end would leave a hole of bytes nobody chose, and the
    // blob would then fail its hash check for a reason that looks like
    // corruption. Saying where to resume from is the useful answer.
    return jsonResponse(
      {
        error: "That chunk starts past the end of what has been received.",
        resumeAt: outcome.received,
      },
      409,
    );
  }

  if (url.value.searchParams.get("final") === null) {
    return jsonResponse({ hash, received: outcome.received, stored: false }, 202);
  }

  const finalized = yield* Effect.promise(() => finalizeBlob(root, hash));
  if (finalized.kind === "hash-mismatch") {
    return jsonResponse(
      {
        error: "The uploaded content does not match the hash it was sent under.",
        expected: hash,
        actual: finalized.actualHash,
      },
      422,
    );
  }
  if (finalized.kind === "missing") {
    return jsonResponse({ error: "There is nothing staged under that hash." }, 404);
  }
  return jsonResponse({ hash, received: finalized.sizeBytes, stored: true }, 201);
});

/**
 * `POST /api/cloud-sync/pass` — hand over the local scan, get back what has to
 * move, or a refusal.
 *
 * A refusal is a 409 carrying the numbers behind it, never a 500. The most
 * likely reason a pass is refused is that the scan behind it did not finish,
 * and that is something a person can act on — but only if they are told how
 * many files the server knows about rather than "sync failed".
 */
const passRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const actor = yield* currentActor;
  const cloudSync = yield* CloudSyncService;

  const body = yield* decodePass(yield* request.json);
  const result = yield* cloudSync.planPass(actor, body);

  return jsonResponse(result, result.outcome === "planned" ? 200 : 409);
});

/**
 * `POST /api/cloud-sync/commit` — publish what both sides now agree on.
 *
 * Content comes out of the store by hash and never out of this body, so a path
 * appears in the cloud copy holding exactly the bytes that were verified under
 * that name. Anything whose bytes are missing, whose path is excluded, or that
 * the server never agreed existed comes back in `refused` rather than being
 * quietly skipped.
 */
const commitRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const actor = yield* currentActor;
  const cloudSync = yield* CloudSyncService;

  const body = yield* decodeCommit(yield* request.json);
  return jsonResponse(yield* cloudSync.commitPass(actor, body), 200);
});

/**
 * One place every failure lands, so no route can invent its own.
 *
 * A `CloudSyncError` carries a code the client can branch on and a message a
 * person can read; an `AuthError` carries its own status; everything else —
 * a malformed body, an unparseable URL, a defect underneath — is a 400 with one
 * wording, because a stack trace on an authenticated route is still a stack
 * trace on the internet.
 */
const route = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  effect.pipe(
    Effect.catch((error) => {
      if (error instanceof AuthError) {
        return Effect.succeed(jsonResponse({ error: error.message }, error.status ?? 500));
      }
      const failure = error as { readonly code?: unknown; readonly message?: unknown };
      return typeof failure.code === "string"
        ? Effect.succeed(
            jsonResponse(
              {
                error:
                  typeof failure.message === "string"
                    ? failure.message
                    : "This sync could not be reached.",
                code: failure.code,
              },
              statusForCode(failure.code),
            ),
          )
        : Effect.succeed(badRequest("This request could not be understood."));
    }),
    Effect.catchDefect(() => Effect.succeed(badRequest("This request could not be understood."))),
  );

export const cloudSyncNegotiateRouteLayer = HttpRouter.add(
  "POST",
  `${CLOUD_SYNC_ROUTE_PREFIX}/negotiate`,
  route(negotiateRoute),
);

export const cloudSyncBlobDownloadRouteLayer = HttpRouter.add(
  "GET",
  `${CLOUD_SYNC_ROUTE_PREFIX}/blobs/*`,
  route(blobRoute),
);

export const cloudSyncBlobUploadRouteLayer = HttpRouter.add(
  "POST",
  `${CLOUD_SYNC_ROUTE_PREFIX}/blobs/*`,
  route(uploadRoute),
);

export const cloudSyncPassRouteLayer = HttpRouter.add(
  "POST",
  `${CLOUD_SYNC_ROUTE_PREFIX}/pass`,
  route(passRoute),
);

export const cloudSyncCommitRouteLayer = HttpRouter.add(
  "POST",
  `${CLOUD_SYNC_ROUTE_PREFIX}/commit`,
  route(commitRoute),
);
