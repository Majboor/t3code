/**
 * The durable record of what an agent did to a box.
 *
 * Separated from the service registry on purpose. The registry answers "what is
 * running here now" and is swept on read, because a claim about the present that
 * outlives its evidence is worse than no claim. The journal answers "what
 * happened here", which does not expire and is not a claim about anything live —
 * a command that ran last Tuesday ran last Tuesday whether or not the machine is
 * on. Folding the two together would force one of them to adopt the other's
 * lifetime, and the loser would be the history.
 *
 * @module Persistence
 */

import { Context, type Option, Schema } from "effect";
import type { Effect } from "effect";

import type { BoxCommandJournalRepositoryError } from "../Errors.ts";

/**
 * How a command ended.
 *
 * `running` is not a transitional value the writer forgot to update. It is the
 * durable state of a detached process: the connection that started it has gone,
 * nothing is waiting on it, and the row stays this way until something confirms
 * an exit. `refused` is the outcome that never reached the machine at all.
 */
export const BoxCommandOutcome = Schema.Literals(["ok", "failed", "refused", "running"]);
export type BoxCommandOutcome = typeof BoxCommandOutcome.Type;

export const BoxCommandEntry = Schema.Struct({
  entryId: Schema.String,
  environmentId: Schema.String,
  userId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  verb: Schema.String,
  command: Schema.NullOr(Schema.String),
  serviceId: Schema.NullOr(Schema.String),
  outcome: BoxCommandOutcome,
  refusalReason: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  /** Evidence that a process was started, never a licence to stop one. */
  pid: Schema.NullOr(Schema.Int),
  /** Whether an override acted on something T3 did not start. */
  unmanaged: Schema.Boolean,
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  /** The true size of the output before it was bounded for storage. */
  outputBytes: Schema.Int,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type BoxCommandEntry = typeof BoxCommandEntry.Type;

export const RecordBoxCommandInput = Schema.Struct({
  entryId: Schema.String,
  environmentId: Schema.String,
  userId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  verb: Schema.String,
  command: Schema.NullOr(Schema.String),
  serviceId: Schema.NullOr(Schema.String),
  outcome: BoxCommandOutcome,
  refusalReason: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  pid: Schema.NullOr(Schema.Int),
  unmanaged: Schema.Boolean,
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  outputBytes: Schema.Int,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type RecordBoxCommandInput = typeof RecordBoxCommandInput.Type;

/**
 * Closing out a row a detached start left open.
 *
 * Scoped by `environmentId` as well as `entryId` so a caller holding an id from
 * one box can never finish a row belonging to another.
 */
export const FinishBoxCommandInput = Schema.Struct({
  entryId: Schema.String,
  environmentId: Schema.String,
  outcome: BoxCommandOutcome,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
  outputBytes: Schema.Int,
  finishedAt: Schema.String,
});
export type FinishBoxCommandInput = typeof FinishBoxCommandInput.Type;

export const ListBoxCommandsInput = Schema.Struct({
  environmentId: Schema.String,
  limit: Schema.Int,
});
export type ListBoxCommandsInput = typeof ListBoxCommandsInput.Type;

export const GetBoxCommandInput = Schema.Struct({
  entryId: Schema.String,
  /**
   * The account asking. Present so a journal id — which travels through an
   * agent's context and into logs — is not on its own enough to read somebody
   * else's command output.
   */
  userId: Schema.String,
});
export type GetBoxCommandInput = typeof GetBoxCommandInput.Type;

export interface BoxCommandJournalRepositoryShape {
  readonly record: (
    input: RecordBoxCommandInput,
  ) => Effect.Effect<BoxCommandEntry, BoxCommandJournalRepositoryError>;
  readonly finish: (
    input: FinishBoxCommandInput,
  ) => Effect.Effect<Option.Option<BoxCommandEntry>, BoxCommandJournalRepositoryError>;
  /** Most recent first. The answer to "what happened here recently". */
  readonly listRecent: (
    input: ListBoxCommandsInput,
  ) => Effect.Effect<ReadonlyArray<BoxCommandEntry>, BoxCommandJournalRepositoryError>;
  /** One entry with its full output: the other half of a truncated reply. */
  readonly get: (
    input: GetBoxCommandInput,
  ) => Effect.Effect<Option.Option<BoxCommandEntry>, BoxCommandJournalRepositoryError>;
  /** Detached starts on this box that nothing has yet seen exit. */
  readonly listUnfinished: (
    input: ListBoxCommandsInput,
  ) => Effect.Effect<ReadonlyArray<BoxCommandEntry>, BoxCommandJournalRepositoryError>;
}

export class BoxCommandJournalRepository extends Context.Service<
  BoxCommandJournalRepository,
  BoxCommandJournalRepositoryShape
>()("t3/persistence/Services/BoxCommandJournal/BoxCommandJournalRepository") {}
