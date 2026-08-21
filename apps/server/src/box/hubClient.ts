/**
 * The box verbs, asked of a hub over HTTP.
 *
 * This is what `t3 box …` is now a thin wrapper over. It is deliberately shaped
 * like `BoxCommandsShape` minus two fields: the environment id, which is fixed
 * when the client is built because it is in the URL, and the actor, which is not
 * here at all. That second absence is the whole point of the file — the actor
 * used to be the literal string `"cli"`, an identity no binding is ever owned
 * by, so every verb typed at a shell was refused as a revoked machine before it
 * reached one. It is now whoever the credential on the request belongs to, which
 * only the hub can say.
 *
 * Replies are shaped rather than parsed, the way `BoxSessionRelay` shapes what
 * comes back from a box. The hub answers with the report types this file's
 * caller already prints, and a hub one version ahead may put a field in one that
 * this build has never heard of; refusing the whole reply over that would turn a
 * successful command into a failed one after the command had already run, which
 * is the worst possible moment to be strict.
 *
 * @module Box
 */

import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import type { UnitCreateFields, UnitVerb } from "./decideUnitCommand.ts";
import { BoxHubError, boxCommandsPath, type BoxHubRequest } from "./hubProtocol.ts";
import {
  BoxCommandError,
  type BoxHistoryReport,
  type BoxLogsReport,
  type BoxOutputReport,
  type BoxPortReport,
  type BoxRefused,
  type BoxRunReport,
  type BoxServicesReport,
  type BoxStopReport,
  type BoxUnitReport,
} from "./Services/BoxCommands.ts";

/**
 * How long the CLI waits on the hub.
 *
 * Matched to `BoxSessionRelay`'s own ceiling rather than to anything about HTTP,
 * because the hub holds this request open for exactly as long as it is waiting
 * on the box: a foreground `t3 box run` is a build or a migration, and a client
 * that gave up at thirty seconds would report a failure for a command that went
 * on to succeed — the one outcome worse than a slow one.
 */
const HUB_REPLY_TIMEOUT_MS = 15 * 60_000;

/** Every verb, with the box and the caller already decided. */
export interface BoxHubCommandsShape {
  readonly run: (input: {
    readonly command: string;
    readonly detach: boolean;
  }) => Effect.Effect<BoxRunReport | BoxRefused, BoxCommandError>;
  readonly services: () => Effect.Effect<BoxServicesReport | BoxRefused, BoxCommandError>;
  readonly stop: (input: {
    readonly target: string;
    readonly acknowledgedTarget: string | null;
  }) => Effect.Effect<BoxStopReport | BoxRefused, BoxCommandError>;
  readonly logs: (input: {
    readonly target: string;
  }) => Effect.Effect<BoxLogsReport | BoxRefused, BoxCommandError>;
  readonly claimPort: (input: {
    readonly port: number;
    readonly purpose: string;
  }) => Effect.Effect<BoxPortReport | BoxRefused, BoxCommandError>;
  readonly releasePort: (input: {
    readonly port: number;
  }) => Effect.Effect<BoxPortReport | BoxRefused, BoxCommandError>;
  readonly unit: (input: {
    readonly verb: UnitVerb;
    readonly name: string;
    readonly create: UnitCreateFields | null;
  }) => Effect.Effect<BoxUnitReport | BoxRefused, BoxCommandError>;
  readonly history: (input: {
    readonly limit: number;
  }) => Effect.Effect<BoxHistoryReport | BoxRefused, BoxCommandError>;
  readonly output: (input: {
    readonly entryId: string;
  }) => Effect.Effect<BoxOutputReport, BoxCommandError>;
}

const BOX_ERROR_CODES = [
  "unreachable",
  "refused",
  "timeout",
  "protocol",
  "storage",
  "not-found",
] as const;

/**
 * Turns a non-2xx into the same `BoxCommandError` an in-process call fails with,
 * so the CLI's own wording and exit behaviour are untouched by the hop.
 *
 * The hub's sentence is preferred over anything invented here: it is the one
 * that knows whether the box was unreachable, whether the machine is not this
 * account's, or whether the journal could not be read. A status with no body to
 * explain it gets a sentence that says what is actually known, which is very
 * little.
 */
const failureFrom = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(BoxHubError)(response).pipe(
    Effect.catch(() =>
      Effect.succeed({
        error: `The hub answered ${response.status} and said nothing about why.`,
        code: undefined,
      }),
    ),
    Effect.flatMap((body) => {
      const code = BOX_ERROR_CODES.find((known) => known === body.code);
      return Effect.fail(
        new BoxCommandError({
          // A 401 or a 404 from the route itself carries no box error code,
          // because nothing reached a box. `unreachable` is the honest reading
          // of every one of those from where the caller stands.
          code: code ?? "unreachable",
          message: body.error,
        }),
      );
    }),
  );

export interface BoxHubTarget {
  /** Where the hub is, as an origin. */
  readonly hubUrl: URL;
  /** A session credential for the account the box belongs to. */
  readonly token: string;
  readonly environmentId: string;
}

/**
 * Builds a client bound to one hub, one credential and one box.
 *
 * The `HttpClient` is taken once here rather than on every call so that the
 * returned methods carry no requirements of their own — the CLI hands them
 * straight to the same handlers that used to hold a `BoxCommands` service, and
 * the swap is invisible above this line.
 */
export const makeBoxHubCommands = Effect.fn("makeBoxHubCommands")(function* (target: BoxHubTarget) {
  const httpClient = yield* HttpClient.HttpClient;
  const url = new URL(boxCommandsPath(target.environmentId), target.hubUrl).toString();

  const send = <A>(body: BoxHubRequest): Effect.Effect<A, BoxCommandError> =>
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(target.token),
      HttpClientRequest.bodyJson(body),
      Effect.flatMap((request) => httpClient.execute(request)),
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (response) => response.json,
          orElse: failureFrom,
        }),
      ),
      Effect.timeoutOrElse({
        duration: `${HUB_REPLY_TIMEOUT_MS} millis`,
        orElse: () =>
          Effect.fail(
            new BoxCommandError({
              code: "timeout",
              message: `The hub did not answer within ${Math.round(HUB_REPLY_TIMEOUT_MS / 60_000)} minutes.`,
            }),
          ),
      }),
      // Everything that is not already one of ours is the hop itself failing —
      // a refused connection, a body that is not JSON, a proxy in the way. From
      // where the caller stands those are all the same fact, and it is one the
      // box verbs already have a word for.
      Effect.catch((cause) =>
        cause._tag === "BoxCommandError"
          ? Effect.fail(cause)
          : Effect.fail(
              new BoxCommandError({
                code: "unreachable",
                message: `Could not reach the hub at ${target.hubUrl.origin}.`,
                cause,
              }),
            ),
      ),
      Effect.map((value) => value as A),
    );

  return {
    run: (input) => send({ verb: "run", command: input.command, detach: input.detach }),
    services: () => send({ verb: "services" }),
    stop: (input) =>
      send({
        verb: "stop",
        target: input.target,
        acknowledgedTarget: input.acknowledgedTarget,
      }),
    logs: (input) => send({ verb: "logs", target: input.target }),
    claimPort: (input) => send({ verb: "claim-port", port: input.port, purpose: input.purpose }),
    releasePort: (input) => send({ verb: "release-port", port: input.port }),
    unit: (input) =>
      send({ verb: "unit", unitVerb: input.verb, name: input.name, create: input.create }),
    history: (input) => send({ verb: "history", limit: input.limit }),
    output: (input) => send({ verb: "output", entryId: input.entryId }),
  } satisfies BoxHubCommandsShape;
});
