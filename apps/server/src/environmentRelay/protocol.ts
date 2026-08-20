/**
 * The frames that travel on an environment's outbound connection to the hub.
 *
 * One socket carries three unrelated conversations — who this environment is,
 * whether it is still alive, and the browser traffic itself — so every frame is
 * tagged and multiplexed rather than positional. The browser traffic is opaque
 * here on purpose: the hub is a pipe for Effect RPC, not a participant in it,
 * and a hub that parsed RPC would have to be redeployed every time a contract
 * changed on somebody's laptop.
 *
 * Decoding is total. A frame arrives from a machine the hub does not run, over
 * a connection that survives NAT rebinds and version skew, so "this is not a
 * frame I understand" is an ordinary event and not an exception: `decodeFrame`
 * answers `null` and the caller drops the frame. A throwing decoder here would
 * turn one stray byte into a dropped connection for a whole workspace.
 *
 * @module EnvironmentRelay
 */

/**
 * Bumped when a frame changes meaning, never when one is added.
 *
 * The hub and the environment are separately deployed by definition — the whole
 * point is that the environment is a laptop that updates when its owner feels
 * like it — so the two ends will routinely disagree about this number. The hub
 * refuses a version it does not know rather than guessing, because a guess here
 * is a silently mis-framed byte stream and the symptom lands hours later as a
 * corrupted RPC response.
 */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * What the environment says about itself when asked.
 *
 * This is deliberately richer than a boolean, because the useful failure is not
 * "the process is gone" — that one closes the socket and needs no vocabulary.
 * It is the process that is still answering while unable to do any work, which
 * is exactly the case a socket-liveness check reports as healthy.
 */
export type EnvironmentReportedState = "starting" | "ready" | "busy" | "degraded" | "stopping";

const REPORTED_STATES: ReadonlySet<string> = new Set<EnvironmentReportedState>([
  "starting",
  "ready",
  "busy",
  "degraded",
  "stopping",
]);

export function isEnvironmentReportedState(value: unknown): value is EnvironmentReportedState {
  return typeof value === "string" && REPORTED_STATES.has(value);
}

/**
 * A browser connection, as seen on the shared socket.
 *
 * Channel ids are minted by the hub and are opaque to the environment. They are
 * scoped to one outbound connection, so a reconnecting environment starts with
 * no channels at all — nothing is resumed across a reconnect, because the
 * browser's RPC session cannot be resumed either and pretending otherwise would
 * deliver replies into a socket nobody is reading.
 */
export type RelayChannelId = string;

export type RelayFrame =
  /**
   * environment -> hub, first frame. The environment names itself; the hub
   * decides whether that name is one this machine may claim.
   */
  | {
      readonly type: "hello";
      readonly protocolVersion: number;
      readonly environmentId: string;
      readonly label: string | null;
    }
  /** hub -> environment. Identity settled; traffic may now arrive. */
  | {
      readonly type: "welcome";
      readonly environmentId: string;
      readonly heartbeatIntervalMs: number;
    }
  /** hub -> environment. The health question, with a nonce so the answer to it
   * cannot be a stale answer to the previous one. */
  | { readonly type: "ping"; readonly nonce: string }
  /** environment -> hub. The health answer, and what the environment thinks of
   * itself while answering. */
  | {
      readonly type: "pong";
      readonly nonce: string;
      readonly state: EnvironmentReportedState;
      readonly detail: string | null;
    }
  /** hub -> environment. A browser wants a session; make one. */
  | { readonly type: "open"; readonly channelId: RelayChannelId }
  /** Either direction. One RPC frame, verbatim. */
  | { readonly type: "data"; readonly channelId: RelayChannelId; readonly payload: string }
  /** Either direction. This channel is finished. */
  | { readonly type: "close"; readonly channelId: RelayChannelId; readonly reason: string | null }
  /**
   * hub -> environment, terminal. Said out loud rather than expressed by
   * dropping the socket, so the environment can tell "you are not welcome here"
   * from "the network went away" — the first must not be retried on a backoff
   * forever, and the second must.
   */
  | { readonly type: "bye"; readonly reason: RelayGoodbyeReason; readonly message: string };

/**
 * Why the hub ended it. `retryable` is the only thing the dialer reads.
 *
 * `revoked` and `rejected` are final: the credential is dead or the identity is
 * refused, and no amount of waiting changes either. `restarting` and
 * `superseded` are the hub's own housekeeping and mean "come back".
 */
