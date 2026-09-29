/**
 * The environment's end: dial out, stay up, and carry browsers home.
 *
 * This runs on the machine the work is on. It is the half of the feature that
 * removes the requirement for a public URL — there is no listening port to
 * expose, no tunnel to mint, and no hostname to go stale, because the only
 * connection involved is one this process opened outwards. NAT, dynamic
 * addresses and a laptop that moves between three networks a day all stop being
 * problems for the same reason.
 *
 * Plain TypeScript and every dependency injected, deliberately. The interesting
 * behaviour here is *time* — backoff, reconnection, giving up — and that is
 * miserable to test through a layer stack and trivial to test when the clock,
 * the socket and the randomness are arguments. `registry.ts` is plain for the
 * same reason.
 *
 * What this file will not do is decide anything. How long to wait is
 * `relayDialDelayMs`; whether a refusal is worth retrying is
 * `isRelayGoodbyeRetryable`. Both live in modules with no I/O in them.
 *
 * @module EnvironmentRelay
 */

import {
  relayDialDelayMs,
  spreadRelayDialDelayMs,
  type RelayHealthWindow,
} from "./decideRelayLink.ts";
import {
  decodeFrame,
  encodeFrame,
  isRelayGoodbyeRetryable,
  RELAY_PROTOCOL_VERSION,
  type EnvironmentReportedState,
  type RelayFrame,
} from "./protocol.ts";

/** The bit of `WebSocket` this needs, so a test can hand it something else. */
export interface RelaySocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", handler: () => void): void;
  addEventListener(type: "error", handler: () => void): void;
}

/**
 * One browser's RPC session, served locally.
 *
 * The environment does not interpret what comes down a channel; it hands the
 * bytes to something that speaks RPC and hands the answers back. In production
 * that something is this very server's own `/ws`, reached over loopback — which
 * means the relay reuses every existing handler, every existing contract and
 * every existing test, and adds no second implementation of the protocol to
 * keep in step.
 */
export interface RelayLocalSession {
  readonly send: (payload: string) => void;
  readonly close: () => void;
}

export type RelayLocalSessionFactory = (handlers: {
  readonly onData: (payload: string) => void;
  readonly onClose: () => void;
}) => Promise<RelayLocalSession>;

/**
 * What this environment says when the hub asks how it is.
 *
 * A function rather than a value because the answer has to be true at the
 * moment of asking. A cached "ready" from startup is exactly the stale
 * reassurance the hub's health rule exists to reject, and caching it here would
 * defeat that rule from the far side where it cannot be seen.
 */
export type RelayHealthReporter = () => {
  readonly state: EnvironmentReportedState;
  readonly detail: string | null;
};

export type RelayDialerState =
  | "idle"
  | "connecting"
  | "connected"
  | "waiting"
  /** Refused for a reason that will not change. Nothing retries from here. */
  | "refused"
  | "stopped";

export interface EnvironmentDialerOptions {
  /** Where the hub is, as an `http:`/`https:` origin. */
  readonly hubBaseUrl: string;
  /** This environment's own name, generated once and kept on disk. */
  readonly environmentId: string;
  readonly label: string | null;
  /**
   * Mints a short-lived websocket token from this machine's credential.
   *
   * A function because it must be re-minted on every dial: the tokens are
   * short-lived by design, and a laptop that reconnects after a week of sleep
   * would otherwise present one that expired six days ago.
   */
  readonly issueWebSocketToken: () => Promise<string>;
  readonly reportHealth: RelayHealthReporter;
  readonly openLocalSession: RelayLocalSessionFactory;
  readonly connect: (url: string) => RelaySocketLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onStateChange?: (state: RelayDialerState, detail: string | null) => void;
  readonly onError?: (message: string) => void;
  readonly backoff?: { readonly baseMs?: number; readonly maxMs?: number };
  readonly healthWindow?: RelayHealthWindow;
}

export interface EnvironmentDialer {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly state: () => RelayDialerState;
  /** How many failed dials since the last successful one. Zero when connected. */
  readonly failedAttempts: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A backoff timer is never a reason to keep the process alive. Without
    // this, shutting down while the dialer happens to be waiting out a long
    // backoff holds Node open until the timer fires on its own.
    timer.unref?.();
  });

