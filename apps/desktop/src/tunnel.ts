import * as ChildProcess from "node:child_process";

import type {
  DesktopWorkspaceShareState,
  DesktopWorkspaceShareStatus,
  ServerAuthPolicy,
} from "@t3tools/contracts";

/**
 * Cloudflare quick tunnel that publishes the desktop app's local server.
 *
 * SECURITY: the tunnel terminates at Cloudflare and forwards to 127.0.0.1, so the
 * server sees every stranger as a loopback peer. Any "it came from localhost, so it
 * must be this user" assumption therefore applies to the whole internet while a
 * tunnel is live. Peer addresses are logged as 127.0.0.1 through the tunnel too, so
 * a tunnelled session shows up in the Connections list looking like a local device.
 *
 * Two server auth policies carry exactly that assumption: `loopback-browser` (a CLI
 * `t3 serve`) and `unsafe-no-auth` (`--unsafe-no-auth` or basic-auth env vars).
 * Under either of them `GET /api/auth/session` hands a full owner session — shell,
 * PTYs, filesystem, git, provider credentials — to whoever opens the URL. So this
 * controller asks the server which policy it is running before it spawns anything,
 * and refuses to publish an auto-issuing one. Refusing is the right trade: a
 * running cloudflared is much harder to take back than an error message.
 *
 * The server has its own defence (it will not auto-issue when it knows it is
 * published, or when a request arrives carrying proxy headers), but that one is
 * a backstop. This refusal is the guard rail, because it is the only layer that
 * knows a tunnel is about to exist.
 *
 * Deliberately left open: `/.well-known/t3/environment` stays unauthenticated
 * while a tunnel is live, so anyone holding the URL can read the workspace folder
 * name, the OS, the CPU architecture, and the server version. That endpoint has to
 * answer before a client can know how to authenticate, so it cannot be gated
 * without breaking pairing. It is an information leak to a URL-holder, not a way in.
 */
export const CLOUDFLARED_BINARY = "cloudflared";

/**
 * cloudflared only announces the public hostname once, in its startup banner, and
 * different builds put that banner on stdout or stderr. Both streams are merged
 * before matching so a version change cannot silently break URL discovery.
 */
const QUICK_TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;

/**
 * `api.trycloudflare.com` is the control-plane endpoint cloudflared talks to while
 * requesting a tunnel; it shows up in ordinary and failed-request logs and is never
 * the user's public URL.
 */
const QUICK_TUNNEL_RESERVED_SUBDOMAINS = new Set(["api", "www"]);

const DEFAULT_URL_TIMEOUT_MS = 25_000;
const MAX_DIAGNOSTIC_CHARS = 8_192;
const AVAILABILITY_PROBE_TIMEOUT_MS = 5_000;
const STOP_FORCE_KILL_DELAY_MS = 2_000;
const AUTH_POLICY_PROBE_TIMEOUT_MS = 5_000;

/**
 * The policies under which the server treats "the socket says 127.0.0.1" as proof
 * of identity and mints an owner session on request. Publishing one of these is
 * publishing an unauthenticated takeover.
 */
export const AUTO_ISSUING_AUTH_POLICIES: ReadonlySet<ServerAuthPolicy> = new Set([
  "loopback-browser",
  "unsafe-no-auth",
]);

