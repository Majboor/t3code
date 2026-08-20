/**
 * The rules governing what an agent may do to a box, and how much of the answer
 * it is allowed to read back.
 *
 * A **box** is a machine the agent drives rather than one it lives on. The agent
 * is running a turn somewhere else — on the person's own laptop, holding the
 * person's provider credential — and reaches the box through the hub relay for
 * the duration of a command. Nothing about a box is a workspace: it holds no
 * projects, runs no turns, and must never be asked to connect a provider
 * account of its own. That last point is not a preference. Per-user provider
 * credentials are enforced with no fallback, so a machine that counted as a
 * workspace would refuse every turn until somebody logged into Claude on a VPS,
 * which is the failure this whole shape exists to avoid.
 *
 * Pure and total, for the same reason `decideEnrollment` is: the decision here
 * is whether a process on somebody's server lives or dies. The user's own box
 * runs unrelated production services next to whatever T3 started, and "the agent
 * stopped one of those" is the mistake that is never forgiven. A rule that is a
 * sequence of `if`s inside a command handler can only be verified by reading the
 * handler; stated here it can be enumerated, and it is.
 *
 * What this file does **not** decide: who owns a running process. That is
 * `@t3tools/shared/serviceRegistry`, which correlates start records against
 * observed listeners by pid and answers `ours` / `not-ours` / `unknown`. This
 * module consumes that verdict and never re-derives it — two places deciding
 * ownership is two places to get it wrong, and the wrong one would be the one
 * holding the kill switch.
 *
 * @module Box
 */

import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";

import {
  canonicaliseUnitName,
  decideUnitCommand,
  type UnitPlan,
  type UnitRefusalReason,
  type UnitRequest,
} from "./decideUnitCommand.ts";

// ── how much output a turn is allowed to swallow ─────────────────────────────

/**
 * The truncation rule, in two numbers.
 *
 * A turn's context is the scarce resource, and a single `npm install` will
 * happily produce twelve thousand lines of progress bars. Piped into a reply
 * verbatim that is the whole budget spent on nothing: the agent then has less
 * room to act on the result than it had before it asked.
 *
 * Head **and** tail rather than either alone, because the two ends are where the
 * information is and the middle is where the noise is. The head says what the
 * command decided to do — the resolved versions, the config it picked up, the
 * first thing that went wrong. The tail carries the summary and, on a failure,
 * the actual error: build tools print the diagnosis last. Keeping only the head
 * truncates every stack trace exactly before the useful line; keeping only the
 * tail loses the first error in a run that produced fifty.
 *
 * Two kibibytes each is roughly a screenful per end — around five hundred tokens
 * a stream, two thousand in the worst case where both streams are full and both
 * overflow. That is affordable once per command and still affordable ten times
 * in a turn, which is the actual usage: an agent driving a box runs a sequence,
 * not a single call.
 *
 * Nothing is lost by truncating. The full stream is written to the command
 * journal and addressed by the run's id, so the agent that wants the other
 * eleven thousand lines asks for them — and asks having already seen the exit
 * code and the error, which is usually the point at which it stops wanting them.
 */
export const BOX_OUTPUT_HEAD_BYTES = 2_048;
export const BOX_OUTPUT_TAIL_BYTES = 2_048;

/**
 * The second, far looser budget: what the journal keeps so "fetch more" has
 * something to fetch.
 *
 * The same rule at a different scale rather than a different rule, because the
 * alternative — keeping everything — puts an unbounded write into a SQLite file
 * on somebody's laptop every time an agent runs a build. Half a mebibyte each
 * end holds a complete install log with room over, and the marker in the middle
 * means a reader who hits the ceiling is told they did rather than left to
 * wonder why the file ends mid-line.
 */
export const BOX_JOURNAL_HEAD_BYTES = 512 * 1_024;
export const BOX_JOURNAL_TAIL_BYTES = 512 * 1_024;

export interface OutputBounds {
  readonly headBytes?: number;
  readonly tailBytes?: number;
}