/** `http://hub` -> `ws://hub/api/environments/relay?wsToken=…` */
export function relayDialUrl(hubBaseUrl: string, wsToken: string): string {
  const url = new URL("/api/environments/relay", hubBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsToken", wsToken);
  return url.toString();
}

export function createEnvironmentDialer(options: EnvironmentDialerOptions): EnvironmentDialer {
  const sleep = options.sleep ?? defaultSleep;
  /**
   * Cuts short whatever backoff the loop is sitting in.
   *
   * `stop()` awaits the loop, and the loop spends nearly all of its time
   * asleep between dial attempts — up to the backoff ceiling. Awaiting it
   * without a way to wake it meant shutdown blocked for as long as the current
   * wait had left, which on a repeatedly failing dial is the full ceiling.
   * Set while a backoff is in flight and cleared as soon as it ends.
   */
  let wakeFromBackoff: (() => void) | null = null;
  const random = options.random ?? Math.random;

  let state: RelayDialerState = "idle";
  let running = false;
  let failedAttempts = 0;
  let socket: RelaySocketLike | null = null;
  let loop: Promise<void> = Promise.resolve();

  const setState = (next: RelayDialerState, detail: string | null = null) => {
    if (state === next) {
      return;
    }
    state = next;
    options.onStateChange?.(next, detail);
  };

  /**
   * One connection, from dial to close.
   *
   * Resolves with whether it is worth trying again. It never throws: every way
   * a connection can end — refused, dropped, network gone, a token that failed
   * to mint — is an ordinary outcome of this function and the caller's only job
   * is to decide how long to wait.
   */
  const runOneConnection = async (): Promise<{
    readonly retry: boolean;
    readonly connected: boolean;
    readonly detail: string | null;
  }> => {
    setState("connecting");

    let wsToken: string;
    try {
      wsToken = await options.issueWebSocketToken();
    } catch (error) {
      // Almost always the hub being unreachable, which is precisely the case
      // that must be retried rather than treated as a rejection.
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.(`Could not mint a relay token: ${message}`);
      return { retry: true, connected: false, detail: message };
    }

    return new Promise((resolve) => {
      let settled = false;
      let connected = false;
      const sessions = new Map<string, RelayLocalSession>();
      /**
       * Channels the hub has opened but whose local session has not finished
       * opening yet. Frames that arrive in that window are queued rather than
       * dropped: the first thing a browser sends after connecting is its RPC
       * handshake, and losing it leaves a socket that is open and mute.
       */
      const pending = new Map<string, Array<string>>();

      const finish = (retry: boolean, detail: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const session of sessions.values()) {
          session.close();
        }
        sessions.clear();
        pending.clear();
        resolve({ retry, connected, detail });
      };

      let current: RelaySocketLike;
      try {
        current = options.connect(relayDialUrl(options.hubBaseUrl, wsToken));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.onError?.(`Could not open a relay connection: ${message}`);
        return finish(true, message);
      }
      socket = current;

      const send = (frame: RelayFrame) => {
        try {
          current.send(encodeFrame(frame));
        } catch {
          // The socket is already gone; the close handler is about to run.
        }
      };

      const openChannel = async (channelId: string) => {
        pending.set(channelId, []);
        try {
          const session = await options.openLocalSession({
            onData: (payload) => send({ type: "data", channelId, payload }),
            onClose: () => {
              if (sessions.delete(channelId)) {
                send({ type: "close", channelId, reason: null });
              }
            },
          });
          if (settled) {
            session.close();
            return;
          }
          sessions.set(channelId, session);
          for (const queued of pending.get(channelId) ?? []) {
            session.send(queued);
          }
          pending.delete(channelId);
        } catch (error) {
          pending.delete(channelId);
          const message = error instanceof Error ? error.message : String(error);
          options.onError?.(`Could not serve a relayed browser: ${message}`);
          // Refused out loud. A channel the hub thinks is open and nothing is
          // reading is a browser waiting forever on its first reply.
          send({ type: "close", channelId, reason: "could not open a local session" });
        }
      };

      current.addEventListener("open", () => {
        send({
          type: "hello",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          environmentId: options.environmentId,
          label: options.label,
        });
      });

      current.addEventListener("message", (event) => {
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Uint8Array
              ? new TextDecoder().decode(event.data)
              : String(event.data);
        const frame = decodeFrame(raw);
        if (frame === null) {
          return;
        }

        switch (frame.type) {
          case "welcome": {
            connected = true;
            failedAttempts = 0;
            setState("connected");
            return;
          }
          case "ping": {
            // Answered from a live reading, never from a remembered one.
            const health = options.reportHealth();
            send({
              type: "pong",
              nonce: frame.nonce,
              state: health.state,
              detail: health.detail,
            });
            return;
          }
          case "open": {
            void openChannel(frame.channelId);
            return;
          }
          case "data": {
            const session = sessions.get(frame.channelId);
            if (session) {
              session.send(frame.payload);
              return;
            }
            const queue = pending.get(frame.channelId);
            if (queue) {
              queue.push(frame.payload);
            }
            return;
          }
          case "close": {
            sessions.get(frame.channelId)?.close();
            sessions.delete(frame.channelId);
            pending.delete(frame.channelId);
            return;
          }
          case "bye": {
            // The one place a refusal is distinguished from a network failure.
            // Retrying a revocation forever would hammer the hub with a
            // credential that is never coming back.
            const retry = isRelayGoodbyeRetryable(frame.reason);
            if (!retry) {
              setState("refused", frame.message);
            }
            // Settled *before* the socket is closed, and the order is the whole
            // point: closing fires the `close` handler, which would otherwise
            // settle this connection first — as an ordinary drop, worth
            // retrying — and the deliberate refusal would be silently
            // downgraded into a reconnect loop against a dead credential.
            finish(retry, frame.message);
            try {
              current.close(1000, frame.reason);
            } catch {
              // Already closing.
            }
            return;
          }
          default:
            return;
        }
      });

      current.addEventListener("error", () => {
        options.onError?.("The relay connection failed.");
      });

      current.addEventListener("close", () => {
        finish(true, null);
      });
    });
  };

  const run = async () => {
    while (running) {
      const outcome = await runOneConnection();
      socket = null;
      if (!running) {
        break;
      }
      if (!outcome.retry) {
        running = false;
        setState("refused", outcome.detail);
        break;
      }

      // A connection that worked and then dropped starts the backoff over. It
      // is evidence the hub is reachable, and making a laptop that lost wifi
      // for a moment wait thirty seconds would be punishing it for the last
      // outage rather than this one.
      failedAttempts = outcome.connected ? 0 : failedAttempts + 1;
      const delayMs = spreadRelayDialDelayMs(
        relayDialDelayMs(failedAttempts, options.backoff),
        random(),
      );
      setState("waiting", `Reconnecting in ${Math.round(delayMs / 100) / 10}s.`);
      await new Promise<void>((resolve) => {
        wakeFromBackoff = resolve;
        void sleep(delayMs).then(() => resolve());
      });
      wakeFromBackoff = null;
    }
    if (state !== "refused") {
      setState("stopped");
    }
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      failedAttempts = 0;
      loop = run();
    },
    stop: async () => {
      running = false;
      try {
        socket?.close(1000, "stopping");
      } catch {
        // Already closed.
      }
      // Wake the loop if it is waiting out a backoff, so `await loop` below
      // returns now rather than whenever that wait happened to end.
      wakeFromBackoff?.();
      await loop;
    },
    state: () => state,
    failedAttempts: () => failedAttempts,
  };
}