/** Guards the untyped probe response; an unrecognised policy is treated as unknown. */
const KNOWN_AUTH_POLICIES: ReadonlySet<string> = new Set<ServerAuthPolicy>([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);

export type WorkspaceSharePreflight =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Decides whether a server running this auth policy may be published at all.
 *
 * An unknown policy is refused rather than allowed. The cost of being wrong in
 * one direction is a share that does not start; in the other it is a stranger
 * with a shell on this laptop.
 */
export function evaluateWorkspaceSharePreflight(
  policy: ServerAuthPolicy | null,
): WorkspaceSharePreflight {
  if (policy === null) {
    return {
      allowed: false,
      reason:
        "Could not read this server's authentication policy, so sharing stopped rather than risk publishing a server that hands full access to anyone with the link. Make sure the server is running, then try again.",
    };
  }

  if (policy === "loopback-browser") {
    return {
      allowed: false,
      reason:
        "This server gives full owner access to anything that reaches it from this machine, and a tunnel makes every visitor look like this machine. Turn on network access in Settings so the server asks visitors to pair first, then share again.",
    };
  }

  if (policy === "unsafe-no-auth") {
    return {
      allowed: false,
      reason:
        "This server was started with authentication turned off (--unsafe-no-auth, or the basic-auth environment variables), so anyone with the link would get full access to this computer. Restart it without those options, turn on network access in Settings, then share again.",
    };
  }

  return { allowed: true };
}

/**
 * Asks the local server which auth policy it is running.
 *
 * The `x-t3-auth-entry-path` header makes the session route report its state
 * without minting a session, so checking whether the server auto-issues owner
 * sessions cannot itself cause one to be issued.
 */
export async function probeServerAuthPolicy(
  port: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ServerAuthPolicy | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_POLICY_PROBE_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/auth/session`, {
      headers: { "x-t3-auth-entry-path": "/pair" },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const policy = (body as { readonly auth?: { readonly policy?: unknown } })?.auth?.policy;
    return typeof policy === "string" && KNOWN_AUTH_POLICIES.has(policy)
      ? (policy as ServerAuthPolicy)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createWorkspaceShareState(): DesktopWorkspaceShareState {
  return { status: "not-shared", url: null, failureReason: null, diagnostics: null };
}

export function canStartWorkspaceShare(status: DesktopWorkspaceShareStatus): boolean {
  return status === "not-shared" || status === "failed" || status === "unavailable";
}

export function canStopWorkspaceShare(status: DesktopWorkspaceShareStatus): boolean {
  return status === "starting" || status === "live";
}

export function reduceWorkspaceShareOnStartRequested(
  state: DesktopWorkspaceShareState,
): DesktopWorkspaceShareState {
  if (!canStartWorkspaceShare(state.status)) return state;
  return { status: "starting", url: null, failureReason: null, diagnostics: null };
}

export function reduceWorkspaceShareOnUrlDetected(
  state: DesktopWorkspaceShareState,
  url: string,
): DesktopWorkspaceShareState {
  // A URL can still arrive after the user asked to stop; honouring it would hand
  // back a live link for a tunnel that is already being torn down.
  if (state.status !== "starting") return state;
  return { status: "live", url, failureReason: null, diagnostics: null };
}

export function reduceWorkspaceShareOnFailure(
  state: DesktopWorkspaceShareState,
  reason: string,
  diagnostics: string | null = null,
): DesktopWorkspaceShareState {
  // A process exiting during teardown is the teardown succeeding, not a failure.
  if (state.status === "stopping" || state.status === "not-shared") {
    return createWorkspaceShareState();
  }
  return { status: "failed", url: null, failureReason: reason, diagnostics };
}

export function reduceWorkspaceShareOnUnavailable(
  _state: DesktopWorkspaceShareState,
  reason: string,
): DesktopWorkspaceShareState {
  return { status: "unavailable", url: null, failureReason: reason, diagnostics: null };
}

export function reduceWorkspaceShareOnStopRequested(
  state: DesktopWorkspaceShareState,
): DesktopWorkspaceShareState {
  if (!canStopWorkspaceShare(state.status)) {
    // Stopping from a terminal state is a no-op that also clears stale error text,
    // which keeps the stop path safe to call repeatedly (including on quit).
    return createWorkspaceShareState();
  }
  return { status: "stopping", url: null, failureReason: null, diagnostics: null };
}

export function reduceWorkspaceShareOnStopped(
  _state: DesktopWorkspaceShareState,
): DesktopWorkspaceShareState {
  return createWorkspaceShareState();
}

export function parseQuickTunnelUrl(output: string): string | null {
  QUICK_TUNNEL_URL_PATTERN.lastIndex = 0;
  for (const match of output.matchAll(QUICK_TUNNEL_URL_PATTERN)) {
    const url = match[0].toLowerCase();
    const subdomain = url.slice("https://".length, url.indexOf(".trycloudflare.com"));
    if (QUICK_TUNNEL_RESERVED_SUBDOMAINS.has(subdomain)) continue;
    return url;
  }
  return null;
}

export function buildQuickTunnelArgs(port: number): readonly string[] {
  // `--config /dev/null` keeps a user's named-tunnel config from hijacking the quick
  // tunnel, and `--no-autoupdate` stops cloudflared restarting itself mid-session.
  return [
    "--config",
    "/dev/null",
    "--no-autoupdate",
    "tunnel",
    "--url",
    `http://127.0.0.1:${port}`,
  ];
}

