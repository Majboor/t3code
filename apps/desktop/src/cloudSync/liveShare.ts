import {
  CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS,
  isSafeCloudSyncCopyUrl,
  type DesktopWorkspaceShareState,
} from "@t3tools/contracts";

/**
 * Sharing a project without making anyone wait for the first pass.
 *
 * Sharing starts two things at once: the upload to the cloud, and a Cloudflare
 * quick tunnel publishing this laptop's own copy. This coordinates the second
 * one against the first, and every decision in it comes from the same sentence
 * in `docs/cloud-sync-spec.md`: **the link handed out is always the cloud URL,
 * never the tunnel's**. A quick tunnel's address changes on every restart and
 * dies with the laptop, so a link built on it is dead tomorrow in somebody
 * else's inbox — which is worse than making them wait.
 *
 * Nothing here can stop a sync. If `cloudflared` is missing, or the tunnel's own
 * preflight refuses to publish a server that would hand a visitor an owner
 * session, the sync goes ahead without a live copy and the state below says so
 * in as many words. The live link is an accelerator; the upload is the feature.
 *
 * The tunnel is never started by this file. It asks a controller that already
 * owns the single `cloudflared` child and already refuses to publish an
 * auto-issuing auth policy — that gate is load-bearing here, not incidental, and
 * duplicating a tunnel launcher beside it would be a second way to publish this
 * machine with only one of them checked.
 */

/**
 * How often the tunnel's state is re-read while it is still coming up.
 *
 * A quick tunnel takes a few seconds to publish its hostname, and the whole
 * point of this feature is that a visitor is not left watching a bar. Polling at
 * the heartbeat interval instead would leave a live tunnel unregistered — and so
 * unoffered — for most of a minute after it was ready.
 */
const STARTUP_POLL_MS = 1_000;

/**
 * How long the tunnel is kept alive after the first pass completes.
 *
 * Long enough for a visitor sitting on the live copy to make one more request
 * and be redirected home; short enough that the public door into this laptop
 * closes while the person who opened it is still at their desk. Nobody new is
 * sent here during it: the registration is withdrawn first, so the cloud stops
 * offering this address the moment it stops being the fastest answer.
 */
const HANDOFF_GRACE_MS = 30_000;

export type LiveSharePhase =
  /** Not sharing, or finished. */
  | "off"
  /** The tunnel is coming up; the sync is already running. */
  | "starting"
  /** A live copy is published and registered with the cloud. */
  | "live"
  /** Syncing with no live copy, and `reason` says why. Not a failure of the share. */
  | "no-live-copy"
  /** The first pass completed; visitors have been handed over to the cloud copy. */
  | "handed-off";

export interface LiveShareState {
  readonly phase: LiveSharePhase;
  /** The tunnel address. Never handed to a person: it is transport, not identity. */
  readonly url: string | null;
  /** Why there is no live copy, in words a person can act on. */
  readonly reason: string | null;
  /**
   * Always true, and stated rather than implied. Every failure in this file is
   * a slower share and never a stopped one, and a UI reading this state should
   * not have to infer that from the absence of an error.
   */
  readonly syncProceeds: true;
  /** The last heartbeat the cloud accepted. Null until one has landed. */
  readonly lastRegisteredAt: string | null;
  /** The last heartbeat that failed, kept so a share that has gone quiet can say so. */
  readonly lastRegistrationError: string | null;
}

export interface LiveShareTunnel {
  start: (port: number) => Promise<DesktopWorkspaceShareState>;
  stop: () => DesktopWorkspaceShareState;
  getState: () => DesktopWorkspaceShareState;
}

export interface LiveShareRegistrar {
  /**
   * "A live copy is at <url>", or with null, "I am still here and have nothing
   * to publish". The second is not a no-op: it is what tells the cloud that a
   * sync with no tunnel is still running, rather than that the laptop closed.
   */
  registerLiveCopy: (url: string | null) => Promise<void>;
  /**
   * Tells this laptop's own server that the cloud copy is canonical now, so a
   * visitor still on the tunnel is sent home rather than left on a copy that has
   * stopped being the real one.
   */
  registerHandoff: () => Promise<void>;
}

export interface LiveShareCoordinatorOptions {
  readonly tunnel: LiveShareTunnel;
  readonly registrar: LiveShareRegistrar;
  readonly onStateChange?: (state: LiveShareState) => void;
  readonly heartbeatMs?: number;
  readonly startupPollMs?: number;
  readonly handoffGraceMs?: number;
  readonly now?: () => Date;
}

