/**
 * The one-liner for a machine with no screen.
 *
 * `/download` answers the laptop question — get the app, launch it, approve it
 * here. This answers the other one, and it is a different audience with a
 * different constraint: a VPS has no desktop to install an app onto and nobody
 * sitting in front of it. What it has is an SSH prompt, so what it needs is a
 * line to paste.
 *
 * Unlike `desktopDownload.logic.ts` next door, the URL here is not waiting on a
 * release host. The server serves `infra/install/t3-environment.sh` itself, from
 * `GET /install.sh` — see `apps/server/src/install/http.ts` — so the address is
 * simply wherever this browser is already talking to, and the line is real
 * today. What is still unpublished is the *server tarball* the script then goes
 * looking for, which is why `describeEnvironmentInstallSteps` says so out loud
 * rather than letting somebody find out after they have already piped it to sh.
 *
 * @module EnvironmentInstall
 */

/**
 * Mirrors `INSTALL_SCRIPT_ROUTE` in `apps/server/src/install/http.ts`. Short and
 * at the root because it gets typed by hand and read off a screen.
 */
export const ENVIRONMENT_INSTALL_SCRIPT_PATH = "/install.sh";

export interface EnvironmentInstallLine {
  /** The origin the script will be fetched from, and baked into what it serves. */
  readonly origin: string;
  /** The whole thing, ready to paste. */
  readonly command: string;
  /**
   * True when the address only means anything on the machine already running
   * the server. A person developing against `localhost:5173` who copies this
   * line onto a VPS gets a connection refused and no idea why, so the page says
   * it before they do that rather than after.
   */
  readonly localOnly: boolean;
}

/**
 * The same rule the server applies to the `Host` header it bakes in, applied
 * here for a different reason: this string is shown to a person as something to
 * run as root, so it has to be a plain address and visibly nothing else. A
 * pasted line with a query string or credentials in it is a line nobody should
 * trust, whoever produced it.
 */
const PLAIN_ORIGIN =
  /^https?:\/\/(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/;

/**
 * Addresses that resolve to the machine you are standing on.
 *
 * `.localhost` is in RFC 6761 and some dev setups use it; `0.0.0.0` is not a
 * destination at all but people paste it anyway because it is what the server
 * printed when it bound. The loopback range is matched as a whole address and
 * not by prefix, because `127.example.com` is an ordinary domain somebody could
 * own and warning about it would be a lie.
 */
function isLocalOnlyHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The line, or null when there is no address worth printing.
 *
 * Takes the script URL rather than reading `window`, so the interesting cases —
 * a desktop shell with no web origin, a configured target, an address that
 * turns out to be loopback — are all reachable from a test.
 *
 * Null rather than a guess, and callers must handle it: a half-formed curl line
 * on a page is worse than no curl line, because somebody will run it.
 */
export function describeEnvironmentInstallLine(
  scriptUrl: string | null | undefined,
): EnvironmentInstallLine | null {
  if (typeof scriptUrl !== "string" || scriptUrl.trim().length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(scriptUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  // Nothing but the path this route lives at. A URL that picked up a query
  // string or credentials on the way here is not one to hand somebody.
  if (parsed.pathname !== ENVIRONMENT_INSTALL_SCRIPT_PATH) {
    return null;
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }

  const origin = parsed.origin;
  if (!PLAIN_ORIGIN.test(origin)) {
    return null;
  }

  return {
    origin,
    command: `curl -fsSL ${origin}${ENVIRONMENT_INSTALL_SCRIPT_PATH} | sh`,
    localOnly: isLocalOnlyHostname(parsed.hostname),
  };
}

export interface EnvironmentInstallCaveat {
  readonly title: string;
  readonly detail: string;
}

/**
 * What is honestly still missing, in the two shapes it comes in.
 *
 * The script is published now — this server serves it. The *server tarball* it
 * downloads is not, and no job builds one, so a run of the line gets as far as
 * the download step and stops with an explanation. Saying that here costs a
 * paragraph. Not saying it costs somebody a confusing five minutes on a box
 * they just gave root on, which is the moment they decide whether this product
 * is trustworthy.
 *
 * Returns an empty array when there is nothing to warn about, so the caller can
 * render nothing rather than an empty box.
 */
export function describeEnvironmentInstallCaveats(
  line: EnvironmentInstallLine | null,
): ReadonlyArray<EnvironmentInstallCaveat> {
  const caveats: Array<EnvironmentInstallCaveat> = [];

  if (line !== null && line.localOnly) {
    caveats.push({
      title: "This address only works on this machine",
      detail:
        `${line.origin} is a loopback address, so a server somewhere else cannot fetch anything from it. ` +
        "Open this page on the address the other machine can reach — a hostname, a LAN address or a tunnel — and copy the line from there.",
    });
  }

  caveats.push({
    title: "The script runs; the download it needs is not published yet",
    detail:
      "The installer itself is served from this server, so the line above fetches a real script and it will print its plan. " +
      "No job builds or uploads a server tarball yet, though, so it stops at the download step and says so rather than guessing at a URL. " +
      "Pass --base-url pointing at artifacts you host to get the whole way.",
  });

  return caveats;
}
