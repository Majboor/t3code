import * as Crypto from "node:crypto";

import { DateTime, Effect, Layer, Option } from "effect";

import { BoxCommandJournalRepository } from "../../persistence/Services/BoxCommandJournal.ts";
import type {
  BoxCommandOutcome,
  RecordBoxCommandInput,
} from "../../persistence/Services/BoxCommandJournal.ts";
import {
  BOX_JOURNAL_HEAD_BYTES,
  BOX_JOURNAL_TAIL_BYTES,
  boundCommandOutput,
  decideBoxCommand,
  type BoxRefusal,
  type BoxRequest,
} from "../decideBoxCommand.ts";
import {
  BoxCommandError,
  BoxCommands,
  type BoxCaller,
  type BoxCommandsShape,
  type BoxRefused,
} from "../Services/BoxCommands.ts";
import { BoxSession, type BoxSessionError } from "../Services/BoxSession.ts";

/**
 * How long a foreground command may run before it is given up on.
 *
 * Ten minutes, matching a deploy, because the commands an agent runs on a box
 * are the same commands a deploy runs — an install, a build, a migration — and
 * a budget that killed those mid-write would leave the machine in a state
 * nothing recorded. A process that needs longer than this wants `--detach`,
 * which is not a timeout at all.
 */
const FOREGROUND_TIMEOUT_MS = 10 * 60_000;

function toCommandError(error: BoxSessionError): BoxCommandError {
  return new BoxCommandError({ code: error.code, message: error.message });
}

/** The journal's bound: generous, so "fetch more" has something to fetch. */
const forJournal = (text: string) =>
  boundCommandOutput(text, {
    headBytes: BOX_JOURNAL_HEAD_BYTES,
    tailBytes: BOX_JOURNAL_TAIL_BYTES,
  });