function initialState(): LiveShareState {
  return {
    phase: "off",
    url: null,
    reason: null,
    syncProceeds: true,
    lastRegisteredAt: null,
    lastRegistrationError: null,
  };
}

/** What the tunnel's own vocabulary means to somebody waiting for a link. */
function describeTunnel(state: DesktopWorkspaceShareState): string {
  return (
    state.failureReason ??
    "A live copy could not be published, so this project is only reachable once the upload finishes."
  );
}

/**
 * Runs the tunnel beside a sync: start it, keep its address registered while it
 * lives, and hand visitors over to the cloud when the first pass completes.
 */
export class LiveShareCoordinator {
  private state: LiveShareState = initialState();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private beat = 0;
  private readonly tunnel: LiveShareTunnel;
  private readonly registrar: LiveShareRegistrar;
  private readonly onStateChange: ((state: LiveShareState) => void) | undefined;
  private readonly heartbeatMs: number;
  private readonly startupPollMs: number;
  private readonly handoffGraceMs: number;
  private readonly now: () => Date;

  constructor(options: LiveShareCoordinatorOptions) {
    this.tunnel = options.tunnel;
    this.registrar = options.registrar;
    this.onStateChange = options.onStateChange;
    this.heartbeatMs = options.heartbeatMs ?? CLOUD_SYNC_LIVE_COPY_HEARTBEAT_MS;
    this.startupPollMs = options.startupPollMs ?? STARTUP_POLL_MS;
    this.handoffGraceMs = options.handoffGraceMs ?? HANDOFF_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  getState(): LiveShareState {
    return this.state;
  }

  /**
   * Called when a sync starts in the default mode. Returns as soon as the tunnel
   * has been asked for — the caller is starting an upload and must not be made
   * to wait on `cloudflared`.
   */
  async begin(port: number): Promise<LiveShareState> {
    // Read into a local: every line below goes through `setState`, and a
    // narrowing taken from the field would survive those writes and quietly
    // describe a state this method has already left.
    const phase: LiveSharePhase = this.state.phase;
    if (phase !== "off") {
      return this.state;
    }

    this.setState({ ...initialState(), phase: "starting" });
    // Before anything else, and whatever the tunnel does next: this is the
    // heartbeat that tells the cloud a laptop is behind this sync. Without it a
    // share whose tunnel never starts is indistinguishable from a laptop that
    // closed, and the two get opposite advice.
    await this.heartbeat(null);

    let started: DesktopWorkspaceShareState;
    try {
      started = await this.tunnel.start(port);
    } catch (error) {
      this.settleWithoutLiveCopy(error instanceof Error ? error.message : String(error));
      this.schedule(this.heartbeatMs);
      return this.state;
    }

    this.applyTunnelState(started);
    // Registered the moment it is known rather than on the next beat: the whole
    // promise of this feature is that a link works immediately.
    if (this.state.url !== null) {
      await this.heartbeat(this.state.url);
    }
    this.schedule(this.state.phase === "starting" ? this.startupPollMs : this.heartbeatMs);
    return this.state;
  }

  /**
   * The first pass has completed. The cloud copy is canonical from here, so
   * anyone still on the tunnel is handed over and the tunnel is stopped.
   *
   * The handoff is registered *before* the tunnel is withdrawn and long before
   * it is stopped, because the redirect it enables is served by this laptop. If
   * the tunnel is already dead none of this matters: every link that was handed
   * out was the cloud URL, so the visitors it would have caught are the ones who
   * clicked through in this session, and they can go back to the address they
   * arrived from. The redirect is the courtesy, not the mechanism.
   */
  async firstPassComplete(): Promise<LiveShareState> {
    if (this.state.phase === "off" || this.state.phase === "handed-off") {
      return this.state;
    }

    this.clearTimer();
    await this.attempt(() => this.registrar.registerHandoff());
    // Withdraw before stopping, so nobody new is offered an address that is
    // about to stop answering.
    await this.heartbeat(null);
    this.setState({ ...this.state, phase: "handed-off", url: null, reason: null });

    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      this.tunnel.stop();
    }, this.handoffGraceMs);
    this.handoffTimer.unref?.();

