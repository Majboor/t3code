/**
 * `box/1` — the envelope a box answers, written once for both ends.
 *
 * The relay carries opaque payloads by design: the hub is a pipe, not a
 * participant, so a contract change on somebody's VPS must not require
 * redeploying the hub. That leaves the two ends of a box command talking to each
 * other through a hole neither of them can see into, and the only thing keeping
 * them in step is that they read the same file. `BoxSessionRelay` encodes with
 * these functions and `boxResponder` decodes with them, so a method added on one
 * side cannot silently mean something else on the other.
 *
 * Decoding is total, exactly as `environmentRelay/protocol.ts` is total and for
 * the same reason: the far end is a separately deployed build reached over a
 * connection that survives NAT rebinds and version skew, so "this is not a
 * request I understand" is an ordinary event. It comes back as a worded refusal
 * rather than as an exception, because a throwing decoder on the box would turn
 * one stray byte into a dropped channel and, to the person at the other end, a
 * box that hangs.
 *
 * The version rides on every request rather than being negotiated once. A box
 * updates when its owner feels like it, so the two ends will routinely disagree,
 * and a per-request version lets an old box refuse one call instead of the whole
 * session.
 *
 * @module Box
 */

/** Bumped when a request changes meaning, never when one is added. */
export const BOX_PROTOCOL = "box/1";

export type BoxRpcMethod =
  | "inspect"
  | "exec"
  | "signal"
  | "readServiceLog"
  | "claimPort"
  | "releasePort";

export type BoxProcessSignal = "SIGTERM" | "SIGKILL";

/**
 * One call, with its arguments already narrowed to the method.
 *
 * A tagged union rather than `method` plus a bag of `unknown`, because the
 * responder is the one place where a caller's word becomes a process on
 * somebody's machine: every field it reads has to have been checked, and a bag
 * invites reading one that was not.
 */
export type BoxRpcCall =
  | { readonly method: "inspect" }
  | {
      readonly method: "exec";
      readonly command: string;
      readonly detach: boolean;
      readonly timeoutMs: number;
    }
  | {
      readonly method: "signal";
      readonly pid: number;
      readonly signal: BoxProcessSignal;
      /**
       * The pid the caller is asserting it means to end, as `pid:<n>`, or null
       * when none was given — which is the ordinary case.
       *
       * Carried across the wire so the *box* can apply the override rule rather
       * than infer that one was applied. Without it the box would have to choose
       * between refusing every process it did not start — silently deleting a
       * documented escape hatch — and trusting that the caller already decided,
       * which is precisely the trust this protocol is not supposed to extend.
       */
      readonly acknowledgedTarget: string | null;
    }
  | { readonly method: "readServiceLog"; readonly managedId: string }
  | { readonly method: "claimPort"; readonly port: number; readonly purpose: string }
  | { readonly method: "releasePort"; readonly port: number };

export interface BoxRpcRequest {
  /**
   * The account the hub says is asking.
   *
   * Taken on the hub's word, and that is a real trust statement rather than an
   * oversight: an environment cannot verify a browser session it has no way to
   * check, and building a second identity system on the box is exactly what the
   * relay design rules out. What the box does *not* take on trust is what this
   * account may do — see `decideBoxSignal`.
   */
  readonly actorUserId: string;
  readonly call: BoxRpcCall;
}

export type BoxRequestDecoding =
  | { readonly outcome: "request"; readonly request: BoxRpcRequest }
  /**
   * Not addressed to the box protocol at all.
   *
   * Kept distinct from a malformed request because one relay channel can carry
   * either a box command or an ordinary browser RPC frame, and a frame that
   * simply is not ours must be passed along rather than answered with an error.
   */
  | { readonly outcome: "not-box" }
  | { readonly outcome: "malformed"; readonly message: string };

/**
 * How long a single command may be given, whatever the caller asks for.
 *
 * The request carries its own timeout so the box can enforce it too — a deadline
 * held only by the caller stops the caller waiting and leaves the process
 * running on a machine nobody is watching, which is the worse half of a timeout.
 * Clamped at both ends because the number arrives from the other side of a
 * relay: zero would kill every command at birth and a caller that asked for a
 * year would pin a process on somebody's server for one.
 */
export const BOX_MIN_EXEC_TIMEOUT_MS = 1_000;
export const BOX_MAX_EXEC_TIMEOUT_MS = 30 * 60_000;

export function clampBoxExecTimeout(requested: number): number {
  if (!Number.isFinite(requested)) {
    return BOX_MAX_EXEC_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.round(requested), BOX_MIN_EXEC_TIMEOUT_MS),
    BOX_MAX_EXEC_TIMEOUT_MS,
  );
}

/** Bounded because every one of these arrives from somewhere else. */
const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_PURPOSE_LENGTH = 500;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

function readString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  const value = source[key];
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || value.length > maxLength) {
    return { ok: false };
  }
  return { ok: true, value };
}

