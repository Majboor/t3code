/**
 * Which way the browser should reach a saved environment.
 *
 * There are two now, and they are good at different things.
 *
 * *Direct* is the browser dialling the environment's own address. It is the
 * faster of the two — no third machine in the path — and it is what a LAN or
 * loopback environment should always use. Putting a relay in the middle of a
 * connection to a box on the same desk is pure cost and one more thing that can
 * be down. It is also the only transport that exists today, and nothing here
 * changes how it behaves.
 *
 * *Relayed* is the browser reaching the environment back down a connection the
 * environment itself opened to the hub. It is slower, and it is the only one
 * that works at all when the machine has no public address — which is the
 * ordinary case, and the reason this exists: the alternative was a Cloudflare
 * quick tunnel whose URL changed on every restart, so every saved environment
 * died when a laptop rebooted.
 *
 * Pure and total. The choice depends on a probe of the direct address, and the
 * probe is an *input* rather than something this module performs, so the rules
 * can be stated once and tested without a network — the same reason
 * `filePresence.ts` takes `nowMs`.
 *
 * @module EnvironmentRelay
 */

/** The environment's own address, when it has one worth trying. */
export interface DirectEnvironmentTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * Where to reach a relayed environment: the hub, plus the name to ask it for.
 *
 * There is no address for the environment here and there cannot be one — the
 * whole premise is that it does not have one.
 */
export interface RelayEnvironmentTarget {
  readonly hubHttpBaseUrl: string;
  readonly environmentId: string;
}

/**
 * What a probe of the direct address found.
 *
 * `unknown` is a real answer and not a placeholder: on a first connection there
 * has been no probe yet, and treating that as "unreachable" would send a LAN
 * environment through a relay for its whole first session.
 */
export type DirectReachability = "reachable" | "unreachable" | "unknown";

export type EnvironmentTransport = "direct" | "relayed";

export type EnvironmentTransportReason =
  /** Only one of the two exists. */
  | "only-transport"
  /** Both exist, and the environment answered on its own address. */
  | "direct-reachable"
  /** Both exist, the direct address did not answer, and the relay is up. */
  | "direct-unreachable"
  /**
   * Both exist and nothing has been probed yet. Direct is tried first, because
   * the probe *is* the attempt and a relay would make it never happen.
   */
  | "direct-untried";

export type ChooseEnvironmentTransportResult =
  | {
      readonly outcome: "connect";
      readonly transport: EnvironmentTransport;
      readonly reason: EnvironmentTransportReason;
    }
  /** No address and no relay. There is nothing to connect to. */
  | { readonly outcome: "unreachable" };

/**
 * The whole rule, stated once.
 *
 * Direct wins every tie, and the ties are the interesting part. When both
 * transports are on offer and nothing is known about the direct one, direct is
 * still chosen — trying it is how anything is ever learned about it, and a
 * preference that only applies once a probe has succeeded is a preference that
 * never applies.
 *
 * The relay is only reached for when direct is known to have failed, or when
 * there is no direct address at all, which is the case this feature was built
 * for.
 */
export function chooseEnvironmentTransport(input: {
  readonly direct: DirectEnvironmentTarget | null;
  readonly relay: RelayEnvironmentTarget | null;
  readonly directReachability: DirectReachability;
}): ChooseEnvironmentTransportResult {
  const { direct, relay, directReachability } = input;

  if (direct === null && relay === null) {
    return { outcome: "unreachable" };
  }
  if (relay === null) {
    return { outcome: "connect", transport: "direct", reason: "only-transport" };
  }
  if (direct === null) {
    return { outcome: "connect", transport: "relayed", reason: "only-transport" };
  }

  switch (directReachability) {
    case "reachable":
      return { outcome: "connect", transport: "direct", reason: "direct-reachable" };
    case "unreachable":
      return { outcome: "connect", transport: "relayed", reason: "direct-unreachable" };
    case "unknown":
      return { outcome: "connect", transport: "direct", reason: "direct-untried" };
  }
}

/**
 * Where a relayed browser connection points.
 *
 * The path carries the environment name, so the hub knows which of its open
 * outbound connections this browser is asking for. The websocket token is
 * appended later by `resolveRemoteWebSocketConnectionUrl`, the same way it is
 * for a direct connection — a relayed browser authenticates to the *hub* with
 * its ordinary session and there is no second credential anywhere in this.
 */
export function relayAttachWsBaseUrl(target: RelayEnvironmentTarget): string {
  const url = new URL(
    `/api/environments/relay/attach/${encodeURIComponent(target.environmentId)}`,
    target.hubHttpBaseUrl,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Whether a websocket URL is a relayed one.
 *
 * Used by the transport layer, which otherwise forces every socket onto `/ws`.
 * Matching on the path rather than carrying a flag keeps the check where the
 * URL is, so a URL that travels through persistence cannot lose its meaning on
 * the way.
 */
export const RELAY_ATTACH_PATH_PREFIX = "/api/environments/relay/attach/";

export function isRelayAttachWsUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname.startsWith(RELAY_ATTACH_PATH_PREFIX);
  } catch {
    return false;
  }
}

/** What to tell a person about the path their traffic is taking. */
export function describeEnvironmentTransport(transport: EnvironmentTransport): {
  readonly label: string;
  readonly detail: string;
} {
  return transport === "direct"
    ? {
        label: "Direct",
        detail: "Connected straight to this environment's own address.",
      }
    : {
        label: "Relayed",
        detail: "Reached through the hub, over a connection this environment opened itself.",
      };
}