export interface BoundedOutput {
  /** What the caller may show: the whole thing, or head + marker + tail. */
  readonly text: string;
  readonly truncated: boolean;
  /** The size of the original, so "how much did I not see" is answerable. */
  readonly totalBytes: number;
  readonly omittedBytes: number;
}

/** UTF-8 length without allocating a copy of the string to measure it. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one code point of four bytes, and consuming both
      // halves here is what stops the pair being counted as two three-byte
      // characters — which would over-report every emoji in a log line.
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * As much of the start as fits, never splitting a character.
 *
 * Cutting at a UTF-16 index would be simpler and would sometimes leave half a
 * surrogate pair at the boundary, which renders as a replacement character and,
 * worse, is not valid UTF-8 when the result is written back out. Log lines carry
 * box-drawing characters and emoji constantly, so this is the ordinary case
 * rather than the exotic one.
 */
function takeUtf8Prefix(text: string, budget: number): string {
  if (budget <= 0) return "";
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : isPair ? 4 : 3;
    if (bytes + size > budget) break;
    bytes += size;
    index += isPair ? 2 : 1;
  }
  return text.slice(0, index);
}

/** As much of the end as fits, never splitting a character. */
function takeUtf8Suffix(text: string, budget: number): string {
  if (budget <= 0) return "";
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    const code = text.charCodeAt(index - 1);
    const isPair =
      code >= 0xdc00 &&
      code <= 0xdfff &&
      index - 2 >= 0 &&
      text.charCodeAt(index - 2) >= 0xd800 &&
      text.charCodeAt(index - 2) <= 0xdbff;
    const leading = isPair ? text.charCodeAt(index - 2) : code;
    const size = leading < 0x80 ? 1 : leading < 0x800 ? 2 : isPair ? 4 : 3;
    if (bytes + size > budget) break;
    bytes += size;
    index -= isPair ? 2 : 1;
  }
  return text.slice(index);
}

/**
 * One stream, cut to size, saying plainly how much it dropped.
 *
 * The marker is inside the text rather than only in the metadata because the
 * text is what reaches the agent's context, and a silently joined head and tail
 * is a lie about adjacency: two log lines that never touched appear consecutive,
 * and a reader concludes the second followed the first. Naming the gap in bytes
 * rather than lines is deliberate too — the count is exact and needs no scan of
 * the omitted region, and "40 KB missing" is the number that tells a reader
 * whether fetching the rest is worth it.
 */
export function boundCommandOutput(text: string, bounds?: OutputBounds): BoundedOutput {
  const headBytes = Math.max(0, bounds?.headBytes ?? BOX_OUTPUT_HEAD_BYTES);
  const tailBytes = Math.max(0, bounds?.tailBytes ?? BOX_OUTPUT_TAIL_BYTES);
  const totalBytes = utf8ByteLength(text);

  if (totalBytes <= headBytes + tailBytes) {
    return { text, truncated: false, totalBytes, omittedBytes: 0 };
  }

  const head = takeUtf8Prefix(text, headBytes);
  const tail = takeUtf8Suffix(text, tailBytes);
  const omittedBytes = totalBytes - utf8ByteLength(head) - utf8ByteLength(tail);

  return {
    text: `${head}\n[… ${omittedBytes} bytes omitted …]\n${tail}`,
    truncated: true,
    totalBytes,
    omittedBytes,
  };
}

// ── what is being asked, and of what ─────────────────────────────────────────

/**
 * What the account knows about the box, at the moment of asking.
 *
 * `revoked` is read from the machine list and nowhere else. A box is a machine
 * on somebody's account — the same row, the same identity, the same Disconnect
 * button — and giving these verbs a second notion of "cut off" would be a second
 * flag to forget to set. Somebody who revokes a lost machine expects that to be
 * the end of it, not the end of it for the browser while a turn keeps shelling
 * into the thing.
 *
 * `reachable` is the relay's verdict, not a socket check. An environment can
 * hold its connection open while reporting itself unable to work, and a command
 * dispatched into that hangs until a timeout rather than failing usefully.
 */
