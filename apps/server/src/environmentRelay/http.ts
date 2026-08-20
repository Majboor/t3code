import { DateTime, Effect, Fiber, Option, Queue, Schedule } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { AccountMachineRepository } from "../persistence/Services/AccountMachines.ts";
import { EnvironmentRelayBindingRepository } from "../persistence/Services/EnvironmentRelayBindings.ts";
import {
  decideRelayBinding,
  RELAY_HEARTBEAT_INTERVAL_MS,
  relayHealthDeadlineMs,
} from "./decideRelayLink.ts";
import {
  decodeFrame,
  encodeFrame,
  RELAY_PROTOCOL_VERSION,
  type RelayFrame,
  type RelayGoodbyeReason,
} from "./protocol.ts";
import {
  acceptRelayConnection,
  closeRelayChannelFromEnvironment,
  deliverRelayChannelFrame,
  listRelayLinksForUser,
  noteRelayPingSent,
  openRelayChannel,
  recordRelayPong,
  registerRelayConnection,
  relayLinkFor,
  unregisterRelayConnection,
  type RelayConnectionHandle,
} from "./registry.ts";

/**
 * An environment dialling out, and a browser reaching it back down the same
 * pipe.
 *
 * The problem this closes: today the browser dials *into* the environment,
 * which means the machine has to be publicly reachable, which in practice means
 * a Cloudflare quick tunnel whose URL changes on every restart — so every saved
 * environment dies when a laptop reboots. Reversing the direction removes the
 * requirement entirely: no inbound port, no public URL, and NAT and changing IP
 * addresses stop mattering because the connection is established from the side
 * that can always establish one.
 *
 * This is a *second* transport, not a replacement. A LAN or loopback
 * environment should still be dialled directly — it is faster and a relay in
 * the middle of a local connection is pure cost — and none of the existing
 * direct path is touched by anything here.
 *
 *   environment  GET /api/environments/relay                  -> holds it open
 *   browser      GET /api/environments/relay/attach/:id       -> rides it
 *   person       GET /api/environments/relay/links            -> what is live
 *
 * The hub does not understand a single byte of what it carries. Browser traffic
 * is Effect RPC and travels as opaque payloads, because a hub that parsed RPC
 * would need redeploying every time a contract changed on somebody's laptop —
 * and the laptops are exactly the machines that update whenever their owner
 * feels like it.
 *
 * @module EnvironmentRelay
 */

export const ENVIRONMENT_RELAY_DIAL_ROUTE = "/api/environments/relay";
export const ENVIRONMENT_RELAY_LINKS_ROUTE = "/api/environments/relay/links";
export const ENVIRONMENT_RELAY_ATTACH_ROUTE = "/api/environments/relay/attach/:environmentId";

/**
 * How many names one account may hold open at once.
 *
 * The environment id is claimed rather than issued (migration 061), so a single
 * enrolled machine can mint as many as it likes, and each one costs the hub a
 * socket and a routing entry for as long as it stays up. Sixteen is far more
 * environments than a person has machines and far fewer than a wedged client
 * needs to be interesting.
 */
export const MAX_RELAY_LINKS_PER_USER = 16;

/**
 * How long the hub waits for a `hello` before giving up on a socket.
 *
 * Without it, anything holding a valid credential can open sockets and say
 * nothing, and each one occupies a connection slot forever. Ten seconds is far
 * beyond a round trip and far below anything a person would notice.
 */
export const RELAY_HELLO_TIMEOUT_MS = 10_000;

const RELAY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: RELAY_HEADERS });

const signInRequired = json({ error: "Sign in to reach your environments." }, 401);
const unavailable = json({ error: "Environment connections are not available right now." }, 503);

/**
 * The same sentence for "no such environment" and "not yours".
 *
 * Environment ids are claimed by their machines, so a caller who could tell the
 * two apart could probe for ids that are already taken — which is the first
 * half of caring whose they are.
 */
const notFound = json({ error: "This environment is not connected to your account." }, 404);

const authenticatedSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth
    .authenticateWebSocketUpgrade(request)
    .pipe(Effect.catch(() => Effect.succeed(null)));
});

/**
 * Which of this account's machines is holding the credential on this request.
 *
 * Read through the existing machine registry rather than through a lookup of
 * its own, deliberately: an environment dialling in authenticates as *a machine
 * belonging to a user*, which is the identity device enrollment already
 * established, and inventing a second one here would mean a second thing to
 * revoke and a second thing to forget to revoke. A session with no machine row
 * is a browser, and a browser has no business holding an environment open.
 */