export interface CloudflaredVersionProbe {
  readonly spawnError?: { readonly code?: string; readonly message: string } | null;
  readonly exitCode?: number | null;
  readonly stdout?: string;
}

export interface CloudflaredAvailability {
  readonly available: boolean;
  readonly version: string | null;
  readonly reason: string | null;
}

export function interpretCloudflaredVersionProbe(
  probe: CloudflaredVersionProbe,
): CloudflaredAvailability {
  if (probe.spawnError) {
    const reason =
      probe.spawnError.code === "ENOENT"
        ? "cloudflared was not found on this computer. Install it, then try sharing again."
        : `cloudflared could not be started: ${probe.spawnError.message}`;
    return { available: false, version: null, reason };
  }

  if (probe.exitCode !== 0) {
    return {
      available: false,
      version: null,
      reason: `cloudflared exited with code ${probe.exitCode ?? "null"} when asked for its version.`,
    };
  }

  return { available: true, version: parseCloudflaredVersion(probe.stdout ?? ""), reason: null };
}

export function parseCloudflaredVersion(stdout: string): string | null {
  // e.g. "cloudflared version 2024.8.2 (built 2024-08-15)"
  const match = /cloudflared version (\S+)/i.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * Accumulates cloudflared's merged output, yielding the public URL as soon as it
 * appears and retaining a bounded tail so a timeout can report what was actually
 * printed instead of an opaque "it did not work".
 */
export class QuickTunnelOutputCollector {
  private buffer = "";
  private url: string | null = null;

  push(chunk: unknown): string | null {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.buffer = `${this.buffer}${text}`;

    if (this.url === null) {
      this.url = parseQuickTunnelUrl(this.buffer);
    }

    if (this.buffer.length > MAX_DIAGNOSTIC_CHARS) {
      this.buffer = this.buffer.slice(-MAX_DIAGNOSTIC_CHARS);
    }

    return this.url;
  }

  getUrl(): string | null {
    return this.url;
  }

  getDiagnostics(): string {
    return this.buffer.trim();
  }
}

export function formatQuickTunnelTimeoutReason(timeoutMs: number): string {
  return `cloudflared did not publish a public URL within ${Math.round(timeoutMs / 1000)}s.`;
}

export async function probeCloudflaredAvailability(
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
): Promise<CloudflaredAvailability> {
  return new Promise<CloudflaredAvailability>((resolve) => {
    let settled = false;
    let stdout = "";

    const settle = (probe: CloudflaredVersionProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(interpretCloudflaredVersionProbe(probe));
    };

    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      settle({ spawnError: { message: "cloudflared did not respond to --version." } });
    }, AVAILABILITY_PROBE_TIMEOUT_MS);
    timer.unref?.();

    let child: ChildProcess.ChildProcess | null = null;
    try {
      child = spawn(CLOUDFLARED_BINARY, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      settle({ spawnError: toSpawnError(error) });
      return;
    }

    child.stdout?.on("data", (chunk: unknown) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.on("error", (error) => {
      settle({ spawnError: toSpawnError(error) });
    });
    child.on("exit", (code) => {
      settle({ exitCode: code, stdout });
    });
  });
}

function toSpawnError(error: unknown): { code?: string; message: string } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? { message: error.message } : { code, message: error.message };
}

export interface QuickTunnelControllerOptions {
  readonly spawn?: typeof ChildProcess.spawn;
  readonly urlTimeoutMs?: number;
  readonly onStateChange?: (state: DesktopWorkspaceShareState) => void;
  readonly probeAvailability?: () => Promise<CloudflaredAvailability>;
  readonly resolveServerAuthPolicy?: (port: number) => Promise<ServerAuthPolicy | null>;
}

/**
 * Owns the single cloudflared child process backing "share this workspace".
 *
 * The controller is deliberately the only holder of the child handle: a leaked
 * cloudflared keeps a public URL pointed at the user's laptop long after they
 * believe sharing stopped, so every exit path funnels through `stop()`.
 */
export class QuickTunnelController {
  private state: DesktopWorkspaceShareState = createWorkspaceShareState();
  private child: ChildProcess.ChildProcess | null = null;
  private urlTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly spawn: typeof ChildProcess.spawn;
  private readonly urlTimeoutMs: number;
  private readonly onStateChange: ((state: DesktopWorkspaceShareState) => void) | undefined;
  private readonly probeAvailability: () => Promise<CloudflaredAvailability>;
  private readonly resolveServerAuthPolicy: (port: number) => Promise<ServerAuthPolicy | null>;

