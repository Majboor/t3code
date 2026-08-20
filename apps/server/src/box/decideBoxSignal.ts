/**
 * Whether a box will end a process, decided on the box.
 *
 * `decideBoxCommand` already answers this question on the hub, and this file is
 * deliberately a second answer to it. The two are not redundant, because they
 * are not answering from the same place: the hub's copy runs inside the process
 * that is *asking*, and the box is reached over a relay by whatever is on the
 * other end of that relay. A caller-side check is a convenience — it refuses
 * early, in words, without a round trip. A box-side check is the boundary, and
 * anything reachable over a relay has to assume the caller is lying.
 *
 * This is the same shape as `t3-unit-helper.sh`, and for the same stated reason:
 * the helper re-derives its rules from its own argv rather than trusting the
 * TypeScript copy of them, because the agent has a shell on that machine and can
 * call the helper itself. The relay is the wider version of that hole. A hub
 * that is compromised, a build that skipped the check, a future caller written
 * by somebody who did not read `decideBoxCommand` — all three arrive here as an
 * ordinary `signal` request, and all three have to be refused by the machine
 * that owns the process.
 *
 * What makes the second answer *independent* rather than a copy is where the
 * facts come from. The hub decides from a service list the box sent it; this
 * decides from a service list the box just derived itself, from its own start
 * records and its own probe of its own sockets. Ownership is still
 * `@t3tools/shared/serviceRegistry` — there is exactly one implementation of
 * "ours", run twice against two observations, rather than two implementations.
 *
 * Pure and total, like every other rule in this directory: the decision is
 * whether a process on somebody's server lives or dies, and that should be
 * enumerable by reading one file rather than by reading a handler.
 *
 * @module Box
 */

import type { EnvironmentService } from "@t3tools/shared/serviceRegistry";

export type BoxSignalRefusalReason =
  /** It is somebody else's process, and no override named it. */
  | "process-not-ours"
  /** An override was offered and it names a different process. */
  | "override-mismatch";

export interface BoxSignalRefusal {
  readonly reason: BoxSignalRefusalReason;
  /** One sentence, ending up in the caller's journal and in front of a person. */
  readonly message: string;
}

export type BoxSignalDecision =
  | {
      readonly outcome: "allow";
      /** True when this ends something the box did not start. */
      readonly unmanaged: boolean;
    }
  | { readonly outcome: "refuse"; readonly refusal: BoxSignalRefusal };

export interface DecideBoxSignalInput {
  /**
   * What this box says is running on it, reconciled by the registry from its
   * own start records and its own probe. Never the caller's copy.
   */
  readonly services: ReadonlyArray<EnvironmentService>;
  readonly pid: number;
  /** `pid:<n>`, or null when none was given — the ordinary case. */
  readonly acknowledgedTarget: string | null;
}

function describe(service: EnvironmentService): string {
  return service.name === null ? `the process on port ${service.port}` : `"${service.name}"`;
}

/**
 * Whether this box will send this signal.
 *
 * The order is the argument. A pid this box started is allowed and nothing else
 * is consulted; everything else — a stranger's process, a pid nothing here can
 * account for, a pid that does not appear at all — lands in the same place,
 * which is the safe one. That last case matters more than it looks: a pid the
 * box can see nothing about is not evidence of innocence, it is absence of
 * evidence, and treating "I know nothing about 4821" as permission to kill 4821
 * would make the whole rule conditional on the probe having worked.
 *
 * The override stays, and stays deliberate. Removing it here would silently
 * delete a documented capability — `t3 box stop` can end a stranger's process
 * when a person names its pid — and a boundary check whose effect is to remove
 * the feature it guards is a boundary check somebody will turn off. What the
 * boundary is for is making the *default* safe: a caller that does not go out of
 * its way is refused by the machine, whatever the caller believes it decided.
 * The acknowledgement is a pid and not a flag for the reason
 * `boxStopAcknowledgement` gives — it cannot be produced without having looked
 * at the specific process, and it goes stale the moment anything restarts.
 */
export function decideBoxSignal(input: DecideBoxSignalInput): BoxSignalDecision {
  const acknowledgement = `pid:${input.pid}`;
  const onPid = input.services.filter((service) => service.pid === input.pid);

  // `canManage` is the registry's own derivation, and `ownership` is the value
  // it derives it from. Both are read rather than one trusted: they can only
  // disagree if the reconciliation changed under us, and the safe reading of a
  // disagreement is not to kill anything.
  if (onPid.some((service) => service.ownership === "ours" && service.canManage)) {
    return { outcome: "allow", unmanaged: false };
  }

  const stranger = onPid[0] ?? null;
  const subject = stranger === null ? `process ${input.pid}` : describe(stranger);
  const evidence =
    stranger === null
      ? `Nothing this box started accounts for pid ${input.pid}.`
      : stranger.ownershipReason;

  if (input.acknowledgedTarget === null) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "process-not-ours",
        message: `This box did not start ${subject}, so it is not T3's to stop. ${evidence} Nothing here knows what depends on it — it may be a database, a production API, or somebody else's work. Leave it running and ask the person who owns this machine.`,
      },
    };
  }

  if (input.acknowledgedTarget.trim() !== acknowledgement) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "override-mismatch",
        message: `The override names ${input.acknowledgedTarget.trim()}, but this box was asked to end ${acknowledgement}. A process that restarted has a different pid, so an override written earlier no longer names the thing in front of you.`,
      },
    };
  }

  return { outcome: "allow", unmanaged: true };
}