export interface BoxFacts {
  readonly machineId: string;
  readonly revoked: boolean;
  /**
   * Whether the relay will carry traffic to it right now, as
   * `decideRelayLink` reports it.
   */
  readonly reachable: boolean;
}

export type BoxRequest =
  /** Run a command and wait for it, or start one and leave it running. */
  | { readonly verb: "run"; readonly command: string; readonly detach: boolean }
  /** What is running here, and which of it we started. */
  | { readonly verb: "services" }
  /** What happened here recently, from the journal. */
  | { readonly verb: "history" }
  /** The captured output of something we started. */
  | { readonly verb: "logs"; readonly target: string }
  | {
      readonly verb: "stop";
      readonly target: string;
      /**
       * The pid the caller is asserting it means to kill, as `pid:<n>`. Null
       * when no override was given, which is the ordinary case.
       */
      readonly acknowledgedTarget: string | null;
    }
  | { readonly verb: "claim-port"; readonly port: number; readonly purpose: string }
  | { readonly verb: "release-port"; readonly port: number }
  /**
   * The one thing on a box that needs privilege the agent does not have:
   * managing its own systemd units, and having them come back after a reboot.
   *
   * A separate verb rather than a flavour of `run`, because it is the only path
   * that reaches a root-owned helper through sudo. `run` is the agent as
   * itself; this is the agent asking for the narrow thing it cannot do as
   * itself, and the two should not be the same sentence anywhere.
   */
  | { readonly verb: "unit"; readonly unit: UnitRequest };

/**
 * Everything the rules need to see. Passed in rather than fetched, so the
 * decision is a function of its arguments and a test can state the world.
 */
export interface DecideBoxCommandInput {
  readonly box: BoxFacts;
  readonly request: BoxRequest;
  /**
   * The reconciled view from the service registry: every start record and every
   * observed listener, already resolved to `ours` / `not-ours` / `unknown`.
   */
  readonly services: ReadonlyArray<EnvironmentService>;
  /** Live port reservations. Expiry is the registry's business, not this one's. */
  readonly claims: ReadonlyArray<PortClaim>;
  /** The account asking. A reservation is only yours to release if you took it. */
  readonly actorUserId: string;
}

export type BoxRefusalReason =
  /** The machine was disconnected from the account. One flag, one meaning. */
  | "machine-revoked"
  /** No healthy relay link, so nothing can be dispatched.  */
  | "box-unreachable"
  | "empty-command"
  /** No service here goes by that name or port. */
  | "unknown-service"
  /** More than one does, and guessing which would be a coin toss. */
  | "ambiguous-service"
  /** Something is there and the machine will not name the process behind it. */
  | "service-unidentifiable"
  /** It is somebody else's, and no override was offered. */
  | "service-not-ours"
  /** An override was offered and it names a different process than the target. */
  | "override-mismatch"
  /** We never started it, so there was never anything to capture. */
  | "no-captured-logs"
  | "port-out-of-range"
  /** Somebody else holds the reservation being released. */
  | "claim-not-yours"
  | "claim-not-found"
  /**
   * The box refused it. Reached only when this module allowed something the
   * helper would not — the helper decides again on the machine, from the
   * machine's own facts, and it is the copy that counts.
   */
  | "helper-refused"
  /** Everything the unit rules refuse, kept distinct rather than flattened. */
  | UnitRefusalReason;

export interface BoxRefusal {
  readonly reason: BoxRefusalReason;
  /** What happened, in one sentence. */
  readonly headline: string;
  /** What to do instead. Never an incantation — see `stopRefusal`. */
  readonly remedy: string;
}

/**
 * What the caller should actually do, with the target already resolved.
 *
 * Carrying the resolved `service` rather than the caller's string is what stops
 * the rules and the execution disagreeing about which process was meant. A
 * handler that re-looked-up the name after an `allow` could find a different
 * one — services restart, ports change hands — and the permission granted would
 * not be the permission exercised.
 */