function readPort(source: Record<string, unknown>): number | null {
  const value = source["port"];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_PORT ||
    value > MAX_PORT
  ) {
    return null;
  }
  return value;
}

const malformed = (message: string): BoxRequestDecoding => ({ outcome: "malformed", message });

function decodeCall(method: string, params: Record<string, unknown>): BoxRpcCall | string {
  switch (method) {
    case "inspect":
      return { method: "inspect" };

    case "exec": {
      const command = readString(params, "command", MAX_COMMAND_LENGTH);
      if (command === null || command.trim().length === 0) {
        return "`exec` needs a command to run.";
      }
      const timeoutMs = params["timeoutMs"];
      if (typeof timeoutMs !== "number") {
        return "`exec` needs a timeout, so the box can enforce it too.";
      }
      return {
        method: "exec",
        command,
        detach: params["detach"] === true,
        timeoutMs: clampBoxExecTimeout(timeoutMs),
      };
    }

    case "signal": {
      const pid = params["pid"];
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return "`signal` needs the process id to end.";
      }
      const signal = params["signal"];
      if (signal !== "SIGTERM" && signal !== "SIGKILL") {
        return "A box only sends SIGTERM or SIGKILL.";
      }
      const acknowledged = readOptionalString(params, "acknowledgedTarget", MAX_ID_LENGTH);
      if (!acknowledged.ok) {
        return "The override on `signal` was not a `pid:<n>` string.";
      }
      return { method: "signal", pid, signal, acknowledgedTarget: acknowledged.value };
    }

    case "readServiceLog": {
      const managedId = readString(params, "managedId", MAX_ID_LENGTH);
      return managedId === null
        ? "`readServiceLog` needs the id of a service this box started."
        : { method: "readServiceLog", managedId };
    }

    case "claimPort": {
      const port = readPort(params);
      if (port === null) {
        return `A port runs from ${MIN_PORT} to ${MAX_PORT}.`;
      }
      const purpose = readOptionalString(params, "purpose", MAX_PURPOSE_LENGTH);
      if (!purpose.ok) {
        return "The purpose on `claimPort` was not a string.";
      }
      return { method: "claimPort", port, purpose: purpose.value ?? "" };
    }

    case "releasePort": {
      const port = readPort(params);
      return port === null
        ? `A port runs from ${MIN_PORT} to ${MAX_PORT}.`
        : { method: "releasePort", port };
    }

    default:
      return `This box does not know the \`${method}\` request.`;
  }
}

/**
 * A request, a refusal, or somebody else's frame.
 *
 * A payload with no `protocol` field is somebody else's — browser RPC shares
 * these channels — and is handed back untouched. A payload that names `box/`
 * and a version this build does not speak is *ours and wrong*, which is worth
 * saying out loud: the caller is a T3 that expects an answer, and silence would
 * read to it as a box that stopped responding.
 */
export function decodeBoxRequest(payload: string): BoxRequestDecoding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { outcome: "not-box" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { outcome: "not-box" };
  }

  const source = parsed as Record<string, unknown>;
  const protocol = source["protocol"];
  if (typeof protocol !== "string" || !protocol.startsWith("box/")) {
    return { outcome: "not-box" };
  }
  if (protocol !== BOX_PROTOCOL) {
    return malformed(`This box speaks ${BOX_PROTOCOL}, not ${protocol}.`);
  }

  const method = source["method"];
  if (typeof method !== "string") {
    return malformed("A box request must name a method.");
  }

  const rawParams = source["params"];
  const params =
    typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};

  const call = decodeCall(method, params);
  if (typeof call === "string") {
    return malformed(call);
  }

  // Absent rather than rejected: an older hub does not send one, and refusing
  // its calls outright would break every verb rather than the two that read it.
  const actorUserId = readString(source, "actorUserId", MAX_ID_LENGTH) ?? "";
  return { outcome: "request", request: { actorUserId, call } };
}

export function encodeBoxRequest(input: {
  readonly method: BoxRpcMethod;
  readonly actorUserId: string;
  readonly params: Record<string, unknown>;
}): string {
  return JSON.stringify({
    protocol: BOX_PROTOCOL,
    method: input.method,
    actorUserId: input.actorUserId,
    params: input.params,
  });
}

export function encodeBoxResult(result: unknown): string {
  return JSON.stringify({ protocol: BOX_PROTOCOL, result });
}

/**
 * A refusal, in the one shape the caller reads.
 *
 * `error` and not a thrown anything, because a box declining to kill somebody's
 * database is the system working. The caller turns this into a refusal it
 * journals, so the sentence here ends up in an audit table and in front of a
 * person: it should say what happened and what to do instead.
 */
export function encodeBoxError(message: string): string {
  return JSON.stringify({ protocol: BOX_PROTOCOL, error: message });
}
