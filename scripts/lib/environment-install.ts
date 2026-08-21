/**
 * Turning a machine into an environment: every decision the installer makes,
 * kept out of the shell.
 *
 * The installer itself has to be POSIX `sh`, because the whole point is a line
 * somebody pastes into a fresh VPS where no runtime exists yet. That is a
 * terrible place to keep judgement. Arithmetic on version strings, deciding
 * whether a listening socket really collides with the one we are about to open,
 * deciding whether a 425 means "keep waiting" or "give up" — get any of those
 * subtly wrong in shell and the failure mode is a half-installed box that
 * somebody else has to unpick by hand.
 *
 * So the rules live here, where they can be run against the awkward cases
 * directly: the `ss` line whose *source* port happens to look like ours, the
 * version that gained a fourth segment, the enrollment that expired one second
 * before the poll. `infra/install/t3-environment.sh` mirrors them, and the
 * mirror is drift-checked by this module's tests in two ways: the constants the
 * two share are compared as text (`readInstallerShellConstants`), and the port
 * conflict rule — the one piece of judgement the script re-implements in awk
 * rather than merely parameterising — is *executed* against the same fixtures
 * this module is (`readInstallerShellFunction`). Those checks are the only thing
 * standing between "the script and the spec agree" and "they agreed once".
 *
 * The reading of `ss -lntpH` is shared with the runtime probe in
 * `apps/server/src/environment/listenerProbe.ts` through
 * `@t3tools/shared/ssOutput`, because both run that identical command and the
 * traps in its output belong to `ss` rather than to either caller. The shell's
 * copy is the one that cannot be shared — it runs on a bare VPS before any
 * runtime exists — and it is the one the executing drift check exists for.
 *
 * Nothing here touches the network or the filesystem. Every function takes the
 * machine's answers as arguments so the interesting cases are reachable from a
 * test rather than only from a real box.
 *
 * @module EnvironmentInstall
 */
import { parseSsRows, ssRowPid, ssRowProcessName } from "@t3tools/shared/ssOutput";

/**
 * Everything the installer is allowed to create, in one place.
 *
 * Named here rather than only in the script for the same reason `infra/host`
 * puts them in `lp-common.sh`: an uninstaller that recomputes these
 * independently is an uninstaller that eventually removes the wrong thing, or
 * misses something and leaves a service running on a box nobody is looking at.
 */
export const ENVIRONMENT_PREFIX = "/opt/t3-environment";

/**
 * State lives outside the prefix, and that is a deliberate exception to
 * "everything in one directory".
 *
 * Uninstall removes the prefix outright. If the SQLite file, the attachments
 * and the worktrees lived under it, `--uninstall` would be indistinguishable
 * from `rm -rf` on somebody's work. Keeping data at an FHS-conventional path
 * means removal can be honest: the code goes, the data stays, and the script
 * says where it is.
 */
export const ENVIRONMENT_DATA_DIR = "/var/lib/t3-environment";

export const ENVIRONMENT_SERVICE_USER = "t3env";
export const ENVIRONMENT_UNIT_NAME = "t3-environment.service";
export const ENVIRONMENT_UNIT_PATH = `/etc/systemd/system/${ENVIRONMENT_UNIT_NAME}`;

/**
 * The one line in an installed unit file that says "this is ours".
 *
 * Every destructive step checks for it first. A box that already runs something
 * called `t3-environment.service` — a hand-rolled unit, an earlier experiment,
 * another team's — must not have it stopped, overwritten or deleted by a script
 * that assumed the name implied ownership.
 */
export const ENVIRONMENT_UNIT_MARKER = "# Managed by t3-environment.sh";

/** `DEFAULT_PORT` in `apps/server/src/config.ts`. Keep the two in step. */
export const ENVIRONMENT_DEFAULT_PORT = 3773;

/** `packageManager` in the root `package.json`. */
export const ENVIRONMENT_BUN_VERSION = "1.3.11";

/** `version` in `apps/server/package.json`. */
export const ENVIRONMENT_SERVER_VERSION = "0.0.20";

export type InstallArch = "x64" | "aarch64";

export interface PlatformProbe {
  /** `uname -s`. */
  readonly kernel: string;
  /** `uname -m`. */
  readonly machine: string;
  /** `[ -d /run/systemd/system ]` — systemd is the *running* init, not merely installed. */
  readonly hasSystemd: boolean;
}