export type BoxPlan =
  | { readonly verb: "run"; readonly command: string; readonly detach: boolean }
  | { readonly verb: "services" }
  | { readonly verb: "history" }
  | { readonly verb: "logs"; readonly service: EnvironmentService; readonly managedId: string }
  | {
      readonly verb: "stop";
      readonly service: EnvironmentService;
      readonly pid: number;
      /** True when this is a process T3 did not start and an override permitted it. */
      readonly unmanaged: boolean;
    }
  | { readonly verb: "claim-port"; readonly port: number; readonly purpose: string }
  | { readonly verb: "release-port"; readonly port: number; readonly claim: PortClaim }
  | { readonly verb: "unit"; readonly unit: UnitPlan };

export type BoxCommandDecision =
  | { readonly outcome: "allow"; readonly plan: BoxPlan }
  | { readonly outcome: "refuse"; readonly refusal: BoxRefusal };

// ── resolving a target ───────────────────────────────────────────────────────

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * The string an override has to carry to stop a stranger's process.
 *
 * A pid and not a name, and this is the whole design of the override. A boolean
 * `--force` is a flag an agent appends the moment it reads a refusal, because
 * appending it costs nothing and the refusal told it exactly what to append; the
 * refusal then functions as a prompt rather than a stop. A pid cannot be
 * produced without having looked at the specific process, changes every time
 * anything restarts, and goes stale in the agent's own scrollback — so a value
 * copied from an earlier attempt refuses instead of silently killing whatever
 * inherited the number.
 */
export function boxStopAcknowledgement(service: EnvironmentService): string | null {
  return service.pid === null ? null : `pid:${service.pid}`;
}

/**
 * The one service a target names, if it names exactly one.
 *
 * `:3000` and `3000` both mean the port; anything else is matched against the
 * name. Ambiguity is returned rather than resolved: two processes called `api`
 * on one box is an ordinary state of affairs, and picking the first would mean
 * the agent stops whichever one the sort happened to put first.
 */
export function findBoxServices(
  services: ReadonlyArray<EnvironmentService>,
  target: string,
): ReadonlyArray<EnvironmentService> {
  const trimmed = target.trim();
  if (trimmed.length === 0) return [];

  const asPort = Number(trimmed.startsWith(":") ? trimmed.slice(1) : trimmed);
  if (Number.isInteger(asPort) && asPort >= MIN_PORT && asPort <= MAX_PORT) {
    return services.filter((service) => service.port === asPort);
  }

  const lowered = trimmed.toLowerCase();
  return services.filter(
    (service) => service.name !== null && service.name.toLowerCase() === lowered,
  );
}

function describe(service: EnvironmentService): string {
  return service.name === null ? `the service on port ${service.port}` : `"${service.name}"`;
}

/**
 * Why a stranger's process was not stopped, and what to do about it.
 *
 * Deliberately does not print the flag. The remedy sends the agent to the person
 * who owns the machine, because on a box that is genuinely the right next step:
 * the agent cannot know what depends on an unrecognised process, and the one
 * party who can is not in the loop unless something puts them there. The
 * override exists, it is documented in `--help`, and finding it is a small
 * deliberate act rather than the obvious continuation of this sentence. That
 * asymmetry is the entire safety property — an override the refusal hands over
 * is a confirmation dialog, and agents click through those.
 */
function stopRefusal(service: EnvironmentService): BoxRefusal {
  return {
    reason: "service-not-ours",
    headline: `${describe(service)} was not started by T3, so it is not T3's to stop.`,
    remedy: `${service.ownershipReason} Nothing here knows what depends on it — it may be a database, a production API, or somebody else's work. Leave it running and ask the person who owns this machine.`,
  };
}

// ── the rule ─────────────────────────────────────────────────────────────────

/**
 * Whether this verb may run against this box, and against what.
 *
 * The order of the guards is the argument. Revocation comes first because it is
 * the one answer that must not depend on anything else being true: a machine
 * somebody disconnected must refuse even if it is still dialled in and still
 * answering, since "I revoked it and it kept working" is the failure that makes
 * the button meaningless.
 *
 * Reachability comes next, and `history` is exempt from it. That exemption is
 * the point of having a journal at all. The question "what happened on this box"
 * is asked most often precisely when the box is unreachable — that is why
 * somebody is looking — and a history verb that required a live connection would
 * be unavailable exactly when it was needed. Everything else needs the machine,
 * because everything else is a statement about the machine's present.
 */
