/**
 * Authenticated notebook execution endpoints. Same guard as every other
 * `/api/*` read (`authenticateHttpRequest`): a caller runs cells only in a
 * project directory, under their own kernel, once the session says who they
 * are. Kept as HTTP rather than an RPC because it drives long-lived kernel
 * processes (see `kernelManager.ts`) that must outlive any one socket.
 */
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { executeCell, restartKernel } from "./kernelManager.ts";

export const NOTEBOOK_EXECUTE_PATH = "/api/notebook/execute";
export const NOTEBOOK_RESTART_PATH = "/api/notebook/restart";

const ExecuteBody = Schema.Struct({
  kernelId: Schema.String,
  cwd: Schema.String,
  code: Schema.String,
});
const RestartBody = Schema.Struct({
  kernelId: Schema.String,
});

/** A user's own namespace, so two people's kernels never share state. */
function scopedKernelId(userKey: string, kernelId: string): string {
  return `${userKey}::${kernelId}`;
}

function isSafeCwd(cwd: string): boolean {
  return cwd.startsWith("/") && !cwd.includes("\0") && !cwd.split("/").includes("..");
}

export const notebookExecuteRouteLayer = HttpRouter.add(
  "POST",
  NOTEBOOK_EXECUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const userKey = session.userId ?? session.subject;
    const body = yield* HttpServerRequest.schemaBodyJson(ExecuteBody).pipe(
      Effect.mapError(() => "bad-body" as const),
      Effect.option,
    );
    if (Option.isNone(body)) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid request body." }, { status: 400 });
    }
    const { kernelId, cwd, code } = body.value;
    if (!kernelId || !isSafeCwd(cwd)) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid kernel id or working directory." }, { status: 400 });
    }
    const result = yield* Effect.tryPromise({
      try: () => executeCell(scopedKernelId(userKey, kernelId), cwd, code),
      catch: (cause) => (cause instanceof Error ? cause.message : "Kernel execution failed."),
    }).pipe(Effect.option);
    if (Option.isNone(result)) {
      return HttpServerResponse.jsonUnsafe({ error: "Kernel execution failed." }, { status: 500 });
    }
    return HttpServerResponse.jsonUnsafe(
      { executionCount: result.value.executionCount, outputs: result.value.outputs },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const notebookRestartRouteLayer = HttpRouter.add(
  "POST",
  NOTEBOOK_RESTART_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const userKey = session.userId ?? session.subject;
    const body = yield* HttpServerRequest.schemaBodyJson(RestartBody).pipe(Effect.option);
    if (Option.isNone(body) || !body.value.kernelId) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid kernel id." }, { status: 400 });
    }
    restartKernel(scopedKernelId(userKey, body.value.kernelId));
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