  constructor(options: QuickTunnelControllerOptions = {}) {
    this.spawn = options.spawn ?? ChildProcess.spawn;
    this.urlTimeoutMs = options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
    this.onStateChange = options.onStateChange;
    this.probeAvailability = options.probeAvailability ?? (() => probeCloudflaredAvailability());
    this.resolveServerAuthPolicy =
      options.resolveServerAuthPolicy ?? ((port) => probeServerAuthPolicy(port));
  }

  getState(): DesktopWorkspaceShareState {
    return this.state;
  }

  async start(port: number): Promise<DesktopWorkspaceShareState> {
    if (!canStartWorkspaceShare(this.state.status)) return this.state;

    // Before anything is spawned: publishing a server that mints owner sessions
    // for local-looking callers would put a shell on this laptop behind a public
    // URL. A probe that throws is a policy we could not read, which is refused
    // for the same reason.
    const policy = await this.resolveServerAuthPolicy(port).catch(() => null);
    const preflight = evaluateWorkspaceSharePreflight(policy);
    if (!preflight.allowed) {
      return this.setState(reduceWorkspaceShareOnUnavailable(this.state, preflight.reason));
    }

    const availability = await this.probeAvailability();
    if (!availability.available) {
      return this.setState(
        reduceWorkspaceShareOnUnavailable(
          this.state,
          availability.reason ?? "cloudflared is unavailable.",
        ),
      );
    }

    this.setState(reduceWorkspaceShareOnStartRequested(this.state));

    const collector = new QuickTunnelOutputCollector();
    let child: ChildProcess.ChildProcess;
    try {
      child = this.spawn(CLOUDFLARED_BINARY, [...buildQuickTunnelArgs(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return this.setState(reduceWorkspaceShareOnFailure(this.state, toSpawnError(error).message));
    }
    this.child = child;

    const onOutput = (chunk: unknown) => {
      const url = collector.push(chunk);
      if (url && this.child === child && this.state.status === "starting") {
        this.clearUrlTimer();
        this.setState(reduceWorkspaceShareOnUrlDetected(this.state, url));
      }
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);

    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearUrlTimer();
      this.setState(
        reduceWorkspaceShareOnFailure(this.state, error.message, collector.getDiagnostics()),
      );
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearUrlTimer();
      if (this.state.status === "stopping") {
        this.setState(reduceWorkspaceShareOnStopped(this.state));
        return;
      }
      this.setState(
        reduceWorkspaceShareOnFailure(
          this.state,
          `cloudflared exited (code=${code ?? "null"} signal=${signal ?? "null"}).`,
          collector.getDiagnostics(),
        ),
      );
    });

    this.urlTimer = setTimeout(() => {
      this.urlTimer = null;
      if (this.child !== child || this.state.status !== "starting") return;
      const diagnostics = collector.getDiagnostics();
      this.killChild(child);
      this.child = null;
      this.setState(
        reduceWorkspaceShareOnFailure(
          this.state,
          formatQuickTunnelTimeoutReason(this.urlTimeoutMs),
          diagnostics,
        ),
      );
    }, this.urlTimeoutMs);
    this.urlTimer.unref?.();

    return this.state;
  }

  stop(): DesktopWorkspaceShareState {
    this.clearUrlTimer();
    const child = this.child;
    this.child = null;

    if (!child) {
      return this.setState(reduceWorkspaceShareOnStopped(this.state));
    }

    this.setState(reduceWorkspaceShareOnStopRequested(this.state));
    this.killChild(child);
    return this.setState(reduceWorkspaceShareOnStopped(this.state));
  }

  /**
   * Synchronous, allocation-free teardown for `process.on("exit")`, where async work
   * and even the event loop are already gone.
   */
  disposeSync(): void {
    this.clearUrlTimer();
    const child = this.child;
    this.child = null;
    if (child) {
      this.killChild(child);
    }
    this.state = createWorkspaceShareState();
  }

  private killChild(child: ChildProcess.ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, STOP_FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
  }

  private clearUrlTimer(): void {
    if (!this.urlTimer) return;
    clearTimeout(this.urlTimer);
    this.urlTimer = null;
  }

  private setState(next: DesktopWorkspaceShareState): DesktopWorkspaceShareState {
    if (next === this.state) return this.state;
    this.state = next;
    this.onStateChange?.(next);
    return next;
  }
}