export type RelayGoodbyeReason = "revoked" | "rejected" | "superseded" | "restarting";

export function isRelayGoodbyeRetryable(reason: RelayGoodbyeReason): boolean {
  return reason === "superseded" || reason === "restarting";
}

/**
 * How long a payload may be.
 *
 * A relayed frame is copied through the hub's memory on its way between two
 * machines neither of which the hub controls, so an unbounded payload is an
 * unbounded allocation triggered by anyone holding a session. Eight megabytes
 * is far above any RPC frame this product produces — the large things (diffs,
 * attachments, blobs) travel over HTTP, not over the RPC socket — and far below
 * a size at which a handful of them matters.
 */
export const RELAY_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Bounded because it is attacker-supplied and ends up on somebody's screen. */
const MAX_LABEL_LENGTH = 200;
const MAX_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

export function encodeFrame(frame: RelayFrame): string {
  return JSON.stringify(frame);
}

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

/** A field that is allowed to be absent, but not allowed to be rubbish. */
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

/**
 * A frame, or nothing.
 *
 * Every branch validates every field it will later read. The temptation is to
 * trust `type` and cast, which works right up until the far end is a different
 * build: then `channelId` is `undefined`, it is used as a map key, and one
 * browser's traffic starts arriving on another's channel.
 */
export function decodeFrame(raw: string): RelayFrame | null {
  if (raw.length > RELAY_MAX_PAYLOAD_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const source = parsed as Record<string, unknown>;

  switch (source["type"]) {
    case "hello": {
      const protocolVersion = source["protocolVersion"];
      const environmentId = readString(source, "environmentId", MAX_ID_LENGTH);
      const label = readOptionalString(source, "label", MAX_LABEL_LENGTH);
      if (
        typeof protocolVersion !== "number" ||
        !Number.isInteger(protocolVersion) ||
        environmentId === null ||
        !label.ok
      ) {
        return null;
      }
      return { type: "hello", protocolVersion, environmentId, label: label.value };
    }
    case "welcome": {
      const environmentId = readString(source, "environmentId", MAX_ID_LENGTH);
      const heartbeatIntervalMs = source["heartbeatIntervalMs"];
      if (
        environmentId === null ||
        typeof heartbeatIntervalMs !== "number" ||
        !Number.isFinite(heartbeatIntervalMs) ||
        heartbeatIntervalMs <= 0
      ) {
        return null;
      }
      return { type: "welcome", environmentId, heartbeatIntervalMs };
    }
    case "ping": {
      const nonce = readString(source, "nonce", MAX_ID_LENGTH);
      return nonce === null ? null : { type: "ping", nonce };
    }
    case "pong": {
      const nonce = readString(source, "nonce", MAX_ID_LENGTH);
      const state = source["state"];
      const detail = readOptionalString(source, "detail", MAX_REASON_LENGTH);
      if (nonce === null || !isEnvironmentReportedState(state) || !detail.ok) {
        return null;
      }
      return { type: "pong", nonce, state, detail: detail.value };
    }
    case "open": {
      const channelId = readString(source, "channelId", MAX_ID_LENGTH);
      return channelId === null ? null : { type: "open", channelId };
    }
    case "data": {
      const channelId = readString(source, "channelId", MAX_ID_LENGTH);
      const payload = source["payload"];
      // An empty payload is admitted: it is a legal, if pointless, RPC frame,
      // and refusing it would drop a connection over a harmless one.
      if (channelId === null || typeof payload !== "string") {
        return null;
      }
      return { type: "data", channelId, payload };
    }
    case "close": {
      const channelId = readString(source, "channelId", MAX_ID_LENGTH);
      const reason = readOptionalString(source, "reason", MAX_REASON_LENGTH);
      if (channelId === null || !reason.ok) {
        return null;
      }
      return { type: "close", channelId, reason: reason.value };
    }
    case "bye": {
      const reason = source["reason"];
      const message = readOptionalString(source, "message", MAX_REASON_LENGTH);
      if (
        (reason !== "revoked" &&
          reason !== "rejected" &&
          reason !== "superseded" &&
          reason !== "restarting") ||
        !message.ok
      ) {
        return null;
      }
      return { type: "bye", reason, message: message.value ?? "" };
    }
    default:
      return null;
  }
}