export type PlatformDecision =
  | {
      readonly supported: true;
      readonly arch: InstallArch;
      /** The asset name oven-sh/bun publishes for this machine. */
      readonly bunAsset: string;
    }
  | { readonly supported: false; readonly reason: string };

/**
 * Whether this machine can be turned into an environment, and if not, why in a
 * sentence somebody can act on.
 *
 * The order is the substance. Kernel first, because "macOS is not supported"
 * and "your CPU is not supported" are different problems and a person on a Mac
 * should never be told about their CPU. Architecture next, because it decides
 * which file gets downloaded. systemd last, because it is the only one of the
 * three that a person can fix on the machine they are already sitting on.
 *
 * Every refusal names the thing that was actually found. "Unsupported platform"
 * sends somebody to a search engine; "Darwin is not supported" tells them the
 * answer.
 */
export function detectInstallPlatform(probe: PlatformProbe): PlatformDecision {
  const kernel = probe.kernel.trim();
  const machine = probe.machine.trim();

  if (kernel !== "Linux") {
    return {
      supported: false,
      reason: unsupportedKernelReason(kernel),
    };
  }

  const arch = normalizeArch(machine);
  if (arch === null) {
    return {
      supported: false,
      reason:
        `This installer supports x86_64 and aarch64 Linux; this machine reports "${machine || "nothing"}". ` +
        `There is no build for it, so nothing was installed.`,
    };
  }

  if (!probe.hasSystemd) {
    return {
      supported: false,
      reason:
        "This installer needs systemd as the running init, and /run/systemd/system is not present. " +
        "That is normal inside a plain container or on a runit/OpenRC host. " +
        "Nothing was installed; run the server under whatever supervisor this machine already uses.",
    };
  }

  return { supported: true, arch, bunAsset: `bun-linux-${arch}` };
}

/**
 * Named per kernel, because each one has a different right answer.
 *
 * A Mac is somebody's laptop and already has a better path — the desktop app,
 * or `t3 serve` in a terminal. A BSD or Solaris box is a real server that this
 * simply has no build for. Anything else is a machine we have never seen, and
 * saying so plainly beats pretending to recognise it.
 */
function unsupportedKernelReason(kernel: string): string {
  switch (kernel) {
    case "Darwin":
      return (
        "This installer is for Linux servers, and this is macOS. Nothing was installed. " +
        "On a Mac, run the server directly with `t3 serve`, or use the desktop app."
      );
    case "FreeBSD":
    case "OpenBSD":
    case "NetBSD":
    case "DragonFly":
      return `This installer is for Linux servers, and this is ${kernel}. There is no build for it, so nothing was installed.`;
    case "SunOS":
      return "This installer is for Linux servers, and this is illumos/Solaris. There is no build for it, so nothing was installed.";
    case "":
      return "Could not read `uname -s`, so this machine could not be identified. Nothing was installed.";
    default:
      if (/mingw|msys|cygwin/i.test(kernel)) {
        return (
          `This installer is for Linux servers, and this looks like Windows (${kernel}). Nothing was installed. ` +
          "On Windows, use the desktop app, or install into WSL2 with systemd enabled."
        );
      }
      return `This installer is for Linux servers, and \`uname -s\` reports "${kernel}". Nothing was installed.`;
  }
}

/**
 * `uname -m` to the name the bun release assets use.
 *
 * `arm64` is in here because it is what a handful of Linux userlands report on
 * the same silicon that others call `aarch64`; treating them as different
 * machines would refuse to install on hardware that is perfectly supported.
 * `armv7l` deliberately is not: 32-bit ARM has no build, and mapping it to
 * `aarch64` would download something the kernel cannot execute.
 */
function normalizeArch(machine: string): InstallArch | null {
  switch (machine) {
    case "x86_64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "aarch64";
    default:
      return null;
  }
}

/**
 * Order two versions, with -1/0/1 meaning what `<`/`=`/`>` mean.
 *
 * Segment-wise and numeric, because "0.0.9" and "0.0.10" compare the wrong way
 * round as strings and that is precisely the comparison an upgrade check makes.
 * A missing segment reads as 0, so "0.1" and "0.1.0" are the same version
 * rather than an upgrade that reinstalls on every run.
 *
 * A prerelease suffix sorts *before* the release it leads to — "0.1.0-rc.1" is
 * older than "0.1.0" — which is the SemVer rule and also the only reading that
 * makes `rc` -> release an upgrade rather than a refused downgrade.
 */
