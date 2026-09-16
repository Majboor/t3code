import {
  ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { makeFixedWindowLimiter } from "../deviceEnrollment/rateLimit.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The full snapshot can run to tens of MB (see the activity-history cap in
 * ProjectionSnapshotQuery). A caller that re-fetches it on a tight loop — a
 * stray monitoring script did exactly this in 2026-09, polling every
 * ~15-20s and saturating a whole connection around the clock — should be
 * throttled rather than served every time. One call per session per window
 * is generous for the real use (a human or a CLI invocation checking in
 * occasionally) and cuts a runaway poller's bandwidth by an order of
 * magnitude.
 */
const snapshotRateLimiter = makeFixedWindowLimiter({ windowMs: 60_000, maxAttempts: 3 });

const respondToOrchestrationHttpError = (
  error: OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
) =>
  Effect.gen(function* () {
    if (error._tag === "OrchestrationGetSnapshotError") {
      yield* Effect.logError("orchestration http route failed", {
        message: error.message,
        cause: error.cause,
      });
      return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
    }

    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });
  });

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new OrchestrationDispatchCommandError({
      message: "Only owner sessions can manage projects.",
    });
  }
  return session;
});

export const orchestrationSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/snapshot",
  Effect.gen(function* () {
    const session = yield* authenticateOwnerSession;
    if (!snapshotRateLimiter.check(session.sessionId, Date.now())) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Too many snapshot requests. Wait before fetching the full snapshot again." },
        { status: 429 },
      );
    }
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationReadModel, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("OrchestrationDispatchCommandError", respondToOrchestrationHttpError),
    Effect.catchTag("OrchestrationGetSnapshotError", respondToOrchestrationHttpError),
  ),
);

export const orchestrationDispatchRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/dispatch",
  Effect.gen(function* () {
    const session = yield* authenticateOwnerSession;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const command = yield* HttpServerRequest.schemaBodyJson(ClientOrchestrationCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Invalid orchestration command payload.",
            cause,
          }),
      ),
    );
    const normalizedCommand = yield* normalizeDispatchCommand(command);
    // Same rule as the socket: the author comes from the session, never from
    // the body. Without this the messages sent over this route would be the
    // only ones in a transcript that nobody was recorded as writing.
    const commandForDispatch: typeof normalizedCommand =
      normalizedCommand.type === "thread.turn.start"
        ? {
            ...normalizedCommand,
            message: {
              ...normalizedCommand.message,
              authorUserId: resolveAuthenticatedUserId(session),
            },
          }
        : normalizedCommand;
    const result = yield* orchestrationEngine.dispatch(commandForDispatch).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to dispatch orchestration command.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("OrchestrationDispatchCommandError", respondToOrchestrationHttpError)),
);
