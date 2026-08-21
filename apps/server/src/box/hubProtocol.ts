/**
 * What a caller that is not the hub puts on the wire to drive a box.
 *
 * The relay's live connections are held in module memory, deliberately, because
 * a socket cannot outlive the process holding it and a table claiming otherwise
 * would be the stale green dot the whole design exists to stop showing. The
 * consequence is that only the hub process can dispatch to a box — so `t3 box`
 * typed at a shell, which is its own process with an empty registry, could never
 * reach one. This file is the seam that closes that: the hub exposes the verbs
 * over HTTP, and everything else keeps working the way it did.
 *
 * The envelope has one definition here for the same reason `boxProtocol.ts` has
 * one for the hub-to-box hop: the two ends are separately deployed builds — a
 * laptop's CLI against a hub somebody else updates — and the only thing keeping
 * them in step is that they read the same file.
 *
 * **What is not in this envelope is the point of it.** There is no actor, no
 * user id and no account anywhere below, and that absence is load-bearing.
 * Everything a box verb decides is scoped to whose box it is, and until now the
 * CLI answered that question with the string `"cli"` — an actor no binding is
 * ever owned by, so every verb reported the box as revoked before it reached the
 * machine. A field here would be the same bug with a longer name, because a
 * caller that states its own identity states whatever it likes. The hub derives
 * it from the session on the request and nothing else, the way
 * `orchestrationDispatchRouteLayer` derives a message's author.
 *
 * @module Box
 */

import { Schema } from "effect";

import { UNIT_VERBS } from "./decideUnitCommand.ts";

/**
 * One route rather than a verb each.
 *
 * `/api/orchestration/dispatch` is the precedent and the argument is the same:
 * the set of verbs is a product decision that moves, and a hub that had to grow
 * a route every time one was added would be a hub that has to be redeployed
 * before a CLI can use a verb it already knows about. The environment id is in
 * the path because it is what the request is *about* — it decides authorisation,
 * which is a property of the resource and not of the payload.
 */
export const BOX_COMMANDS_ROUTE = "/api/boxes/:environmentId/commands";

export const boxCommandsPath = (environmentId: string): string =>
  `/api/boxes/${encodeURIComponent(environmentId)}/commands`;

/**
 * The fields `create` takes, and the reason they are fields rather than a file.
 *
 * A unit body the caller could dictate is arbitrary code as root. `create` takes
 * a program, its arguments, a directory, a port and a description, and the
 * helper on the box generates the unit from its own template — so this schema
 * describes the same five values and never a seventh that happens to be text.
 */
const UnitCreateFieldsSchema = Schema.Struct({
  exec: Schema.String,
  args: Schema.Array(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Int),
  description: Schema.NullOr(Schema.String),
});

/**
 * Every verb, as it travels.
 *
 * Validated on arrival rather than cast, because the hub is now reachable by
 * anything holding a session and a malformed body must be a worded 400 instead
 * of a defect in the middle of a dispatch. Nothing here is validated for
 * *meaning* — whether the port is a port, whether the unit name is one this
 * helper manages, whether the command is empty — because all of that is
 * `decideBoxCommand`'s and the box's, and re-deciding it here would be the third
 * copy of a rule that already has the two it needs.
 */
export const BoxHubRequest = Schema.Union([
  Schema.Struct({
    verb: Schema.Literal("run"),
    command: Schema.String,
    detach: Schema.Boolean,
  }),
  Schema.Struct({ verb: Schema.Literal("services") }),
  Schema.Struct({
    verb: Schema.Literal("stop"),
    target: Schema.String,
    /**
     * `pid:<n>`, and null in the ordinary case. It travels rather than being
     * consumed by the caller: the box applies the same rule from its own facts,
     * because a caller-side check is a convenience and the box is the boundary.
     */
    acknowledgedTarget: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ verb: Schema.Literal("logs"), target: Schema.String }),
  Schema.Struct({
    verb: Schema.Literal("claim-port"),
    port: Schema.Int,
    purpose: Schema.String,
  }),
  Schema.Struct({ verb: Schema.Literal("release-port"), port: Schema.Int }),
  Schema.Struct({
    verb: Schema.Literal("unit"),
    unitVerb: Schema.Literals(UNIT_VERBS),
    name: Schema.String,
    create: Schema.NullOr(UnitCreateFieldsSchema),
  }),
  Schema.Struct({ verb: Schema.Literal("history"), limit: Schema.Int }),
  Schema.Struct({ verb: Schema.Literal("output"), entryId: Schema.String }),
]);

export type BoxHubRequest = typeof BoxHubRequest.Type;

/**
 * What a status code means on this route, in one place both ends read.
 *
 * A refusal is *not* in here, and that is deliberate: "that is somebody else's
 * database" is the system working, so it comes back 200 carrying the refusal
 * the caller would have printed anyway. Reserving the error statuses for things
 * that actually went wrong is what lets the CLI keep printing a refusal in the
 * words the rules chose rather than in the words HTTP chose.
 */
export const BOX_HUB_ERROR_STATUS: Readonly<Record<string, number>> = {
  // Nothing is connected under that name, or it is connected and not well.
  unreachable: 503,
  // The box said no on its own authority. Not a 403: the caller was allowed to
  // ask, and the answer came from the machine.
  refused: 409,
  timeout: 504,
  protocol: 502,
  storage: 503,
  "not-found": 404,
};

/** The body every refusal-that-is-really-a-failure carries. */
export const BoxHubError = Schema.Struct({
  error: Schema.String,
  /** A `BoxCommandError` code, when the failure came from one. */
  code: Schema.optional(Schema.String),
});