export function compareInstallVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);

  const segments = Math.max(a.release.length, b.release.length);
  for (let index = 0; index < segments; index += 1) {
    const diff = (a.release[index] ?? 0) - (b.release[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  if (a.prerelease === b.prerelease) {
    return 0;
  }
  // Absent beats present: a release outranks any prerelease of the same number.
  if (a.prerelease === null) {
    return 1;
  }
  if (b.prerelease === null) {
    return -1;
  }
  return a.prerelease < b.prerelease ? -1 : 1;
}

function parseVersion(value: string): {
  readonly release: ReadonlyArray<number>;
  readonly prerelease: string | null;
} {
  const trimmed = value.trim().replace(/^v/i, "");
  const [core = "", ...rest] = trimmed.split("-");
  const prerelease = rest.length > 0 ? rest.join("-") : null;
  const release = core.split(".").map((segment) => {
    const parsed = Number.parseInt(segment, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  return { release, prerelease };
}

export type InstallAction = "install" | "upgrade" | "reinstall" | "refuse-downgrade";

export interface InstallActionDecision {
  readonly action: InstallAction;
  readonly message: string;
}

/**
 * What re-running the line should do to a box that may already have an install.
 *
 * The two interesting answers are the ones that are not "install". Re-running
 * with the same version must be a *reinstall* rather than a no-op, because the
 * commonest reason somebody pastes the line twice is that the first run left
 * something broken — a no-op there is a script that refuses to fix the problem
 * it caused. And going backwards is refused rather than performed, because the
 * data directory has already been migrated by the newer server and pointing an
 * older one at it is how a database gets damaged. A person who genuinely wants
 * to downgrade can uninstall first, which is a decision rather than an accident.
 */
export function planInstallAction(input: {
  readonly installed: string | null;
  readonly requested: string;
}): InstallActionDecision {
  if (input.installed === null) {
    return {
      action: "install",
      message: `Installing ${input.requested}.`,
    };
  }

  const order = compareInstallVersions(input.installed, input.requested);
  if (order < 0) {
    return {
      action: "upgrade",
      message: `Upgrading ${input.installed} -> ${input.requested} in place.`,
    };
  }
  if (order === 0) {
    return {
      action: "reinstall",
      message: `${input.requested} is already installed; reinstalling it over itself. Data is untouched.`,
    };
  }
  return {
    action: "refuse-downgrade",
    message:
      `Refusing to downgrade: ${input.installed} is installed and ${input.requested} is older. ` +
      `The data directory has already been migrated by ${input.installed}. ` +
      `Run with --uninstall first if you really want ${input.requested}.`,
  };
}

export interface ListeningSocket {
  /** The local address as reported, e.g. `0.0.0.0`, `::`, `127.0.0.1`, `*`. */
  readonly address: string;
  readonly port: number;
  /** Whatever the tool could say about the holder, or null when it could not. */
  readonly process: string | null;
  /**
   * The holding pid, when `ss` was run with `-p` and by someone allowed to see
   * it. Null otherwise, and the null matters — see `conflictIsOwnService`.
   */
  readonly pid: number | null;
}

/**
 * Read `ss -lntpH` output into sockets.
 *
 * The row splitting is `@t3tools/shared/ssOutput`, shared with the runtime probe
 * in `apps/server/src/environment/listenerProbe.ts`, because that probe runs the
 * identical command with the identical flags and the trap in this output is
 * specific, quiet, and the same for both: every row carries a *peer* column as
 * well as a local one, and the peer column on a listening socket is `0.0.0.0:*`
 * — which contains a colon, contains digits, and will happily match a naive port
 * grep. A conflict check that fires on the peer column reports a collision on
 * every box that has any listener at all.
 *
 * What is *not* shared is the address, and deliberately. The probe folds `[::]`
 * into `0.0.0.0` for a reader who only wants to know whether a thing is exposed;
 * here the address is kept as `ss` printed it, because the rule below is
 * `bind(2)`'s and because the awk in `infra/install/t3-environment.sh` — the
 * copy that actually runs, on a machine with no runtime to import anything —
 * prints it that way too.
 */
export function parseListeningSockets(ssOutput: string): ReadonlyArray<ListeningSocket> {
  const sockets: Array<ListeningSocket> = [];

  for (const row of parseSsRows(ssOutput)) {
    const split = splitHostPort(row.local);
    if (split === null) {
      continue;
    }
    sockets.push({
      address: split.address,
      port: split.port,
      process: describeSocketUser(row.users),
      pid: ssRowPid(row.users),
    });
  }

  return sockets;
}

/**
 * Split `addr:port`, and get IPv6 right.
 *
 * `[::]:3773` and `::1:3773` are both things `ss` prints, and splitting either
 * on the first colon produces nonsense. The port is always after the *last*
 * colon; everything before it is the address, brackets stripped.
 */
function splitHostPort(value: string): { readonly address: string; readonly port: number } | null {
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) {
    return null;
  }
  const portText = value.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }
  const port = Number.parseInt(portText, 10);
  if (port <= 0 || port > 65535) {
    return null;
  }
  const address = value.slice(0, lastColon).replace(/^\[/, "").replace(/\]$/, "");
  return { address, port };
}

/**
 * `users:(("apache2",pid=812,fd=4))` -> `apache2 (pid 812)`.
 *
 * Both halves are required. A name with no pid is not something to render as
 * `apache2 (pid null)`, and it is not something the caller may act on either:
 * only the pid can settle whether the holder is our own service, so a holder
 * with no pid is described as nothing at all.
 */
function describeSocketUser(users: string): string | null {
  const name = ssRowProcessName(users);
  const pid = ssRowPid(users);
  if (name === null || pid === null) {
    return null;
  }
  return `${name} (pid ${pid})`;
}

const WILDCARD_ADDRESSES: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*", ""]);

/**
 * Would binding `host:port` collide with something already listening?
 *
 * The naive version — "is anything on this port" — is wrong in the direction
 * that matters. A box can legitimately have one service on `127.0.0.1:3773` and
 * another on a public address, and refusing to install because of the first is
 * a script that cannot be used on the hosts it was written for.
 *
 * The rule that actually matches what `bind(2)` does: a wildcard on either side
 * collides with everything on that port, and two specific addresses collide
 * only with themselves. Everything else is free.
 *
 * Returns the offending socket rather than a boolean, because the caller's job
 * is to name it. "Port 3773 is in use" starts an investigation; "port 3773 is
 * held by apache2 (pid 812) on 0.0.0.0" ends one.
 */
export function findPortConflict(input: {
  readonly port: number;
  readonly host: string;
  readonly listeners: ReadonlyArray<ListeningSocket>;
}): ListeningSocket | null {
  const wantWildcard = WILDCARD_ADDRESSES.has(input.host);

  for (const listener of input.listeners) {
    if (listener.port !== input.port) {
      continue;
    }
    if (wantWildcard || WILDCARD_ADDRESSES.has(listener.address)) {
      return listener;
    }
    if (sameAddress(listener.address, input.host)) {
      return listener;
    }
  }

  return null;
}

/**
 * `127.0.0.1` and `::ffff:127.0.0.1` are one address wearing two hats, and a
 * dual-stack listener on loopback is routinely reported as the second. Treating
 * them as different is how a real collision gets missed.
 */
function normalizeAddress(value: string): string {
  return value.replace(/^::ffff:/i, "").toLowerCase();
}

function sameAddress(left: string, right: string): boolean {
  return normalizeAddress(left) === normalizeAddress(right);
}

/**
 * Is the thing holding our port our own service, or somebody else's?
 *
 * An upgrade has to tolerate finding its own server on the port — that server
 * is the thing being replaced. Everything else on that port must stop the
 * install dead. Getting this backwards in either direction is bad: refuse too
 * eagerly and no environment can ever be upgraded; accept too eagerly and the
 * installer walks over a stranger's service on a shared box.
 *
 * The identity that settles it is the pid. "There is an install here" does not,
 * and that is the mistake this function exists to prevent: once an environment
 * has ever been installed, a check that only looks for a version file and a unit
 * file waves through *any* process that happens to hold the port — including the
 * unrelated one that grabbed it while our service was stopped.
 *
 * So: the socket's pid must equal the unit's own MainPID, and both must be real.
 * A null pid (ss without `-p`, or run unprivileged) is not evidence of
 * ownership, and neither is systemd's MainPID of 0, which is what an inactive
 * unit reports. Both resolve to "not ours", which is the safe direction —
 * the cost is a refusal a person can override with `--port`, and the cost of
 * the other direction is somebody else's outage.
 */
export function conflictIsOwnService(input: {
  readonly conflict: ListeningSocket | null;
  readonly ownMainPid: number | null;
  readonly unitIsOurs: boolean;
}): boolean {
  if (input.conflict === null || !input.unitIsOurs) {
    return false;
  }
  if (input.conflict.pid === null || input.ownMainPid === null) {
    return false;
  }
  // systemd reports 0 for a unit that is not running. Nothing holds a socket
  // under pid 0, so treating it as a match would make every conflict "ours".
  if (input.ownMainPid <= 0) {
    return false;
  }
  return input.conflict.pid === input.ownMainPid;
}

export type EnrollmentPollDecision =
  | { readonly kind: "collected" }
  | { readonly kind: "wait"; readonly delayMs: number }
  | { readonly kind: "stop"; readonly reason: string };

/**
 * How long to sit between polls while somebody finds the browser window.
 *
 * Two seconds is the whole budget's worth of patience: `collect` is capped at
 * 60 attempts a minute per code, and this is comfortably inside that while
 * still feeling immediate to a person who just clicked approve.
 */
export const ENROLLMENT_POLL_INTERVAL_MS = 2000;

/**
 * The back-off when the server says we are going too fast. Longer than the
 * rate-limit window is pointless; shorter just earns another 429.
 */
export const ENROLLMENT_RATE_LIMIT_DELAY_MS = 15_000;

/**
 * How long the installer is willing to wait for somebody to click approve.
 *
 * Not a number chosen here — it is `DEVICE_ENROLLMENT_TTL_MS` in
 * `apps/server/src/deviceEnrollment/http.ts`, and it has to stay equal to it.
 * Waiting longer than the server's window means polling a code that expired
 * minutes ago; giving up sooner means abandoning an enrollment that was still
 * live. The test suite reads that file and fails if the two diverge.
 */
export const ENROLLMENT_TTL_MS = 600_000;

/**
 * What to do with one reply from `POST .../:code/collect`.
 *
 * Every status here is a real branch of `apps/server/src/deviceEnrollment/http.ts`,
 * and the distinction the whole loop turns on is 425 against 409. The server
 * chose those two codes precisely so a poller could tell them apart: 425 means
 * the person simply has not clicked yet and the same request will work later;
 * 409 means this code is finished forever — approved and already collected,
 * denied, or expired. A loop that treats them alike either gives up on a live
 * enrollment or hammers a dead one until the deadline.
 *
 * 503 is retried because it is the server's single opaque "something failed
 * underneath", which includes transients like the database being briefly busy.
 * A 404 is not retried: the code was never real, or it is being sent to the
 * wrong host, and neither improves with time.
 *
 * The deadline is checked before the status, because a poll that arrives after
 * the enrollment lapsed cannot succeed no matter what it says, and stopping
 * with "it expired" is a better sentence than whatever the server returns.
 */
export function decideEnrollmentPoll(input: {
  readonly status: number;
  readonly elapsedMs: number;
  readonly ttlMs: number;
}): EnrollmentPollDecision {
  if (input.status === 200) {
    return { kind: "collected" };
  }

  if (input.elapsedMs >= input.ttlMs) {
    return {
      kind: "stop",
      reason:
        "The approval window closed before anyone approved this machine. Nothing was enrolled; run the installer again to get a fresh link.",
    };
  }

  switch (input.status) {
    case 425:
      return { kind: "wait", delayMs: ENROLLMENT_POLL_INTERVAL_MS };
    case 429:
      return { kind: "wait", delayMs: ENROLLMENT_RATE_LIMIT_DELAY_MS };
    case 503:
      return { kind: "wait", delayMs: ENROLLMENT_RATE_LIMIT_DELAY_MS };
    case 409:
      return {
        kind: "stop",
        reason:
          "This enrollment is finished — it was denied, it expired, or it has already been used. Run the installer again to start a new one.",
      };
    case 404:
      return {
        kind: "stop",
        reason:
          "The server does not recognise this enrollment. Check that --account-url points at the server you are signed in to.",
      };
    case 401:
      return {
        kind: "stop",
        reason:
          "The server refused the request. `collect` needs no session, so this is a proxy or gateway in front of it, not the enrollment itself.",
      };
    default:
      return {
        kind: "stop",
        reason: `The server answered ${input.status}, which this installer does not understand. Nothing was enrolled.`,
      };
  }
}

/**
 * Where a published installer would be fetched from.
 *
 * NOTHING PUBLISHES IT YET. No job builds a server tarball and no job uploads
 * one anywhere, so there is no host this could point at. It stays null on
 * purpose and `resolveEnvironmentInstallUrl` returns null with it, so the
 * documented one-liner is honestly absent instead of being a URL that 404s
 * after somebody has already piped it to a shell.
 *
 * Same reasoning, and the same shape, as `DESKTOP_DOWNLOAD_BASE_URL` in
 * `apps/web/src/components/devices/desktopDownload.logic.ts`.
 *
 * When there is a release host, this is the one line that changes.
 */
export const ENVIRONMENT_INSTALL_BASE_URL: string | null = null;

/** The script's own URL, or null while nothing is published. */
export function resolveEnvironmentInstallScriptUrl(): string | null {
  if (ENVIRONMENT_INSTALL_BASE_URL === null) {
    return null;
  }
  return `${ENVIRONMENT_INSTALL_BASE_URL.replace(/\/+$/, "")}/install.sh`;
}

/** The tarball for one server version, or null while nothing is published. */
export function resolveEnvironmentServerTarballUrl(version: string): string | null {
  if (ENVIRONMENT_INSTALL_BASE_URL === null) {
    return null;
  }
  const base = ENVIRONMENT_INSTALL_BASE_URL.replace(/\/+$/, "");
  return `${base}/t3-server-${encodeURIComponent(version)}.tar.gz`;
}

/** The line a person pastes, or null while there is nothing to paste. */
export function environmentInstallCommandLine(): string | null {
  const url = resolveEnvironmentInstallScriptUrl();
  return url === null ? null : `curl -fsSL ${url} | sh`;
}

export interface EnvironmentInstallAvailability {
  readonly published: boolean;
  readonly title: string;
  readonly detail: string;
}

/**
 * What to say about a one-liner that does not exist yet.
 *
 * Said in one place and said plainly, because the alternative — a code block
 * with a plausible URL in it — is worse than no code block. Somebody would run
 * it.
 */
export function describeEnvironmentInstallAvailability(): EnvironmentInstallAvailability {
  const line = environmentInstallCommandLine();
  if (line !== null) {
    return {
      published: true,
      title: "Paste this on the machine",
      detail: line,
    };
  }
  return {
    published: false,
    title: "The install line is not published yet",
    detail:
      "The script exists at infra/install/t3-environment.sh, but nothing uploads it or the server tarball anywhere, " +
      "so there is no URL to curl. Copy the script to the machine and run it with --base-url pointing at your own " +
      "artifacts, or set ENVIRONMENT_INSTALL_BASE_URL once there is a release host.",
  };
}

/**
 * The constants the shell script and this module both depend on.
 *
 * Parsed out of the script rather than duplicated, so the test can assert the
 * two agree instead of asserting that this file agrees with itself. The script
 * declares them in one fenced block of plain `NAME="value"` lines specifically
 * to make this possible; anything fancier there would have to be evaluated to
 * be read, and evaluating an installer to test it is not a trade worth making.
 */
export function readInstallerShellConstants(script: string): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const block =
    /# --- drift-checked constants ---\n([\s\S]*?)\n# --- end drift-checked constants ---/.exec(
      script,
    );
  if (block === null) {
    return constants;
  }
  for (const line of (block[1] ?? "").split("\n")) {
    const match = /^([A-Z0-9_]+)="([^"]*)"$/.exec(line.trim());
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/**
 * One shell function lifted out of the installer, so a test can run it.
 *
 * The constants block above is compared as text, which is all a constant needs.
 * A *rule* cannot be compared that way: `find_port_conflict` is an awk program,
 * it is the copy that actually executes on somebody's VPS, and reading it beside
 * `findPortConflict` and nodding is exactly the check that has never once caught
 * a divergence. So the test executes it instead, against the same fixtures the
 * TypeScript is held to, with a stub `ss` on `PATH`.
 *
 * Cut out rather than sourced because the script runs `do_install` when it is
 * loaded, and sourcing an installer to test it is emphatically not a trade worth
 * making. The extraction is deliberately literal — a function opens with
 * `name() {` at the start of a line and closes with `}` at the start of a line,
 * which is true of this file and is the same bargain the constants block makes:
 * the script stays plain enough to read as text.
 *
 * Returns null when there is no such function, so a rename fails the test that
 * needs it rather than silently checking nothing.
 */
export function readInstallerShellFunction(script: string, name: string): string | null {
  const opening = `\n${name}() {\n`;
  const start = script.indexOf(opening);
  if (start === -1) {
    return null;
  }
  const end = script.indexOf("\n}\n", start + opening.length);
  if (end === -1) {
    return null;
  }
  return script.slice(start + 1, end + 3);
}