const machineForSession = (input: { readonly userId: string; readonly authSessionId: string }) =>
  Effect.gen(function* () {
    const machines = yield* AccountMachineRepository;
    const owned = yield* machines.listActiveForUser({ userId: input.userId });
    return owned.find((machine) => machine.authSessionId === input.authSessionId) ?? null;
  });

/**
 * A synchronous way to put a frame on an Effect-managed socket.
 *
 * The registry hands out plain functions — it is called from frame handlers and
 * from the revoke route, neither of which is in a position to run an Effect
 * against this socket's scope. An unbounded queue drained by one forked fiber
 * bridges the two without losing ordering, which matters: these are RPC frames
 * and a reordered pair is a reply arriving before its request.
 */
interface SocketWriter {
  readonly enqueue: (frame: RelayFrame) => void;
  readonly finish: () => void;
}

const makeSocketWriter = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const outbound = yield* Queue.unbounded<string | Socket.CloseEvent>();
    const write = yield* socket.writer;

    yield* Effect.forkScoped(
      Queue.take(outbound).pipe(
        Effect.flatMap(write),
        Effect.forever,
        // A write that fails means the socket is already gone, which the read
        // loop is about to discover on its own. Nothing here should turn that
        // into a defect that takes the request fiber down noisily.
        Effect.catchCause(() => Effect.void),
      ),
    );

    return {
      enqueue: (frame) => {
        Queue.offerUnsafe(outbound, encodeFrame(frame));
      },
      finish: () => {
        // Queued rather than sent, so a goodbye already in the queue goes out
        // before the close. Otherwise the far end learns it was revoked only by
        // watching its socket vanish, and retries forever on a backoff.
        Queue.offerUnsafe(outbound, new Socket.CloseEvent(1000, "relay closed"));
      },
    } satisfies SocketWriter;
  });

/** Sockets carry text here; a binary frame is decoded the same way. */
function frameTextOf(data: string | Uint8Array): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

/**
 * `GET /api/environments/relay`
 *
 * Held open for the life of the environment. The socket is authenticated the
 * moment it upgrades, but authentication happens exactly once, which is why
 * `dropRelayConnectionsForAuthSession` exists: a credential revoked an hour
 * later has to reach in and end this, because nothing on this path will ever
 * check it again.
 */
