/**
 * The hub's live connections, and the browser channels riding on them.
 *
 * In process memory and nowhere else, deliberately. A live socket cannot
 * outlive the process holding it, so writing liveness to a table would produce
 * rows that claim a connection this process no longer has — the durable half of
 * a relay is the *binding* (migration 061, "which account owns this name"), and
 * the ephemeral half is here. `cloudSync/liveCopy.ts` splits the same way and
 * for the same reason.
 *
 * Nothing in this file decides whether a link is healthy; it records the raw
 * observations and hands them to `decideRelayLink`. That separation is what
 * lets the "connected means healthy" rule be tested against a clock instead of
 * against a socket.
 *
 * @module EnvironmentRelay
 */

import * as Crypto from "node:crypto";

import {
  decideRelayLink,
  RELAY_HEARTBEAT_INTERVAL_MS,
  type RelayLinkVerdict,
} from "./decideRelayLink.ts";
import type { EnvironmentReportedState, RelayFrame, RelayGoodbyeReason } from "./protocol.ts";

/** What a caller holds after registering. Opaque, and safe to keep. */
export interface RelayConnectionHandle {
  readonly connectionId: string;
  readonly environmentId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly authSessionId: string;
}

export interface RelayChannelSink {
  /** One RPC frame arriving from the environment, bound for the browser. */
  readonly onData: (payload: string) => void;
  /** The environment, or the hub, finished this channel. */
  readonly onClose: (reason: string | null) => void;
}

export interface RelayChannel {
  readonly channelId: string;
  /** One RPC frame from the browser, bound for the environment. */
  readonly send: (payload: string) => void;
  readonly close: (reason: string | null) => void;
}

export interface RegisterRelayConnectionInput {
  readonly environmentId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly authSessionId: string;
  readonly label: string | null;
  /** How to put a frame on the wire. Never throws; failures close the socket. */
  readonly send: (frame: RelayFrame) => void;
  /**
   * How to end the connection. Called with a goodbye that has already been
   * sent, so an implementation only has to shut the transport down.
   */
  readonly close: (reason: RelayGoodbyeReason) => void;
}

interface RegisteredConnection {
  readonly handle: RelayConnectionHandle;
  readonly label: string | null;
  readonly send: (frame: RelayFrame) => void;
  readonly close: (reason: RelayGoodbyeReason) => void;
  socketOpen: boolean;
  revoked: boolean;
  acceptedAtMs: number | null;
  lastHealthAtMs: number | null;
  reportedState: EnvironmentReportedState | null;
  reportedDetail: string | null;
  /**
   * The nonce of the ping currently outstanding, if any.
   *
   * A pong is only believed when it names this. Without the check, an
   * environment could keep its link looking fresh by emitting pongs on a timer
   * of its own and never actually answering anything — which is the same lie as
   * a socket-liveness check, just told one layer up.
   */
  pendingNonce: string | null;
  readonly channels: Map<string, RelayChannelSink>;
}

/**
 * One entry per environment id, not per socket.
 *
 * Keying by environment is what makes a reconnect a *replacement* rather than a
 * second arrival: the browser routes by name, and two live sockets claiming one
 * name would deal traffic between them at random.
 */
const connections = new Map<string, RegisteredConnection>();

function currentFor(handle: RelayConnectionHandle): RegisteredConnection | null {
  const found = connections.get(handle.environmentId);
  // The identity check matters on every read. A handle outlives the connection
  // it names — a superseded socket keeps running until its own loop notices —
  // and without this, that dying socket's last few frames would be applied to
  // its replacement.
  return found && found.handle.connectionId === handle.connectionId ? found : null;
}

/**
 * Files a freshly authenticated connection, displacing any earlier one for the
 * same environment.
 *
 * The displaced connection is told why. A hub that simply dropped it would look
 * identical, from the laptop's side, to the network going away, and the dialer
 * would come back on a backoff to be displaced again — a loop that only ends
 * when somebody notices their environment flickering.
 */
export function registerRelayConnection(
  input: RegisterRelayConnectionInput,
): RelayConnectionHandle {
  const handle: RelayConnectionHandle = {
    connectionId: Crypto.randomUUID(),
    environmentId: input.environmentId,
    userId: input.userId,
    machineId: input.machineId,
    authSessionId: input.authSessionId,
  };

  const existing = connections.get(input.environmentId);
  if (existing) {
    endConnection(existing, "superseded", "Another connection claimed this environment.");
  }

  connections.set(input.environmentId, {
    handle,
    label: input.label,
    send: input.send,
    close: input.close,
    socketOpen: true,
    revoked: false,
    acceptedAtMs: null,
    lastHealthAtMs: null,
    reportedState: null,
    reportedDetail: null,
    pendingNonce: null,
    channels: new Map(),
  });

  return handle;
}

/**
 * The identity is settled. Until this is called the link reports `connecting`,
 * however open its socket is.
 */
