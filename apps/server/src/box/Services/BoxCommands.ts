/**
 * The verbs an agent uses to drive a box, and what each one answers.
 *
 * Every verb returns a **structured** result — an exit code, a bounded slice of
 * the output, and a handle to fetch the rest — rather than a screenful for the
 * agent to parse back into facts. The difference matters most on failure: an
 * agent that has to read "npm ERR!" out of forty kilobytes of progress bars will
 * sometimes read it out of a line that was not an error, and will always spend
 * the context to do it.
 *
 * @module Box
 */

import { Context, Schema } from "effect";
import type { Effect } from "effect";
import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";

import type { BoxCommandEntry } from "../../persistence/Services/BoxCommandJournal.ts";
import type { BoundedOutput, BoxRefusal } from "../decideBoxCommand.ts";
import type { UnitCreateFields, UnitVerb } from "../decideUnitCommand.ts";

/**
 * A refusal that reached the rules and stopped there.
 *
 * Modelled as a value rather than an error because it is an ordinary answer, not
 * a fault: "that is somebody else's database" is the system working. An error
 * channel would invite a `catchAll` that logs and continues, and continuing is
 * exactly what must not happen here.
 */
export interface BoxRefused {
  readonly outcome: "refused";
  readonly refusal: BoxRefusal;
  /** The journal id of the refusal, because a refusal is recorded like anything else. */
  readonly entryId: string;
}

export interface BoxRunReport {
  readonly outcome: "ran";
  /** The journal id, and the handle by which the untruncated output is fetched. */
  readonly entryId: string;
  readonly command: string;
  /** Null when a signal ended it, or when a detached start did not wait. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Set when the process was left running; the pid it can be found by. */
  readonly detachedPid: number | null;
  readonly stdout: BoundedOutput;
  readonly stderr: BoundedOutput;
  readonly durationMs: number;
}

export interface BoxServicesReport {
  readonly outcome: "listed";
  readonly services: ReadonlyArray<EnvironmentService>;
  readonly claims: ReadonlyArray<PortClaim>;
  readonly probe: {
    readonly tool: string;
    readonly processAttribution: boolean;
    readonly limitation: string;
  };
}

export interface BoxStopReport {
  readonly outcome: "stopped";
  readonly entryId: string;
  readonly service: EnvironmentService;
  readonly pid: number;
  /** True when an override ended something T3 had not started. */
  readonly unmanaged: boolean;
  readonly signalled: boolean;
}

export interface BoxLogsReport {
  readonly outcome: "logs";
  readonly service: EnvironmentService;
  readonly output: BoundedOutput;
}

export interface BoxPortReport {
  readonly outcome: "port";
  readonly entryId: string;
  readonly port: number;
  /** Null when a claim was refused by the registry, or when releasing. */
  readonly claim: PortClaim | null;
  readonly held: boolean;
}

/**
 * What the privileged helper did, or would not do.
 *
 * Carries the same shape as everything else here — an exit code, bounded
 * output, a journal id — because from the caller's side this is one more thing
 * that happened on the box. What makes it different is invisible in the type
 * and worth saying out loud: this is the only verb whose work is done by a
 * root-owned binary rather than by the agent's own user, and the only one whose
 * refusals can come back from the machine rather than from the rules here.
 */
export interface BoxUnitReport {
  readonly outcome: "unit";
  readonly entryId: string;
  readonly verb: UnitVerb;
  /** The canonical name, as it was decided and as it was dispatched. */
  readonly name: string;
  readonly exitCode: number | null;
  readonly output: BoundedOutput;
  /**
   * Whether the unit was granted CAP_NET_BIND_SERVICE because it asked for a
   * port below 1024. Surfaced so the CLI can say it: a capability nobody
   * mentions is a capability nobody reviews.
   */
  readonly needsBindCapability: boolean;
}

export interface BoxHistoryReport {
  readonly outcome: "history";
  readonly entries: ReadonlyArray<BoxCommandEntry>;
}

export interface BoxOutputReport {
  readonly outcome: "output";
  readonly entry: BoxCommandEntry;
}

export class BoxCommandError extends Schema.TaggedErrorClass<BoxCommandError>()("BoxCommandError", {
  code: Schema.Literals(["unreachable", "refused", "timeout", "protocol", "storage", "not-found"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Who is asking, and on whose box. Passed on every call so nothing is ambient. */
export interface BoxCaller {
  readonly environmentId: string;
  readonly userId: string;
  /** The turn that asked, when one did. Null for a person at a shell. */
  readonly turnId: string | null;
}

export interface BoxCommandsShape {
  readonly run: (
    input: BoxCaller & { readonly command: string; readonly detach: boolean },
  ) => Effect.Effect<BoxRunReport | BoxRefused, BoxCommandError>;
  readonly services: (
    input: BoxCaller,
  ) => Effect.Effect<BoxServicesReport | BoxRefused, BoxCommandError>;
  readonly stop: (
    input: BoxCaller & {
      readonly target: string;
      /** `pid:<n>`, and only ever supplied deliberately. Null is the normal case. */
      readonly acknowledgedTarget: string | null;
    },
  ) => Effect.Effect<BoxStopReport | BoxRefused, BoxCommandError>;
  readonly logs: (
    input: BoxCaller & { readonly target: string },
  ) => Effect.Effect<BoxLogsReport | BoxRefused, BoxCommandError>;
  readonly claimPort: (
    input: BoxCaller & { readonly port: number; readonly purpose: string },
  ) => Effect.Effect<BoxPortReport | BoxRefused, BoxCommandError>;
  readonly releasePort: (
    input: BoxCaller & { readonly port: number },
  ) => Effect.Effect<BoxPortReport | BoxRefused, BoxCommandError>;
  /**
   * Manage a systemd unit the agent owns, through the box's privileged helper.
   *
   * Everything about which units those are is decided twice — here, so the
   * refusal is fast and worded, and again by the helper on the machine, which
   * is the copy that enforces it. See `decideUnitCommand`.
   */
  readonly unit: (
    input: BoxCaller & {
      readonly verb: UnitVerb;
      readonly name: string;
      /** Only for `create`; null for every other verb. */
      readonly create: UnitCreateFields | null;
    },
  ) => Effect.Effect<BoxUnitReport | BoxRefused, BoxCommandError>;
  /** What happened here recently. The one verb that works on a box that is off. */
  readonly history: (
    input: BoxCaller & { readonly limit: number },
  ) => Effect.Effect<BoxHistoryReport | BoxRefused, BoxCommandError>;
  /** The rest of a truncated reply, by the handle the reply carried. */
  readonly output: (
    input: BoxCaller & { readonly entryId: string },
  ) => Effect.Effect<BoxOutputReport, BoxCommandError>;
}

export class BoxCommands extends Context.Service<BoxCommands, BoxCommandsShape>()(
  "t3/box/Services/BoxCommands",
) {}