export function decideBoxCommand(input: DecideBoxCommandInput): BoxCommandDecision {
  const { box, request } = input;

  if (box.revoked) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "machine-revoked",
        headline: "This machine was disconnected from the account.",
        remedy:
          "Its credential was revoked, so nothing can reach it. Connect it again from the machines list if it should still be in use.",
      },
    };
  }

  if (request.verb === "history") {
    // Answered from the journal, which is durable and local. Reachability is
    // irrelevant and asking about it would make the record less useful than the
    // thing it records.
    return { outcome: "allow", plan: { verb: "history" } };
  }

  if (!box.reachable) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "box-unreachable",
        headline: "This box is not reachable right now.",
        remedy:
          "It has no healthy connection to the hub, so a command sent now would hang rather than fail. Check whether it is powered on and its agent is running; `t3 box history` still works and says what it was last doing.",
      },
    };
  }

  switch (request.verb) {
    case "run": {
      if (request.command.trim().length === 0) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "empty-command",
            headline: "No command was given.",
            remedy: "Pass the command to run, for example `t3 box run web -- npm ci`.",
          },
        };
      }
      return {
        outcome: "allow",
        plan: { verb: "run", command: request.command.trim(), detach: request.detach },
      };
    }

    case "services":
      return { outcome: "allow", plan: { verb: "services" } };

    case "logs": {
      const found = findBoxServices(input.services, request.target);
      const resolved = resolveOne(found, request.target);
      if (resolved.outcome === "refuse") return resolved;
      const service = resolved.service;

      // Not a permission refusal, and it must not read as one. There is no log
      // file because nothing captured a stream we never opened; saying "not
      // allowed" would send the agent looking for an override that would not
      // help it.
      if (service.managedId === null) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "no-captured-logs",
            headline: `T3 has no logs for ${describe(service)}.`,
            remedy: `${service.ownershipReason} Output is only captured for processes T3 started. Read it wherever that process writes its own logs.`,
          },
        };
      }

      return { outcome: "allow", plan: { verb: "logs", service, managedId: service.managedId } };
    }

    case "stop": {
      const found = findBoxServices(input.services, request.target);
      const resolved = resolveOne(found, request.target);
      if (resolved.outcome === "refuse") return resolved;
      const service = resolved.service;

      const pid = service.pid;
      if (pid === null) {
        // No pid means there is nothing to signal even if we wanted to, so this
        // refuses whatever flags were passed. An override cannot supply a fact
        // the machine declined to give.
        return {
          outcome: "refuse",
          refusal: {
            reason: "service-unidentifiable",
            headline: `This machine will not say which process holds port ${service.port}.`,
            remedy: `${service.ownershipReason} Without a process there is nothing to stop, and stopping "whatever is on that port" is how the wrong thing gets killed.`,
          },
        };
      }
      const acknowledgement = `pid:${pid}`;

      if (service.ownership === "ours") {
        // `canManage` is the registry's own derivation of this. Both are checked
        // rather than one trusted: they can only disagree if the registry changed
        // under us, and the safe reading of a disagreement is not to kill anything.
        if (!service.canManage) {
          return { outcome: "refuse", refusal: stopRefusal(service) };
        }
        return { outcome: "allow", plan: { verb: "stop", service, pid, unmanaged: false } };
      }

      if (request.acknowledgedTarget === null) {
        return { outcome: "refuse", refusal: stopRefusal(service) };
      }

      if (request.acknowledgedTarget.trim() !== acknowledgement) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "override-mismatch",
            headline: `The override names ${request.acknowledgedTarget.trim()}, but ${describe(service)} is ${acknowledgement}.`,
            remedy:
              "A process that restarted has a different pid, so an override written earlier no longer names the thing in front of you. Look at what is running now before deciding again.",
          },
        };
      }

      return { outcome: "allow", plan: { verb: "stop", service, pid, unmanaged: true } };
    }

    case "claim-port": {
      if (!Number.isInteger(request.port) || request.port < MIN_PORT || request.port > MAX_PORT) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "port-out-of-range",
            headline: `${request.port} is not a port.`,
            remedy: `Ports run from ${MIN_PORT} to ${MAX_PORT}.`,
          },
        };
      }
      // Whether the port is actually free is `decidePortAvailability`, which the
      // caller applies against a freshly probed machine. Deciding it here would
      // mean deciding it twice from the same data, and the copy that ran first
      // would be the stale one.
      return {
        outcome: "allow",
        plan: { verb: "claim-port", port: request.port, purpose: request.purpose.trim() },
      };
    }

    case "release-port": {
      const claim = input.claims.find((entry) => entry.port === request.port);
      if (!claim) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "claim-not-found",
            headline: `Nobody is holding a reservation on port ${request.port}.`,
            remedy:
              "There is nothing to release. If something is listening there, that is a process rather than a reservation — `t3 box services` says which.",
          },
        };
      }
      if (claim.claimedBy !== input.actorUserId) {
        return {
          outcome: "refuse",
          refusal: {
            reason: "claim-not-yours",
            headline: `Port ${request.port} is reserved by ${claim.claimedBy}, not by you.`,
            remedy: `They are holding it for: ${claim.purpose}. Releasing somebody else's reservation would let a third turn take a port they are about to bind.`,
          },
        };
      }
      return { outcome: "allow", plan: { verb: "release-port", port: request.port, claim } };
    }

    case "unit": {
      // The registry's verdict comes first, and it is the same refusal `stop`
      // gives. It rarely fires — unit names and process names are different
      // namespaces — but when it does, something on this box is both listening
      // and not ours under exactly the name being addressed, and that is the
      // moment to stop rather than the moment to prefer the other rule.
      //
      // It is deliberately in front of, and not instead of, the unit rules:
      // this one knows what is running, those know what may be asked, and the
      // helper on the box knows which units T3 actually wrote. Only the last of
      // those is a permission — the other two are here to refuse early and say
      // why in words a reader can act on.
      const touchesRunning =
        request.unit.verb === "stop" ||
        request.unit.verb === "restart" ||
        request.unit.verb === "disable";
      if (touchesRunning) {
        // Both spellings, because the registry records whatever name the thing
        // was started under and the caller may have typed either. A guard that
        // only recognised one of them would be absent exactly half the time.
        const found = [
          ...findBoxServices(input.services, request.unit.name),
          ...findBoxServices(input.services, canonicaliseUnitName(request.unit.name)),
        ];
        const conflicting = found.find((service) => service.ownership !== "ours");
        if (conflicting !== undefined) {
          return { outcome: "refuse", refusal: stopRefusal(conflicting) };
        }
      }

      const decision = decideUnitCommand(request.unit);
      if (decision.outcome === "refuse") {
        return {
          outcome: "refuse",
          refusal: {
            reason: decision.refusal.reason,
            headline: decision.refusal.headline,
            remedy: decision.refusal.remedy,
          },
        };
      }
      return { outcome: "allow", plan: { verb: "unit", unit: decision.plan } };
    }
  }
}

/** One service, or the refusal that says why the target did not name one. */
function resolveOne(
  found: ReadonlyArray<EnvironmentService>,
  target: string,
):
  | { readonly outcome: "resolved"; readonly service: EnvironmentService }
  | { readonly outcome: "refuse"; readonly refusal: BoxRefusal } {
  if (found.length === 0) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "unknown-service",
        headline: `Nothing here is called "${target.trim()}".`,
        remedy: "`t3 box services` lists what is running and what each one is called.",
      },
    };
  }
  if (found.length > 1) {
    return {
      outcome: "refuse",
      refusal: {
        reason: "ambiguous-service",
        headline: `"${target.trim()}" names ${found.length} services here.`,
        remedy: `Say which by port: ${found.map((service) => `:${service.port}`).join(", ")}.`,
      },
    };
  }
  return { outcome: "resolved", service: found[0]! };
}