const makeBoxCommands = Effect.gen(function* () {
  const journal = yield* BoxCommandJournalRepository;
  const session = yield* BoxSession;

  const nowIso = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

  /**
   * Writes one journal row and reports storage failures as errors.
   *
   * Deliberately not `catch`-and-continue. A command that ran and was not
   * recorded is the state this whole feature exists to prevent — the next
   * session would rediscover the machine, which is the cost the journal is
   * paying to avoid — so a journal that cannot be written is a reason to stop
   * rather than a reason to log.
   */
  const write = (input: RecordBoxCommandInput) =>
    journal.record(input).pipe(
      Effect.mapError(
        (cause) =>
          new BoxCommandError({
            code: "storage",
            message: "The command journal could not be written.",
            cause,
          }),
      ),
    );

  /**
   * Records a refusal and hands it back as an answer.
   *
   * Every refusal is journalled, including the ones nothing reached the machine
   * for. A refusal is the most interesting row in the table: it is the evidence
   * that an agent tried to stop somebody's database and was stopped, and if the
   * next attempt succeeds with an override it is the only thing that explains
   * why the override was there.
   */
  const refuse = (
    caller: BoxCaller,
    verb: string,
    command: string | null,
    refusal: BoxRefusal,
  ): Effect.Effect<BoxRefused, BoxCommandError> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const entry = yield* write({
        entryId: Crypto.randomUUID(),
        environmentId: caller.environmentId,
        userId: caller.userId,
        turnId: caller.turnId,
        verb,
        command,
        serviceId: null,
        outcome: "refused",
        refusalReason: refusal.reason,
        exitCode: null,
        signal: null,
        pid: null,
        unmanaged: false,
        stdout: null,
        stderr: null,
        outputBytes: 0,
        startedAt: at,
        finishedAt: at,
      });
      return { outcome: "refused", refusal, entryId: entry.entryId } as const;
    });

  /**
   * The guard every verb passes through: read the box, apply the rules, journal
   * a refusal if there is one.
   *
   * `history` is handled by its caller before this runs, because it is the one
   * verb that must work on a box nothing can reach.
   */
  const decide = (caller: BoxCaller, request: BoxRequest) =>
    Effect.gen(function* () {
      const facts = yield* session
        .facts({ environmentId: caller.environmentId, userId: caller.userId })
        .pipe(Effect.mapError(toCommandError));

      // The rules need to know what is running before they can decide anything
      // about a named service — but asking an unreachable box is pointless and
      // slow, so the cheap refusals are taken first on an empty world.
      const needsInspection =
        facts.reachable &&
        !facts.revoked &&
        (request.verb === "stop" || request.verb === "logs" || request.verb === "release-port");

      const inspection = needsInspection
        ? yield* session
            .inspect({ environmentId: caller.environmentId, userId: caller.userId })
            .pipe(Effect.mapError(toCommandError))
        : null;

      return {
        facts,
        inspection,
        decision: decideBoxCommand({
          box: facts,
          request,
          services: inspection?.services ?? [],
          claims: inspection?.claims ?? [],
          actorUserId: caller.userId,
        }),
      };
    });

  const run: BoxCommandsShape["run"] = (input) =>
    Effect.gen(function* () {
      const request: BoxRequest = {
        verb: "run",
        command: input.command,
        detach: input.detach,
      };
      const { decision } = yield* decide(input, request);
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "run", input.command, decision.refusal);
      }
      if (decision.plan.verb !== "run") {
        return yield* new BoxCommandError({
          code: "protocol",
          message: "The run rules returned another verb.",
        });
      }
      const plan = decision.plan;

      const startedAt = yield* nowIso;
      const startedMs = Date.now();
      const result = yield* session
        .exec({
          environmentId: input.environmentId,
          userId: input.userId,
          request: {
            command: plan.command,
            detach: plan.detach,
            timeoutMs: FOREGROUND_TIMEOUT_MS,
          },
        })
        .pipe(Effect.mapError(toCommandError));
      const durationMs = Date.now() - startedMs;
      const finishedAt = yield* nowIso;

      const storedOut = forJournal(result.stdout);
      const storedErr = forJournal(result.stderr);

      // A detached start stays open in the journal: nothing waited for it, so
      // nothing knows when it ended, and writing a finish time would be an
      // invention. That open row is what `t3 box history` uses to say the
      // process is still out there once the connection is gone.
      const outcome: BoxCommandOutcome = plan.detach
        ? "running"
        : result.exitCode === 0 && !result.timedOut
          ? "ok"
          : "failed";

      const entry = yield* write({
        entryId: Crypto.randomUUID(),
        environmentId: input.environmentId,
        userId: input.userId,
        turnId: input.turnId,
        verb: "run",
        command: plan.command,
        serviceId: null,
        outcome,
        refusalReason: null,
        exitCode: result.exitCode,
        signal: result.signal,
        pid: result.pid,
        unmanaged: false,
        stdout: storedOut.text,
        stderr: storedErr.text,
        outputBytes: storedOut.totalBytes + storedErr.totalBytes,
        startedAt,
        finishedAt: plan.detach ? null : finishedAt,
      });

      return {
        outcome: "ran",
        entryId: entry.entryId,
        command: plan.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        detachedPid: plan.detach ? result.pid : null,
        // The tight bound, applied to what the agent actually reads. The journal
        // already has the generous copy, so nothing is lost by cutting hard here.
        stdout: boundCommandOutput(result.stdout),
        stderr: boundCommandOutput(result.stderr),
        durationMs,
      } as const;
    });

  const services: BoxCommandsShape["services"] = (input) =>
    Effect.gen(function* () {
      const { decision } = yield* decide(input, { verb: "services" });
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "services", null, decision.refusal);
      }
      const inspection = yield* session
        .inspect({ environmentId: input.environmentId, userId: input.userId })
        .pipe(Effect.mapError(toCommandError));

      // Deliberately not journalled. Looking changes nothing, and a history full
      // of "the agent looked" would bury the rows that say what it did.
      return {
        outcome: "listed",
        services: inspection.services,
        claims: inspection.claims,
        probe: inspection.probe,
      } as const;
    });

  const stop: BoxCommandsShape["stop"] = (input) =>
    Effect.gen(function* () {
      const request: BoxRequest = {
        verb: "stop",
        target: input.target,
        acknowledgedTarget: input.acknowledgedTarget,
      };
      const { decision } = yield* decide(input, request);
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "stop", input.target, decision.refusal);
      }
      if (decision.plan.verb !== "stop") {
        return yield* new BoxCommandError({
          code: "protocol",
          message: "The stop rules returned another verb.",
        });
      }
      const plan = decision.plan;

      const startedAt = yield* nowIso;
      const signalled = yield* session
        .signal({
          environmentId: input.environmentId,
          userId: input.userId,
          pid: plan.pid,
          signal: "SIGTERM",
        })
        .pipe(Effect.mapError(toCommandError));
      const finishedAt = yield* nowIso;

      const entry = yield* write({
        entryId: Crypto.randomUUID(),
        environmentId: input.environmentId,
        userId: input.userId,
        turnId: input.turnId,
        verb: "stop",
        command: input.target,
        serviceId: plan.service.managedId,
        outcome: signalled ? "ok" : "failed",
        refusalReason: null,
        exitCode: null,
        signal: "SIGTERM",
        pid: plan.pid,
        // The audit line this feature is judged by. An override that left no
        // different mark than an ordinary stop could not answer "who killed the
        // production API", which is the question that gets asked afterwards.
        unmanaged: plan.unmanaged,
        stdout: null,
        stderr: null,
        outputBytes: 0,
        startedAt,
        finishedAt,
      });

      return {
        outcome: "stopped",
        entryId: entry.entryId,
        service: plan.service,
        pid: plan.pid,
        unmanaged: plan.unmanaged,
        signalled,
      } as const;
    });

  const logs: BoxCommandsShape["logs"] = (input) =>
    Effect.gen(function* () {
      const { decision } = yield* decide(input, { verb: "logs", target: input.target });
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "logs", input.target, decision.refusal);
      }
      if (decision.plan.verb !== "logs") {
        return yield* new BoxCommandError({
          code: "protocol",
          message: "The logs rules returned another verb.",
        });
      }
      const plan = decision.plan;

      const text = yield* session
        .readServiceLog({
          environmentId: input.environmentId,
          userId: input.userId,
          managedId: plan.managedId,
        })
        .pipe(Effect.mapError(toCommandError));

      // Reading is not acting, so nothing is journalled — but the same bound
      // applies, because a log tail is exactly the shape of thing that fills a
      // turn's context without anybody deciding it should.
      return { outcome: "logs", service: plan.service, output: boundCommandOutput(text) } as const;
    });

  const claimPort: BoxCommandsShape["claimPort"] = (input) =>
    Effect.gen(function* () {
      const request: BoxRequest = {
        verb: "claim-port",
        port: input.port,
        purpose: input.purpose,
      };
      const { decision } = yield* decide(input, request);
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "claim-port", String(input.port), decision.refusal);
      }

      const claim = yield* session
        .claimPort({
          environmentId: input.environmentId,
          userId: input.userId,
          port: input.port,
          purpose: input.purpose,
        })
        .pipe(Effect.mapError(toCommandError));

      const at = yield* nowIso;
      const entry = yield* write({
        entryId: Crypto.randomUUID(),
        environmentId: input.environmentId,
        userId: input.userId,
        turnId: input.turnId,
        verb: "claim-port",
        command: `port ${input.port}: ${input.purpose}`,
        serviceId: null,
        outcome: claim === null ? "failed" : "ok",
        refusalReason: null,
        exitCode: null,
        signal: null,
        pid: null,
        unmanaged: false,
        stdout: null,
        stderr: null,
        outputBytes: 0,
        startedAt: at,
        finishedAt: at,
      });

      return {
        outcome: "port",
        entryId: entry.entryId,
        port: input.port,
        claim,
        held: claim !== null,
      } as const;
    });

  const releasePort: BoxCommandsShape["releasePort"] = (input) =>
    Effect.gen(function* () {
      const { decision } = yield* decide(input, { verb: "release-port", port: input.port });
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "release-port", String(input.port), decision.refusal);
      }

      const released = yield* session
        .releasePort({
          environmentId: input.environmentId,
          userId: input.userId,
          port: input.port,
        })
        .pipe(Effect.mapError(toCommandError));

      const at = yield* nowIso;
      const entry = yield* write({
        entryId: Crypto.randomUUID(),
        environmentId: input.environmentId,
        userId: input.userId,
        turnId: input.turnId,
        verb: "release-port",
        command: `port ${input.port}`,
        serviceId: null,
        outcome: released ? "ok" : "failed",
        refusalReason: null,
        exitCode: null,
        signal: null,
        pid: null,
        unmanaged: false,
        stdout: null,
        stderr: null,
        outputBytes: 0,
        startedAt: at,
        finishedAt: at,
      });

      return {
        outcome: "port",
        entryId: entry.entryId,
        port: input.port,
        claim: null,
        held: false,
      } as const;
    });

  /**
   * What happened here recently, answered without touching the box.
   *
   * Reachability is not consulted at all — not even to annotate the answer —
   * because this is the verb somebody reaches for when the machine is down, and
   * a history that needed the machine would be unavailable exactly when it was
   * wanted. The revocation check still applies: a machine cut off from the
   * account stops answering questions about itself.
   */
  const history: BoxCommandsShape["history"] = (input) =>
    Effect.gen(function* () {
      const facts = yield* session
        .facts({ environmentId: input.environmentId, userId: input.userId })
        .pipe(Effect.mapError(toCommandError));

      const decision = decideBoxCommand({
        box: facts,
        request: { verb: "history" },
        services: [],
        claims: [],
        actorUserId: input.userId,
      });
      if (decision.outcome === "refuse") {
        return yield* refuse(input, "history", null, decision.refusal);
      }

      const entries = yield* journal
        .listRecent({ environmentId: input.environmentId, limit: input.limit })
        .pipe(
          Effect.mapError(
            (cause) =>
              new BoxCommandError({
                code: "storage",
                message: "The command journal could not be read.",
                cause,
              }),
          ),
        );

      return { outcome: "history", entries } as const;
    });

  const output: BoxCommandsShape["output"] = (input) =>
    Effect.gen(function* () {
      const found = yield* journal.get({ entryId: input.entryId, userId: input.userId }).pipe(
        Effect.mapError(
          (cause) =>
            new BoxCommandError({
              code: "storage",
              message: "The command journal could not be read.",
              cause,
            }),
        ),
      );

      if (Option.isNone(found)) {
        return yield* new BoxCommandError({
          code: "not-found",
          message: `No command here goes by ${input.entryId}.`,
        });
      }

      return { outcome: "output", entry: found.value } as const;
    });

  return {
    run,
    services,
    stop,
    logs,
    claimPort,
    releasePort,
    history,
    output,
  } satisfies BoxCommandsShape;
});

export const BoxCommandsLive: Layer.Layer<
  BoxCommands,
  never,
  BoxCommandJournalRepository | BoxSession
> = Layer.effect(BoxCommands, makeBoxCommands);
