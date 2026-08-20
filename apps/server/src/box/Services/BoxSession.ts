/**
 * The one seam through which a verb reaches a box.
 *
 * Everything above this line — the rules, the journal, the wording — is decided
 * here on the hub, on a machine we control, with a database. Everything below it
 * happens on somebody's VPS at the end of an outbound relay connection. Putting
 * exactly one interface between them means the rules can be tested against a
 * machine that does not exist, which is the only way to test "refuses to kill
 * the production database" without a production database.
 *
 * Deliberately not an Effect RPC contract. The relay is a pipe for opaque
 * payloads on purpose — a hub that parsed RPC would need redeploying every time
 * a laptop's contract changed — so this is an ordinary service interface, and
 * the implementation is what chooses to speak over a relay channel.
 *
 * Nothing here carries a provider credential, and nothing here can. A box runs
 * commands; it never runs a turn. The agent that drives it is somewhere else,
 * holding the person's own provider account, which is why a box must never be
 * asked to connect one of its own — a machine that counted as a workspace would
 * refuse every turn until somebody logged into Claude on a server.
 *
 * @module Box
 */

import { Context, Schema } from "effect";
import type { Effect } from "effect";
import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";

import type { BoxFacts } from "../decideBoxCommand.ts";

/**
 * Why the box could not be reached or would not answer.
 *
 * `unreachable` and `refused` are separate because the dialer must treat them
 * differently: the first is worth retrying and the second never is. `timeout`
 * is its own answer rather than a flavour of failure, since a command that ran
 * and did not finish has probably still changed the machine — reporting it as
 * "did not run" would be the more damaging lie.
 */
export class BoxSessionError extends Schema.TaggedErrorClass<BoxSessionError>()("BoxSessionError", {
  code: Schema.Literals(["unreachable", "refused", "timeout", "protocol"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface BoxExecRequest {
  readonly command: string;
  /**
   * Whether the process should outlive this connection.
   *
   * A detached start returns as soon as the process exists rather than when it
   * exits, and the box keeps it running after the turn ends. That is the whole
   * point of a box — something has to still be serving tomorrow — and it is why
   * the journal records a pid: once the connection is gone, the pid and the
   * journal row are the only things that can find the process again.
   */
  readonly detach: boolean;
  readonly timeoutMs: number;
}

export interface BoxExecOutcome {
  /** Null when a signal ended it, or when a detached start never waited. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The whole stream. Bounding for the reply and for storage happens above. */
  readonly stdout: string;
  readonly stderr: string;
  /** Present for a detached start; the handle by which it is found later. */
  readonly pid: number | null;
  readonly timedOut: boolean;
}

/** What the box says is running on it, already reconciled by the registry. */
export interface BoxInspection {
  readonly services: ReadonlyArray<EnvironmentService>;
  readonly claims: ReadonlyArray<PortClaim>;
  /**
   * How the machine was inspected, carried because it changes how the whole
   * list should be read: from `netstat`, every row is `unknown` and the answer
   * is about ports rather than about processes.
   */
  readonly probe: {
    readonly tool: string;
    readonly processAttribution: boolean;
    readonly limitation: string;
  };
}

export interface BoxTarget {
  readonly environmentId: string;
  readonly userId: string;
}

export interface BoxSessionShape {
  /**
   * Whether this box is this person's, still connected to the account, and
   * reachable right now. Answered from the machine list and the relay's own
   * verdict, never from a socket being open.
   */
  readonly facts: (target: BoxTarget) => Effect.Effect<BoxFacts, BoxSessionError>;
  readonly inspect: (target: BoxTarget) => Effect.Effect<BoxInspection, BoxSessionError>;
  readonly exec: (
    input: BoxTarget & { readonly request: BoxExecRequest },
  ) => Effect.Effect<BoxExecOutcome, BoxSessionError>;
  /**
   * Ends a process by pid.
   *
   * `decideBoxCommand` has already decided this, and this call does not
   * re-decide it *here*. What it does do is carry enough for the box to decide
   * it again over there, which is a different thing: the caller-side rule runs
   * inside the process that is asking, and the box is reached over a relay by
   * whatever happens to be on the other end of it. So the acknowledgement
   * travels rather than being consumed, and the machine that owns the process
   * applies the rule from its own registry — see `decideBoxSignal`.
   *
   * Answers whether the signal was sent. A box that refuses fails the call with
   * `refused`, which is an answer and not a fault.
   */
  readonly signal: (
    input: BoxTarget & {
      readonly pid: number;
      readonly signal: "SIGTERM" | "SIGKILL";
      /** `pid:<n>` when a person deliberately named it; null is the normal case. */
      readonly acknowledgedTarget: string | null;
    },
  ) => Effect.Effect<boolean, BoxSessionError>;
  /** The captured output of something T3 started, by the registry's service id. */
  readonly readServiceLog: (
    input: BoxTarget & { readonly managedId: string },
  ) => Effect.Effect<string, BoxSessionError>;
  readonly claimPort: (
    input: BoxTarget & { readonly port: number; readonly purpose: string },
  ) => Effect.Effect<PortClaim | null, BoxSessionError>;
  readonly releasePort: (
    input: BoxTarget & { readonly port: number },
  ) => Effect.Effect<boolean, BoxSessionError>;
}

export class BoxSession extends Context.Service<BoxSession, BoxSessionShape>()(
  "t3/box/Services/BoxSession",
) {}