const dialRoute = Effect.gen(function* () {
  const session = yield* authenticatedSession;
  if (session === null) {
    return signInRequired;
  }

  const userId = resolveAuthenticatedUserId(session);
  const machine = yield* machineForSession({ userId, authSessionId: session.sessionId });
  if (machine === null) {
    return json(
      {
        error: "Only a machine connected to your account can hold an environment open.",
        reason: "not-a-machine",
      },
      403,
    );
  }

  const bindings = yield* EnvironmentRelayBindingRepository;
  const socket = yield* Effect.orDie((yield* HttpServerRequest.HttpServerRequest).upgrade);
  const writer = yield* makeSocketWriter(socket);

  let handle: RelayConnectionHandle | null = null;

  const goodbye = (reason: RelayGoodbyeReason, message: string) => {
    writer.enqueue({ type: "bye", reason, message });
    writer.finish();
  };

  /**
   * The first frame decides everything.
   *
   * The environment names itself and the hub decides whether that name is one
   * this machine may answer to. `decideRelayBinding` owns the rule; this
   * function owns only what to do about each verdict, which is why the refusals
   * below are one line each.
   */
  const onHello = (frame: Extract<RelayFrame, { type: "hello" }>) =>
    Effect.gen(function* () {
      if (handle !== null) {
        // A second hello on one socket. Ignored rather than obeyed: honouring
        // it would let one authenticated socket walk between environment names.
        return;
      }
      if (frame.protocolVersion !== RELAY_PROTOCOL_VERSION) {
        goodbye(
          "rejected",
          `This hub speaks relay protocol ${RELAY_PROTOCOL_VERSION}, not ${frame.protocolVersion}.`,
        );
        return;
      }

      const existing = yield* bindings.getByEnvironmentId({ environmentId: frame.environmentId });
      const decision = decideRelayBinding({
        existing: Option.isSome(existing)
          ? {
              environmentId: existing.value.environmentId,
              userId: existing.value.userId,
              machineId: existing.value.machineId,
            }
          : null,
        claim: { environmentId: frame.environmentId, userId, machineId: machine.machineId },
      });

      if (decision.outcome === "reject") {
        goodbye("rejected", "This environment name belongs to another account.");
        return;
      }

      const live = listRelayLinksForUser(userId, Date.now());
      if (
        live.length >= MAX_RELAY_LINKS_PER_USER &&
        !live.some((link) => link.environmentId === frame.environmentId)
      ) {
        goodbye("rejected", "Too many environments are already connected to this account.");
        return;
      }

      const now = yield* DateTime.now;
      yield* bindings.bind({
        environmentId: frame.environmentId,
        userId,
        machineId: machine.machineId,
        label: frame.label,
        nowIso: DateTime.formatIso(DateTime.toUtc(now)),
      });

      handle = registerRelayConnection({
        environmentId: frame.environmentId,
        userId,
        machineId: machine.machineId,
        authSessionId: session.sessionId,
        label: frame.label,
        send: writer.enqueue,
        close: () => {
          writer.finish();
        },
      });
      acceptRelayConnection(handle, Date.now());
      // Asked at once rather than on the next beat. A link is not attachable
      // until a ping has come back, so deferring the first one would make every
      // freshly connected environment unreachable for a whole heartbeat
      // interval — a person watching their laptop connect and then being told
      // it is not ready for fifteen seconds.
      noteRelayPingSent(handle);
    });

  const onFrame = (data: string | Uint8Array) => {
    const frame = decodeFrame(frameTextOf(data));
    if (frame === null) {
      // Dropped, not fatal. The far end is a separately deployed build and a
      // frame this hub cannot read must not cost a whole workspace its
      // connection.
      return Effect.void;
    }

    switch (frame.type) {
      case "hello":
        return onHello(frame);
      case "pong": {
        if (handle !== null) {
          recordRelayPong(handle, {
            nonce: frame.nonce,
            state: frame.state,
            detail: frame.detail,
            nowMs: Date.now(),
          });
        }
        return Effect.void;
      }
      case "data": {
        if (handle !== null) {
          deliverRelayChannelFrame(handle, frame);
        }
        return Effect.void;
      }
      case "close": {
        if (handle !== null) {
          closeRelayChannelFromEnvironment(handle, frame);
        }
        return Effect.void;
      }
      default:
        // `welcome`, `ping`, `open` and `bye` are the hub's to send. An
        // environment sending one is confused, not hostile; ignoring it is
        // cheaper than arguing about it.
        return Effect.void;
    }
  };

  /**
   * Asks the health question on a timer, and stops believing the answer when it
   * stops arriving.
   *
   * The second half is the one that matters. A socket outlives almost every
   * failure behind it, so a link that has gone quiet is cut here rather than
   * left holding a routing entry that would accept a browser and then hang.
   */
  const heartbeat = Effect.sync(() => {
    if (handle === null) {
      return;
    }
    const link = relayLinkFor(handle.environmentId, Date.now());
    if (link !== null && link.verdict.reason === "health-stale") {
      goodbye("restarting", "This connection stopped answering health checks.");
      return;
    }
    noteRelayPingSent(handle);
  }).pipe(Effect.repeat(Schedule.spaced(RELAY_HEARTBEAT_INTERVAL_MS)));

  /**
   * A socket that authenticates and then says nothing holds a slot forever.
   * This is the only thing that ends one.
   */
  const helloDeadline = Effect.sleep(RELAY_HELLO_TIMEOUT_MS).pipe(
    Effect.flatMap(() =>
      Effect.sync(() => {
        if (handle === null) {
          goodbye("rejected", "No environment was named on this connection.");
        }
      }),
    ),
  );

  const heartbeatFiber = yield* Effect.forkScoped(heartbeat);
  const deadlineFiber = yield* Effect.forkScoped(helloDeadline);

  yield* socket.runRaw(onFrame).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() => {
        if (handle !== null) {
          unregisterRelayConnection(handle);
        }
      }),
    ),
  );

  yield* Fiber.interrupt(heartbeatFiber).pipe(Effect.catchCause(() => Effect.void));
  yield* Fiber.interrupt(deadlineFiber).pipe(Effect.catchCause(() => Effect.void));

  return HttpServerResponse.empty();
}).pipe(Effect.catchCause(() => Effect.succeed(unavailable)));

/**
 * `GET /api/environments/relay/attach/:environmentId`
 *
 * The browser's end. It authenticates to the *hub* with its ordinary session —
 * there is no second credential and no second login — and the hub matches that
 * person against the account the environment is bound to.
 *
 * A refusal here is deliberately a refusal and not a socket that opens and goes
 * quiet. Attaching to an environment that is present but unhealthy would give
 * the browser a connection indistinguishable from a slow turn, and there is no
 * way for it to ever find out otherwise.
 */
