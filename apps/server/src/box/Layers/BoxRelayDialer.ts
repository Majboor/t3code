/**
 * Turning a server into a box: dial the hub, and answer what comes back.
 *
 * `createEnvironmentDialer` was complete and tested and had no callers, because
 * it needs one thing nothing could supply — an address. This is where the
 * address arrives (`--hub` / `T3CODE_HUB_URL`) and where everything else the
 * dialer needs is assembled: the machine's own name, the credential it
 * authenticates with, and the thing that answers `box/1` on the far end of each
 * channel.
 *
 * **Absent hub, absent behaviour.** With no hub configured this layer builds
 * nothing and starts nothing, and a server reached directly is untouched — no
 * outbound socket, no background fiber, not even a log line. That is the point
 * of making it configuration rather than a mode: a relay in the middle of a
 * connection to a machine on the same desk is pure cost and one more thing that
 * can be down, and `chooseEnvironmentTransport` already prefers direct wherever
 * there is a direct address to try.
 *
 * The credential is a hub session token, kept in this machine's secret store
 * under `hub-session-token` and re-minted into a short-lived websocket token on
 * every dial. It is deliberately *not* a second identity: it is the credential
 * device enrollment already issued to this machine, so revoking the machine in
 * the browser cuts this connection through
 * `dropRelayConnectionsForAuthSession`, and there is nothing else to revoke.
 *
 * @module Box
 */

import * as Path from "node:path";

import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { ServiceRegistry } from "../../environment/Services/ServiceRegistry.ts";
import { createEnvironmentDialer, type RelaySocketLike } from "../../environmentRelay/dialer.ts";
import { EnvironmentServiceRepository } from "../../persistence/Services/EnvironmentServices.ts";
import { createBoxResponder } from "../boxResponder.ts";
import { createNodeBoxMachine } from "../nodeBoxMachine.ts";
import { createBoxRelaySessionFactory } from "../relaySession.ts";

/**
 * Where this machine keeps the credential the hub issued it.
 *
 * A name in the existing secret store rather than a new file or a new config
 * field, because `t3 secret set` already puts things there with the right
 * permissions and `t3 secret list` already answers "is this box configured".
 */
export const HUB_SESSION_TOKEN_SECRET = "hub-session-token";

/** Where a detached start's captured output lives, under the usual logs dir. */
const BOX_LOG_SUBDIRECTORY = "box";

/**
 * Trades this machine's hub session for a short-lived websocket token.
 *
 * Minted against the hub every time, because the token is signed by the hub's
 * own secret and lives about five minutes: a laptop that reconnects after a
 * week of sleep would otherwise present one that expired six days ago. A
 * failure here is almost always the hub being unreachable, which is exactly the
 * case the dialer must retry rather than treat as a rejection — so this throws
 * and lets the backoff have it.
 */
async function mintHubWebSocketToken(input: {
  readonly hubBaseUrl: string;
  readonly sessionToken: string;
}): Promise<string> {
  const url = new URL("/api/auth/ws-token", input.hubBaseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.sessionToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    throw new Error(
      `The hub would not issue a connection token (${response.status}). The credential in \`${HUB_SESSION_TOKEN_SECRET}\` may have been revoked.`,
    );
  }

  const payload = (await response.json()) as {
    readonly token?: unknown;
    readonly wsToken?: unknown;
  };
  const token = typeof payload.token === "string" ? payload.token : payload.wsToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("The hub issued a connection token this build cannot read.");
  }
  return token;
}

const makeBoxRelayDialer = Effect.gen(function* () {
  const config = yield* ServerConfig;
  if (config.hubUrl === undefined) {
    return;
  }

  const environment = yield* ServerEnvironment;
  const secrets = yield* ServerSecretStore;
  const registry = yield* ServiceRegistry;
  const services = yield* EnvironmentServiceRepository;
  const descriptor = yield* environment.getDescriptor;
  /**
   * The services this layer was built with, kept so the dialer's plain
   * callbacks can log and read secrets against the same runtime rather than
   * spinning up a fresh one per call.
   */
  const runtimeServices = yield* Effect.context<never>();
  const runSync = Effect.runSyncWith(runtimeServices);
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const hubBaseUrl = config.hubUrl.toString();

  const machine = createNodeBoxMachine({
    registry,
    services,
    environmentId: descriptor.environmentId,
    logDirectory: Path.join(config.logsDir, BOX_LOG_SUBDIRECTORY),
    workingDirectory: config.cwd,
  });

  /**
   * What this box says when the hub asks how it is.
   *
   * Three honest states and no synthetic probe. The hub's health rule exists to
   * reject a cached "ready" from startup, and the answer here is not cached —
   * it is read at the moment of asking from what this process is actually
   * doing. What it deliberately does not do is go and check the machine on
   * every heartbeat: the only cheap check available is a SQLite read, the
   * expensive one shells out to `lsof` every fifteen seconds, and neither
   * answers the question a box is actually asked. A box that cannot run a
   * command says so in the command's own reply, where the caller can act on it.
   */
  const health = { state: "starting" as "starting" | "ready" | "stopping" };

  const respond = createBoxResponder(machine);

  const dialer = createEnvironmentDialer({
    hubBaseUrl,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    issueWebSocketToken: async () => {
      const stored = await runPromise(
        secrets
          .get(HUB_SESSION_TOKEN_SECRET)
          .pipe(Effect.catch(() => Effect.succeed(null as Uint8Array | null))),
      );
      if (stored === null || stored.byteLength === 0) {
        throw new Error(
          `No hub credential is stored here. Enroll this machine and put the session token in \`${HUB_SESSION_TOKEN_SECRET}\` with \`t3 secret set\`.`,
        );
      }
      return mintHubWebSocketToken({
        hubBaseUrl,
        sessionToken: new TextDecoder().decode(stored).trim(),
      });
    },
    reportHealth: () => ({ state: health.state, detail: null }),
    openLocalSession: createBoxRelaySessionFactory({
      respond,
      // No fallback on purpose. A box is not a workspace — it holds no
      // projects and runs no turns — so there is nothing here for a browser to
      // attach to, and opening a loopback RPC session for one would be
      // inventing a workspace on a machine that must never have one.
      onError: (message) => {
        runSync(Effect.logWarning(`box relay: ${message}`));
      },
    }),
    connect: (url) => new WebSocket(url) as unknown as RelaySocketLike,
    onStateChange: (state, detail) => {
      runSync(
        Effect.logInfo(`box relay ${state}${detail === null ? "" : `: ${detail}`}`, {
          hub: hubBaseUrl,
          environmentId: descriptor.environmentId,
        }),
      );
    },
    onError: (message) => {
      runSync(Effect.logWarning(`box relay: ${message}`));
    },
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      health.state = "ready";
      dialer.start();
    }),
    () =>
      Effect.promise(async () => {
        // Said before the socket goes, so a hub that is mid-heartbeat learns
        // this was deliberate rather than watching a connection vanish.
        health.state = "stopping";
        await dialer.stop();
      }),
  );
});

/**
 * Holds the outbound connection open for as long as the server runs.
 *
 * Produces nothing, which is correct: nothing in the server asks for a dialer,
 * and a service tag would invite something to. Its whole effect is on the wire.
 */
export const BoxRelayDialerLive: Layer.Layer<
  never,
  never,
  | ServerConfig
  | ServerEnvironment
  | ServerSecretStore
  | ServiceRegistry
  | EnvironmentServiceRepository
> = Layer.effectDiscard(makeBoxRelayDialer);
