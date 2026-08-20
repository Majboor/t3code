/**
 * Reaching a box over the outbound relay.
 *
 * The relay carries opaque payloads by design — the hub is a pipe, not a
 * participant, so that a contract change on somebody's laptop does not require
 * redeploying the hub. This file is therefore where the *box protocol* is
 * defined: a small request/response envelope that rides inside those payloads
 * and that the agent running on the box answers.
 *
 * One channel per request, closed on the reply. The relay already multiplexes,
 * so building a second correlation scheme on top of it would be two id spaces to
 * keep straight for no gain — and a mis-correlated reply here would deliver one
 * command's output as another's, which on a `stop` is unthinkable.
 *
 * The wire format itself lives in `boxProtocol.ts`, which the box's responder
 * reads too. The two ends are separately deployed machines talking through a hub
 * that cannot see into the payload, so the only thing keeping them in step is
 * that the envelope has exactly one definition.
 *
 * @module Box
 */

import { Effect, Layer, Option } from "effect";
import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";

import {
  openRelayChannel,
  relayLinkFor,
  type RelayChannel,
} from "../../environmentRelay/registry.ts";
import { AccountMachineRepository } from "../../persistence/Services/AccountMachines.ts";
import { EnvironmentRelayBindingRepository } from "../../persistence/Services/EnvironmentRelayBindings.ts";
import { encodeBoxRequest, type BoxRpcMethod } from "../boxProtocol.ts";
import type { BoxFacts } from "../decideBoxCommand.ts";
import {
  BoxSession,
  BoxSessionError,
  type BoxExecOutcome,
  type BoxInspection,
  type BoxSessionShape,
  type BoxTarget,
} from "../Services/BoxSession.ts";

/** How long to wait for a reply before deciding nothing is coming. */
const REPLY_TIMEOUT_MS = 15 * 60_000;

/**
 * Sends one request down a fresh channel and resolves on the first reply.
 *
 * Interruption closes the channel, which is what tells the box to stop caring
 * about a reply nobody will read. Without that a cancelled turn leaves the
 * command running and the channel open until the connection drops.
 */
const call = (
  target: BoxTarget,
  method: BoxRpcMethod,
  params: Record<string, unknown>,
  timeoutMs: number,
): Effect.Effect<unknown, BoxSessionError> =>
  Effect.callback<unknown, BoxSessionError>((resume) => {
    let channel: RelayChannel | null = null;
    let settled = false;

    const finish = (outcome: Effect.Effect<unknown, BoxSessionError>) => {
      if (settled) return;
      settled = true;
      channel?.close(null);
      resume(outcome);
    };

    const opened = openRelayChannel({
      environmentId: target.environmentId,
      userId: target.userId,
      nowMs: Date.now(),
      sink: {
        onData: (payload) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            finish(
              Effect.fail(
                new BoxSessionError({
                  code: "protocol",
                  message: "The box sent a reply that was not JSON.",
                }),
              ),
            );
            return;
          }
          if (typeof parsed !== "object" || parsed === null) {
            finish(
              Effect.fail(
                new BoxSessionError({ code: "protocol", message: "The box sent an empty reply." }),
              ),
            );
            return;
          }
          const reply = parsed as { readonly error?: unknown; readonly result?: unknown };
          if (typeof reply.error === "string") {
            finish(Effect.fail(new BoxSessionError({ code: "refused", message: reply.error })));
            return;
          }
          finish(Effect.succeed(reply.result));
        },
        onClose: (reason) =>
          finish(
            Effect.fail(
              new BoxSessionError({
                code: "unreachable",
                message: reason ?? "The box closed the channel before replying.",
              }),
            ),
          ),
      },
    });

    if (opened.outcome === "refused") {
      // "not-yours" and "not-connected" are flattened here on purpose: the
      // distinction is useful inside the process and is an invitation to probe
      // for other people's environment names outside it.
      resume(
        Effect.fail(
          new BoxSessionError({
            code: opened.reason === "not-healthy" ? "unreachable" : "unreachable",
            message:
              opened.reason === "not-healthy"
                ? "The box is connected but not in a state to accept work."
                : "No box is connected under that name.",
          }),
        ),
      );
      return Effect.void;
    }

    channel = opened.channel;
    channel.send(encodeBoxRequest({ method, actorUserId: target.userId, params }));

    return Effect.sync(() => {
      settled = true;
      channel?.close("cancelled");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${timeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new BoxSessionError({
            code: "timeout",
            message: `The box did not answer within ${Math.round(timeoutMs / 1_000)}s.`,
          }),
        ),
    }),
  );