export function acceptRelayConnection(handle: RelayConnectionHandle, nowMs: number): void {
  const connection = currentFor(handle);
  if (connection === null) {
    return;
  }
  connection.acceptedAtMs = nowMs;
  connection.send({
    type: "welcome",
    environmentId: handle.environmentId,
    heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
  });
}

/**
 * Puts a health question on the wire, and answers with the nonce the reply must
 * name to count.
 *
 * The time it was sent is deliberately not recorded. What decides the link's
 * state is when an answer last *arrived* — a ping that went out and vanished is
 * exactly the silence being measured, and letting the asking refresh anything
 * would make the hub reassure itself.
 */
export function noteRelayPingSent(handle: RelayConnectionHandle): string | null {
  const connection = currentFor(handle);
  if (connection === null) {
    return null;
  }
  const nonce = Crypto.randomUUID();
  connection.pendingNonce = nonce;
  connection.send({ type: "ping", nonce });
  return nonce;
}

/**
 * A health answer, believed only if it answers the question that was asked.
 *
 * Returns whether it counted, so a caller can tell a real answer from noise
 * without reaching into the entry.
 */
export function recordRelayPong(
  handle: RelayConnectionHandle,
  input: {
    readonly nonce: string;
    readonly state: EnvironmentReportedState;
    readonly detail: string | null;
    readonly nowMs: number;
  },
): boolean {
  const connection = currentFor(handle);
  if (connection === null || connection.pendingNonce !== input.nonce) {
    return false;
  }
  connection.pendingNonce = null;
  connection.lastHealthAtMs = input.nowMs;
  connection.reportedState = input.state;
  connection.reportedDetail = input.detail;
  return true;
}

/** Removes a connection and closes every browser channel it was carrying. */
export function unregisterRelayConnection(handle: RelayConnectionHandle): void {
  const connection = currentFor(handle);
  if (connection === null) {
    return;
  }
  connection.socketOpen = false;
  connections.delete(handle.environmentId);
  closeAllChannels(connection, "The environment disconnected.");
}

function closeAllChannels(connection: RegisteredConnection, reason: string): void {
  const sinks = [...connection.channels.values()];
  connection.channels.clear();
  for (const sink of sinks) {
    // Every browser holding a socket through this link is told, rather than
    // left waiting on a reply that is never coming. A hung RPC reads to the
    // person as the app being broken; a closed socket reads as the environment
    // being away, which is the truth.
    sink.onClose(reason);
  }
}

function endConnection(
  connection: RegisteredConnection,
  reason: RelayGoodbyeReason,
  message: string,
): void {
  connection.socketOpen = false;
  if (reason === "revoked") {
    connection.revoked = true;
  }
  connections.delete(connection.handle.environmentId);
  connection.send({ type: "bye", reason, message });
  connection.close(reason);
  closeAllChannels(connection, message);
}

/**
 * Cuts every connection a machine holds.
 *
 * This is what makes revocation mean something for an outbound connection.
 * Authentication happens once, at dial time, so without this a revoked machine
 * keeps its socket — and therefore its traffic — for as long as it stays up,
 * which could be months. Answers with the environment ids it dropped so the
 * caller can say what happened.
 */
export function dropRelayConnectionsForMachine(
  machineId: string,
  message: string,
): ReadonlyArray<string> {
  const dropped: Array<string> = [];
  for (const connection of Array.from(connections.values())) {
    if (connection.handle.machineId !== machineId) {
      continue;
    }
    dropped.push(connection.handle.environmentId);
    endConnection(connection, "revoked", message);
  }
  return dropped;
}

/** The same, for a session — the shape revocation actually arrives in. */
export function dropRelayConnectionsForAuthSession(
  authSessionId: string,
  message: string,
): ReadonlyArray<string> {
  const dropped: Array<string> = [];
  for (const connection of Array.from(connections.values())) {
    if (connection.handle.authSessionId !== authSessionId) {
      continue;
    }
    dropped.push(connection.handle.environmentId);
    endConnection(connection, "revoked", message);
  }
  return dropped;
}

export interface RelayLinkSummary {
  readonly environmentId: string;
  readonly userId: string;
  readonly machineId: string;
  readonly label: string | null;
  readonly verdict: RelayLinkVerdict;
  readonly openChannels: number;
}

function summarize(connection: RegisteredConnection, nowMs: number): RelayLinkSummary {
  return {
    environmentId: connection.handle.environmentId,
    userId: connection.handle.userId,
    machineId: connection.handle.machineId,
    label: connection.label,
    verdict: decideRelayLink({
      observation: {
        socketOpen: connection.socketOpen,
        revoked: connection.revoked,
        acceptedAtMs: connection.acceptedAtMs,
        lastHealthAtMs: connection.lastHealthAtMs,
        reportedState: connection.reportedState,
        reportedDetail: connection.reportedDetail,
      },
      nowMs,
    }),
    openChannels: connection.channels.size,
  };
}