const attachRoute = Effect.gen(function* () {
  const session = yield* authenticatedSession;
  if (session === null) {
    return signInRequired;
  }

  const params = yield* HttpRouter.params;
  const environmentId = params["environmentId"];
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    return notFound;
  }

  const userId = resolveAuthenticatedUserId(session);
  const probe = openRelayChannel({
    environmentId,
    userId,
    nowMs: Date.now(),
    // Replaced immediately below once the socket exists. Opening the channel
    // before the upgrade is what lets a refusal still be an HTTP status.
    sink: { onData: () => {}, onClose: () => {} },
  });

  if (probe.outcome === "refused") {
    if (probe.reason === "not-healthy") {
      // Said out loud, because this is the one refusal a person can act on:
      // the machine is there and is not well.
      return json(
        {
          error: "This environment is connected but not responding to health checks.",
          reason: "not-healthy",
        },
        503,
      );
    }
    return notFound;
  }

  const channel = probe.channel;
  const socket = yield* Effect.orDie((yield* HttpServerRequest.HttpServerRequest).upgrade).pipe(
    Effect.tapCause(() => Effect.sync(() => channel.close("upgrade failed"))),
  );

  const outbound = yield* Queue.unbounded<string | Socket.CloseEvent>();
  const write = yield* socket.writer;
  yield* Effect.forkScoped(
    Queue.take(outbound).pipe(
      Effect.flatMap(write),
      Effect.forever,
      Effect.catchCause(() => Effect.void),
    ),
  );

  const relayed = openRelayChannel({
    environmentId,
    userId,
    nowMs: Date.now(),
    sink: {
      onData: (payload) => {
        Queue.offerUnsafe(outbound, payload);
      },
      onClose: () => {
        Queue.offerUnsafe(outbound, new Socket.CloseEvent(1000, "environment closed"));
      },
    },
  });
  // The probe channel has served its purpose; the real one carries the traffic.
  channel.close(null);

  if (relayed.outcome === "refused") {
    Queue.offerUnsafe(outbound, new Socket.CloseEvent(1011, "environment unavailable"));
    return HttpServerResponse.empty();
  }

  yield* socket
    .runRaw((data) => {
      relayed.channel.send(frameTextOf(data));
      return Effect.void;
    })
    .pipe(
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(Effect.sync(() => relayed.channel.close("browser disconnected"))),
    );

  return HttpServerResponse.empty();
}).pipe(Effect.catchCause(() => Effect.succeed(unavailable)));

/**
 * `GET /api/environments/relay/links`
 *
 * What this account has bound, and which of those are live in this process
 * right now.
 *
 * A binding with no live link is reported as `offline` rather than omitted:
 * "your laptop is asleep" and "you have never connected this" are different
 * sentences, and only the list can tell them apart.
 */
const listLinksRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth
    .authenticateHttpRequest(request)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (session === null) {
    return signInRequired;
  }

  const userId = resolveAuthenticatedUserId(session);
  const bindings = yield* EnvironmentRelayBindingRepository;
  const bound = yield* bindings.listForUser({ userId });
  const nowMs = Date.now();

  return json(
    {
      environments: bound.map((binding) => {
        const link = relayLinkFor(binding.environmentId, nowMs);
        return {
          environmentId: binding.environmentId,
          label: binding.label,
          machineId: binding.machineId,
          firstBoundAt: binding.firstBoundAt,
          lastConnectedAt: binding.lastConnectedAt,
          // Never "connected" because a row exists. See `decideRelayLink`.
          state: link?.verdict.state ?? "offline",
          reason: link?.verdict.reason ?? "socket-closed",
          healthAgeMs: link?.verdict.healthAgeMs ?? null,
          detail: link?.verdict.detail ?? null,
          openChannels: link?.openChannels ?? 0,
        };
      }),
      heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
      healthDeadlineMs: relayHealthDeadlineMs(),
    },
    200,
  );
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

export const environmentRelayDialRouteLayer = HttpRouter.add(
  "GET",
  ENVIRONMENT_RELAY_DIAL_ROUTE,
  dialRoute,
);

export const environmentRelayLinksRouteLayer = HttpRouter.add(
  "GET",
  ENVIRONMENT_RELAY_LINKS_ROUTE,
  listLinksRoute,
);

export const environmentRelayAttachRouteLayer = HttpRouter.add(
  "GET",
  ENVIRONMENT_RELAY_ATTACH_ROUTE,
  attachRoute,
);