const makeBoxSessionRelay = Effect.gen(function* () {
  const bindings = yield* EnvironmentRelayBindingRepository;
  const machines = yield* AccountMachineRepository;

  /**
   * Who this box is, and whether it may be used.
   *
   * Revocation is read from `account_machines` through the binding rather than
   * from a flag of its own. That is one hop and no second switch: disconnecting
   * a machine in the browser stops these verbs immediately, because the machine
   * row is the only place that answers the question.
   */
  const facts: BoxSessionShape["facts"] = (target) =>
    Effect.gen(function* () {
      const binding = yield* bindings
        .getByEnvironmentId({ environmentId: target.environmentId })
        .pipe(
          Effect.mapError(
            () =>
              new BoxSessionError({
                code: "unreachable",
                message: "The box registry could not be read.",
              }),
          ),
        );

      if (Option.isNone(binding) || binding.value.userId !== target.userId) {
        // An unknown name and somebody else's name get the same answer, so this
        // cannot be used to enumerate other accounts' boxes.
        return {
          machineId: "",
          revoked: true,
          reachable: false,
        } satisfies BoxFacts;
      }

      const machine = yield* machines
        .getForUser({ machineId: binding.value.machineId, userId: target.userId })
        .pipe(
          Effect.mapError(
            () =>
              new BoxSessionError({
                code: "unreachable",
                message: "The machine list could not be read.",
              }),
          ),
        );

      const revoked = Option.isNone(machine) || machine.value.revokedAt !== null;
      const link = relayLinkFor(target.environmentId, Date.now());

      return {
        machineId: binding.value.machineId,
        revoked,
        // The relay's own verdict, which is a recent exchange plus a self-report
        // and never merely an open socket.
        reachable: !revoked && link !== null && link.verdict.acceptsTraffic,
      } satisfies BoxFacts;
    });

  const inspect: BoxSessionShape["inspect"] = (target) =>
    call(target, "inspect", {}, 30_000).pipe(
      Effect.flatMap((result) => {
        const shaped = result as Partial<BoxInspection> | null;
        if (!shaped || !Array.isArray(shaped.services)) {
          return Effect.fail(
            new BoxSessionError({
              code: "protocol",
              message: "The box did not report what is running on it.",
            }),
          );
        }
        return Effect.succeed({
          services: shaped.services as ReadonlyArray<EnvironmentService>,
          claims: (shaped.claims ?? []) as ReadonlyArray<PortClaim>,
          probe: shaped.probe ?? { tool: "none", processAttribution: false, limitation: "" },
        } satisfies BoxInspection);
      }),
    );

  const exec: BoxSessionShape["exec"] = (input) =>
    call(
      input,
      "exec",
      {
        command: input.request.command,
        detach: input.request.detach,
        timeoutMs: input.request.timeoutMs,
      },
      // A detached start answers as soon as the process exists, so it needs no
      // room for the command itself; a foreground one needs the whole budget
      // plus a little for the reply to travel.
      input.request.detach ? 30_000 : Math.min(input.request.timeoutMs + 30_000, REPLY_TIMEOUT_MS),
    ).pipe(
      Effect.map((result) => {
        const shaped = (result ?? {}) as Partial<BoxExecOutcome>;
        return {
          exitCode: typeof shaped.exitCode === "number" ? shaped.exitCode : null,
          signal: typeof shaped.signal === "string" ? shaped.signal : null,
          stdout: typeof shaped.stdout === "string" ? shaped.stdout : "",
          stderr: typeof shaped.stderr === "string" ? shaped.stderr : "",
          pid: typeof shaped.pid === "number" ? shaped.pid : null,
          timedOut: shaped.timedOut === true,
        } satisfies BoxExecOutcome;
      }),
    );

  const signal: BoxSessionShape["signal"] = (input) =>
    call(
      input,
      "signal",
      {
        pid: input.pid,
        signal: input.signal,
        acknowledgedTarget: input.acknowledgedTarget,
      },
      30_000,
    ).pipe(
      Effect.map(
        (result) => (result as { readonly signalled?: boolean } | null)?.signalled === true,
      ),
    );

  const readServiceLog: BoxSessionShape["readServiceLog"] = (input) =>
    call(input, "readServiceLog", { managedId: input.managedId }, 60_000).pipe(
      Effect.map((result) => {
        const text = (result as { readonly text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      }),
    );

  const claimPort: BoxSessionShape["claimPort"] = (input) =>
    call(input, "claimPort", { port: input.port, purpose: input.purpose }, 30_000).pipe(
      Effect.map((result) => {
        const claim = (result as { readonly claim?: unknown } | null)?.claim;
        return claim === null || claim === undefined ? null : (claim as PortClaim);
      }),
    );

  const releasePort: BoxSessionShape["releasePort"] = (input) =>
    call(input, "releasePort", { port: input.port }, 30_000).pipe(
      Effect.map((result) => (result as { readonly released?: boolean } | null)?.released === true),
    );

  return {
    facts,
    inspect,
    exec,
    signal,
    readServiceLog,
    claimPort,
    releasePort,
  } satisfies BoxSessionShape;
});

export const BoxSessionRelayLive: Layer.Layer<
  BoxSession,
  never,
  EnvironmentRelayBindingRepository | AccountMachineRepository
> = Layer.effect(BoxSession, makeBoxSessionRelay);