    return this.state;
  }

  /** Sharing stopped, or the app is going away. Idempotent, like the tunnel's own stop. */
  async stop(): Promise<LiveShareState> {
    this.clearTimer();
    if (this.handoffTimer !== null) {
      clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
    }
    const wasSharing = this.state.phase !== "off";
    this.tunnel.stop();
    if (wasSharing) {
      // Best effort, and a failure changes nothing: an address nobody withdrew
      // goes stale on its own within the staleness window, which is exactly
      // what that window is for.
      await this.attempt(() => this.registrar.registerLiveCopy(null));
    }
    this.setState(initialState());
    return this.state;
  }

  private async tick(): Promise<void> {
    if (this.state.phase === "off" || this.state.phase === "handed-off") {
      return;
    }
    this.applyTunnelState(this.tunnel.getState());
    await this.heartbeat(this.state.url);
    this.schedule(this.state.phase === "starting" ? this.startupPollMs : this.heartbeatMs);
  }

  private applyTunnelState(tunnelState: DesktopWorkspaceShareState): void {
    switch (tunnelState.status) {
      case "live": {
        // A URL that would be refused by the cloud is treated as no URL at all,
        // rather than sent and rejected once every heartbeat.
        if (tunnelState.url === null || !isSafeCloudSyncCopyUrl(tunnelState.url)) {
          this.settleWithoutLiveCopy(
            "The tunnel published an address this build will not hand to a visitor.",
          );
          return;
        }
        this.setState({ ...this.state, phase: "live", url: tunnelState.url, reason: null });
        return;
      }
      case "starting": {
        this.setState({ ...this.state, phase: "starting", url: null, reason: null });
        return;
      }
      case "unavailable":
      case "failed":
      case "stopping":
      case "not-shared": {
        this.settleWithoutLiveCopy(describeTunnel(tunnelState));
        return;
      }
    }
  }

  private settleWithoutLiveCopy(reason: string): void {
    if (this.state.phase === "handed-off" || this.state.phase === "off") {
      return;
    }
    this.setState({ ...this.state, phase: "no-live-copy", url: null, reason });
  }

  private async heartbeat(url: string | null): Promise<void> {
    const failure = await this.attempt(() => this.registrar.registerLiveCopy(url));
    if (failure === null) {
      this.setState({ ...this.state, lastRegisteredAt: this.now().toISOString() });
    }
  }

  /** Returns the failure message, or null on success. Nothing here ever throws. */
  private async attempt(action: () => Promise<void>): Promise<string | null> {
    try {
      await action();
      if (this.state.lastRegistrationError !== null) {
        this.setState({ ...this.state, lastRegistrationError: null });
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ ...this.state, lastRegistrationError: message });
      return message;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.state.phase === "off" || this.state.phase === "handed-off") {
      return;
    }
    const beat = ++this.beat;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (beat !== this.beat) return;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    this.beat += 1;
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(next: LiveShareState): void {
    this.state = next;
    this.onStateChange?.(next);
  }
}

export interface HttpLiveShareRegistrarOptions {
  /** Where the cloud copy lives: the origin the sync itself is talking to. */
  readonly cloudBaseUrl: string;
  /** This laptop's own server, which is what the tunnel publishes. */
  readonly localBaseUrl: string;
  /** The project being shared, exactly as the sync names it. */
  readonly scope: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly projectId: string;
  };
  /** The member's session, from whoever started the sync. */
  readonly authorization: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * The two calls this coordinator makes, over HTTP.
 *
 * They go to different servers on purpose, and that is the shape of the whole
 * handoff: the live copy is registered *with the cloud*, so it can offer a
 * faster route while it fills in; the handoff is registered *with this laptop*,
 * so the machine the tunnel published is the one that can send a visitor home.
 */
export function createHttpLiveShareRegistrar(
  options: HttpLiveShareRegistrarOptions,
): LiveShareRegistrar {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.authorization === null ? {} : { authorization: options.authorization }),
  };

  const post = async (baseUrl: string, path: string, body: unknown): Promise<void> => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path} was refused with ${response.status}.`);
    }
  };

  return {
    registerLiveCopy: (url) =>
      post(options.cloudBaseUrl, "/api/cloud-sync/live-copy", { ...options.scope, url }),
    registerHandoff: () =>
      post(options.localBaseUrl, "/api/cloud-sync/handoff", {
        ...options.scope,
        // The address the link always pointed at. Built from the origin the
        // sync uploads to, so it cannot drift from where the copy actually
        // ends up.
        canonicalUrl: new URL(
          `/projects/${encodeURIComponent(options.scope.projectId)}`,
          options.cloudBaseUrl,
        ).toString(),
      }),
  };
}

/**
 * The check `main.ts` runs before it will post anything anywhere on a
 * renderer's say-so. Two ordinary URLs, and the cloud one has to be an address
 * a visitor could be redirected to.
 */
export function isUsableLiveShareEndpoint(candidate: unknown): candidate is string {
  return typeof candidate === "string" && isSafeCloudSyncCopyUrl(candidate);
}