/**
 * What this environment looks like right now, or nothing if it has never
 * dialled in to this process.
 *
 * "Nothing" is not the same as offline and the caller must not flatten them:
 * an environment with a binding but no entry here is one this hub has not heard
 * from, which is exactly what a saved environment looks like before its laptop
 * wakes up.
 */
export function relayLinkFor(environmentId: string, nowMs: number): RelayLinkSummary | null {
  const connection = connections.get(environmentId);
  return connection ? summarize(connection, nowMs) : null;
}

export function listRelayLinksForUser(
  userId: string,
  nowMs: number,
): ReadonlyArray<RelayLinkSummary> {
  return [...connections.values()]
    .filter((connection) => connection.handle.userId === userId)
    .map((connection) => summarize(connection, nowMs))
    .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId));
}

export type OpenRelayChannelResult =
  | { readonly outcome: "opened"; readonly channel: RelayChannel }
  | { readonly outcome: "refused"; readonly reason: OpenRelayChannelRefusal };

export type OpenRelayChannelRefusal =
  /** No connection for this name in this process. */
  | "not-connected"
  /** There is one, and it is not this person's. */
  | "not-yours"
  /** There is one, it is theirs, and it is not in a state to serve anybody. */
  | "not-healthy";

/**
 * Gives a browser a lane on an environment's outbound connection.
 *
 * Refuses on anything short of a healthy link, which is the whole argument of
 * `decideRelayLink` applied at the one moment it changes an outcome: a channel
 * opened onto a wedged environment is a websocket that connects and then
 * silently never answers, and there is no way for the browser to tell that from
 * a slow turn.
 *
 * Ownership is checked here and not left to the route, because this is the
 * function that hands over the ability to send bytes into somebody's machine.
 */
export function openRelayChannel(input: {
  readonly environmentId: string;
  readonly userId: string;
  readonly nowMs: number;
  readonly sink: RelayChannelSink;
}): OpenRelayChannelResult {
  const connection = connections.get(input.environmentId);
  if (!connection) {
    return { outcome: "refused", reason: "not-connected" };
  }
  if (connection.handle.userId !== input.userId) {
    // The same answer a stranger gets for a name that does not exist would be
    // kinder to probing; the caller flattens both into one sentence, and this
    // distinction stays inside the process where it is useful for logs.
    return { outcome: "refused", reason: "not-yours" };
  }
  if (!summarize(connection, input.nowMs).verdict.acceptsTraffic) {
    return { outcome: "refused", reason: "not-healthy" };
  }

  const channelId = Crypto.randomUUID();
  connection.channels.set(channelId, input.sink);
  connection.send({ type: "open", channelId });

  return {
    outcome: "opened",
    channel: {
      channelId,
      send: (payload) => {
        // Checked on every frame rather than captured once: the connection can
        // be superseded or revoked mid-conversation, and a captured `send`
        // would keep writing into a socket that is no longer this environment.
        const live = connections.get(input.environmentId);
        if (!live || live.handle.connectionId !== connection.handle.connectionId) {
          return;
        }
        if (!live.channels.has(channelId)) {
          return;
        }
        live.send({ type: "data", channelId, payload });
      },
      close: (reason) => {
        const live = connections.get(input.environmentId);
        if (!live || live.handle.connectionId !== connection.handle.connectionId) {
          return;
        }
        if (!live.channels.delete(channelId)) {
          return;
        }
        live.send({ type: "close", channelId, reason });
      },
    },
  };
}

/**
 * A frame the environment sent for one of its channels.
 *
 * Answers whether it was delivered. An undelivered frame is not an error worth
 * dropping the connection over — the browser may simply have gone away between
 * the request and the reply — but it is worth being able to count.
 */
export function deliverRelayChannelFrame(
  handle: RelayConnectionHandle,
  frame: { readonly type: "data"; readonly channelId: string; readonly payload: string },
): boolean {
  const connection = currentFor(handle);
  const sink = connection?.channels.get(frame.channelId);
  if (!sink) {
    return false;
  }
  sink.onData(frame.payload);
  return true;
}

export function closeRelayChannelFromEnvironment(
  handle: RelayConnectionHandle,
  frame: { readonly channelId: string; readonly reason: string | null },
): boolean {
  const connection = currentFor(handle);
  const sink = connection?.channels.get(frame.channelId);
  if (!connection || !sink) {
    return false;
  }
  connection.channels.delete(frame.channelId);
  sink.onClose(frame.reason);
  return true;
}

/** Tests own the process, so they own the registry. Not used at runtime. */
export function resetRelayRegistryForTests(): void {
  connections.clear();
}

/** Only for tests and diagnostics; the count of live entries in this process. */
export function relayConnectionCount(): number {
  return connections.size;
}
