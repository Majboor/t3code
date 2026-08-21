import { Effect, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { AccountMachineRepository } from "../persistence/Services/AccountMachines.ts";
import { EnvironmentRelayBindingRepository } from "../persistence/Services/EnvironmentRelayBindings.ts";
import { BOX_COMMANDS_ROUTE, BOX_HUB_ERROR_STATUS, BoxHubRequest } from "./hubProtocol.ts";
import { BoxCommandError, BoxCommands, type BoxCaller } from "./Services/BoxCommands.ts";

/**
 * Driving a box from somewhere that is not the hub.
 *
 *   person  POST /api/boxes/:environmentId/commands  -> what the box did
 *
 * A relay connection lives in the memory of the process the box dialled into, so
 * the hub is the only place a box command can be dispatched from. Everything
 * else — a `t3 box run` typed at a shell, an agent's shell on some other
 * machine — opens its own process, finds an empty registry and correctly reports
 * that no box is connected under that name. This route is the way in for those
 * callers, and it is the *only* thing it is.
 *
 * **Transport, not authority.** Nothing below decides whether a command may run.
 * `decideBoxCommand` still decides that, from a service list the box reported,
 * and `decideBoxSignal` decides it *again* on the machine from a list the box
 * derived out of its own start records and its own probe — which is the copy
 * that enforces it, because a box is reached over a relay by whatever happens to
 * be on the other end of one. Moving any of that here would replace a boundary
 * held by the machine that owns the process with a boundary held by a hub, and
 * the whole reason the box re-decides is that a hub can be wrong.
 *
 * What this route *does* decide is who may speak to which box at all, which is
 * the hub's own question and nobody else's: the request must carry a session,
 * and the environment must be bound to that session's account. That check is not
 * a duplicate of the box's, it is upstream of it — without it, `history` and
 * `output` would read another account's journal of commands run on their server,
 * since neither of those verbs ever reaches a machine that could refuse.
 *
 * Revocation needs nothing new here and deliberately has nothing new. A revoked
 * session fails `authenticateHttpRequest` and gets a 401, because
 * `SessionCredentialService.verify` refuses one; a revoked *machine* is read
 * through the binding by `BoxSessionRelay.facts` and refused in words by the
 * rules. Both are the hook that already existed, which is the point — an
 * additional revocation path here would be a second thing to remember to cut.
 *
 * @module Box
 */

/**
 * `no-store` because a reply here is the output of a command run on somebody's
 * server, which is the last thing that should sit in a proxy. The rest matches
 * the enrollment and machine routes.
 */
const BOX_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: BOX_HEADERS });

const signInRequired = json({ error: "Sign in to drive a box." }, 401);

/**
 * The same sentence for "no such box" and "not your box", and a 404 for both.
 *
 * The precedent is `accountMachines`, and the reasoning carries over exactly:
 * environment ids are claimed by their machines rather than issued, so a caller
 * who could tell "never existed" from "belongs to someone else" could probe for
 * which names are taken — and learning that a name is real is the first half of
 * caring whose it is. A 403 would answer that question in the status line.
 */
const notFound = json({ error: "This box is not connected to your account." }, 404);

const unavailable = json({ error: "Boxes are not available right now." }, 503);

const malformed = json({ error: "That is not a box command this hub understands." }, 400);

/**
 * `POST /api/boxes/:environmentId/commands`
 *
 * One request, one verb, one answer. A refusal comes back 200 carrying the
 * refusal, because a refusal is an ordinary answer and not a fault — the same
 * reason `BoxRefused` is a value rather than an error channel. The caller prints
 * it in the words the rules chose and exits non-zero on its own.
 */
const boxCommandsRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth
    .authenticateHttpRequest(request)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (session === null) {
    return signInRequired;
  }

  const params = yield* HttpRouter.params;
  const environmentId = params["environmentId"];
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    return notFound;
  }

  const userId = resolveAuthenticatedUserId(session);

  // Read through the binding and then through the machine registry, rather than
  // through a lookup of its own: an environment belongs to *a machine belonging
  // to a user*, which is the identity device enrollment already established, and
  // a second way of answering it here would be a second way to get it wrong.
  const bindings = yield* EnvironmentRelayBindingRepository;
  const binding = yield* bindings.getByEnvironmentId({ environmentId });
  if (Option.isNone(binding) || binding.value.userId !== userId) {
    return notFound;
  }

  const machines = yield* AccountMachineRepository;
  const machine = yield* machines.getForUser({
    machineId: binding.value.machineId,
    userId,
  });
  if (Option.isNone(machine)) {
    return notFound;
  }
  // A *revoked* machine is deliberately not a 404. It is this account's machine
  // and the person asking is entitled to be told what became of it, in the words
  // `decideBoxCommand` uses — "this machine was disconnected from the account",
  // with what to do about it — rather than being told it never existed.

  const command = yield* HttpServerRequest.schemaBodyJson(BoxHubRequest).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  if (command === null) {
    return malformed;
  }

  const commands = yield* BoxCommands;
  // The caller says which box and which verb. It never says who it is: that is
  // read from the session above, so a body claiming an actor is a body with a
  // field nothing looks at.
  const caller: BoxCaller = { environmentId, userId, turnId: null };

  const dispatched = ((): Effect.Effect<unknown, BoxCommandError> => {
    switch (command.verb) {
      case "run":
        return commands.run({ ...caller, command: command.command, detach: command.detach });
      case "services":
        return commands.services(caller);
      case "stop":
        return commands.stop({
          ...caller,
          target: command.target,
          acknowledgedTarget: command.acknowledgedTarget,
        });
      case "logs":
        return commands.logs({ ...caller, target: command.target });
      case "claim-port":
        return commands.claimPort({ ...caller, port: command.port, purpose: command.purpose });
      case "release-port":
        return commands.releasePort({ ...caller, port: command.port });
      case "unit":
        return commands.unit({
          ...caller,
          verb: command.unitVerb,
          name: command.name,
          create: command.create,
        });
      case "history":
        return commands.history({ ...caller, limit: command.limit });
      case "output":
        return commands.output({ ...caller, entryId: command.entryId });
    }
  })();

  return yield* dispatched.pipe(
    Effect.map((value) => json(value, 200)),
    Effect.catchTag("BoxCommandError", (error) =>
      Effect.succeed(
        json({ error: error.message, code: error.code }, BOX_HUB_ERROR_STATUS[error.code] ?? 503),
      ),
    ),
  );
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

export const boxCommandsRouteLayer = HttpRouter.add("POST", BOX_COMMANDS_ROUTE, boxCommandsRoute);