/**
 * Serves a relayed browser by opening a socket to this server's own `/ws`.
 *
 * The relay therefore reuses every RPC handler that already exists rather than
 * reimplementing the protocol, which is the difference between a transport and
 * a fork.
 *
 * Note what this means and does not: the hub decides *who* may attach — only
 * the account the environment is bound to — and this end serves whoever the hub
 * lets through, with whatever credential `localWebSocketUrl` mints. That is a
 * real trust statement about the hub and it is stated here rather than buried:
 * a compromised hub can reach any environment dialled into it. A relay cannot
 * be built without that property, and the alternative — the environment
 * re-verifying a browser session it has no way to check — would be a second
 * identity system, which is the thing this feature is explicitly not to build.
 */
export function createLoopbackRelaySessionFactory(input: {
  readonly localWebSocketUrl: () => Promise<string>;
  readonly connect: (url: string) => RelaySocketLike;
}): RelayLocalSessionFactory {
  return async (handlers) => {
    const url = await input.localWebSocketUrl();
    const socket = input.connect(url);
    const queued: Array<string> = [];
    let open = false;

    socket.addEventListener("open", () => {
      open = true;
      for (const payload of queued.splice(0)) {
        socket.send(payload);
      }
    });
    socket.addEventListener("message", (event) => {
      handlers.onData(
        typeof event.data === "string"
          ? event.data
          : event.data instanceof Uint8Array
            ? new TextDecoder().decode(event.data)
            : String(event.data),
      );
    });
    socket.addEventListener("close", () => {
      handlers.onClose();
    });
    socket.addEventListener("error", () => {
      handlers.onClose();
    });

    return {
      send: (payload) => {
        // Queued until the local socket is up. The browser's first frame is its
        // RPC handshake and dropping it leaves an open, mute connection.
        if (open) {
          socket.send(payload);
        } else {
          queued.push(payload);
        }
      },
      close: () => {
        try {
          socket.close(1000, "relay channel closed");
        } catch {
          // Already closed.
        }
      },
    };
  };
}
