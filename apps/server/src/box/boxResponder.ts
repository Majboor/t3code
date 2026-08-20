/**
 * The box's own side of `box/1`: what answers when an agent drives this machine.
 *
 * `BoxSessionRelay` defines the calls and nothing answered them, so every verb
 * reported the box as speaking a protocol it did not know. This is the other
 * half — it takes a payload off a relay channel, decides whether the box will do
 * it, does it, and hands back the structured result the caller is waiting for.
 *
 * Plain TypeScript with every dependency injected, like `dialer.ts` and
 * `registry.ts` next door. The interesting behaviour here is *refusal*, and a
 * refusal is only worth anything if it can be exercised against a machine that
 * does not exist: a test that had to start a real service on a real port to
 * check that the box declines to kill it is a test nobody runs.
 *
 * One request, one reply, one channel. The relay already multiplexes, so a
 * second correlation scheme on top of it would be two id spaces to keep straight
 * for no gain — and a mis-correlated reply would deliver one command's output as
 * another's, which on a `stop` is unthinkable.
 *
 * @module Box
 */

import {
  boundCommandOutput,
  BOX_JOURNAL_HEAD_BYTES,
  BOX_JOURNAL_TAIL_BYTES,
} from "./decideBoxCommand.ts";
import { decideBoxSignal } from "./decideBoxSignal.ts";
import {
  decodeBoxRequest,
  encodeBoxError,
  encodeBoxResult,
  type BoxProcessSignal,
} from "./boxProtocol.ts";
import type { BoxExecOutcome, BoxInspection } from "./Services/BoxSession.ts";
import type { PortClaim } from "@t3tools/shared/serviceRegistry";

/**
 * The machine itself, as the responder needs it.
 *
 * Promises rather than Effects, because this is what a relay channel hands its
 * bytes to — a plain callback with no runtime around it — and because the seam
 * exists so a test can hand over a machine made of arrays. What it deliberately
 * does *not* expose is a way to ask "may I": the permission questions are
 * answered in this file, from what `inspect` reports, so that no implementation
 * of this interface can be written that forgets to ask them.
 */
export interface BoxMachine {
  /**
   * What is running here, reconciled from this box's own start records and its
   * own probe of its own sockets.
   *
   * This is the fact the refusals rest on, which is why it is the box's and not
   * the caller's. The hub has a copy of this list and decided from it already;
   * that copy travelled over a relay and is, from here, hearsay.
   */
  readonly inspect: () => Promise<BoxInspection>;
  readonly exec: (input: {
    readonly command: string;
    readonly detach: boolean;
    readonly timeoutMs: number;
    readonly actorUserId: string;
  }) => Promise<BoxExecOutcome>;
  /** Sends the signal. Whether it *may* be sent is decided here, not there. */
  readonly signal: (input: {
    readonly pid: number;
    readonly signal: BoxProcessSignal;
  }) => Promise<boolean>;
  readonly readServiceLog: (input: { readonly managedId: string }) => Promise<string>;
  readonly claimPort: (input: {
    readonly port: number;
    readonly purpose: string;
    readonly actorUserId: string;
  }) => Promise<PortClaim | null>;
  readonly releasePort: (input: {
    readonly port: number;
    readonly actorUserId: string;
  }) => Promise<boolean>;
}

/**
 * Answers one payload, or declines to recognise it.
 *
 * `null` means "not a box request" and is not a failure: one relay channel can
 * carry either a box command or an ordinary browser RPC frame, and the caller of
 * this function is the thing that decides which. Answering somebody else's frame
 * with a box error would break the browser path by being helpful.
 */
export type BoxResponder = (payload: string) => Promise<string | null>;

/**
 * What the box sends back for a stream.
 *
 * Bounded at the journal's budget rather than at the reply's. The tight bound —
 * a screenful each end — is applied by the caller to what actually reaches a
 * turn's context, and it is applied *after* the full stream has been written to
 * the journal, so cutting to the tight bound here would throw away the copy the
 * journal exists to hold. The generous bound is still a bound: an unbounded
 * stream would be an unbounded frame copied through a hub that is carrying it
 * between two machines it does not control.
 */
function forTheWire(text: string): string {
  return boundCommandOutput(text, {
    headBytes: BOX_JOURNAL_HEAD_BYTES,
    tailBytes: BOX_JOURNAL_TAIL_BYTES,
  }).text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBoxResponder(machine: BoxMachine): BoxResponder {
  /**
   * The one verb that ends something, and the only one whose permission is
   * decided here rather than by the thing being asked.
   *
   * The inspection is taken fresh, immediately before deciding. Anything older
   * is a claim about a machine whose processes restart — a service list from
   * thirty seconds ago can name a pid that has since been recycled, and a
   * permission granted against a recycled pid is a permission to kill whatever
   * inherited the number.
   */
  const answerSignal = async (input: {
    readonly pid: number;
    readonly signal: BoxProcessSignal;
    readonly acknowledgedTarget: string | null;
  }): Promise<string> => {
    const inspection = await machine.inspect();
    const decision = decideBoxSignal({
      services: inspection.services,
      pid: input.pid,
      acknowledgedTarget: input.acknowledgedTarget,
    });
    if (decision.outcome === "refuse") {
      return encodeBoxError(decision.refusal.message);
    }
    const signalled = await machine.signal({ pid: input.pid, signal: input.signal });
    return encodeBoxResult({ signalled, unmanaged: decision.unmanaged });
  };

  return async (payload) => {
    const decoded = decodeBoxRequest(payload);
    if (decoded.outcome === "not-box") {
      return null;
    }
    if (decoded.outcome === "malformed") {
      return encodeBoxError(decoded.message);
    }

    const { actorUserId, call } = decoded.request;

    try {
      switch (call.method) {
        case "inspect": {
          const inspection = await machine.inspect();
          return encodeBoxResult(inspection);
        }

        case "exec": {
          const outcome = await machine.exec({
            command: call.command,
            detach: call.detach,
            timeoutMs: call.timeoutMs,
            actorUserId,
          });
          return encodeBoxResult({
            ...outcome,
            stdout: forTheWire(outcome.stdout),
            stderr: forTheWire(outcome.stderr),
          } satisfies BoxExecOutcome);
        }

        case "signal":
          return await answerSignal(call);

        case "readServiceLog": {
          const text = await machine.readServiceLog({ managedId: call.managedId });
          return encodeBoxResult({ text: forTheWire(text) });
        }

        case "claimPort": {
          const claim = await machine.claimPort({
            port: call.port,
            purpose: call.purpose,
            actorUserId,
          });
          return encodeBoxResult({ claim });
        }

        case "releasePort": {
          const released = await machine.releasePort({ port: call.port, actorUserId });
          return encodeBoxResult({ released });
        }
      }
    } catch (error) {
      // Answered rather than dropped. A channel that goes quiet leaves the
      // caller waiting out a fifteen-minute timeout for something that has
      // already failed, and "the box did not answer" is the least useful true
      // sentence available about a box that answered immediately and badly.
      return encodeBoxError(`This box could not do that: ${messageOf(error)}`);
    }
  };
}
