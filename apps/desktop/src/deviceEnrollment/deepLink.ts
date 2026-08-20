/**
 * Reading the `logicpacks://` links the browser sends back to the app.
 *
 * The approval happens in a browser, where the person is already signed in, and
 * the app has to hear about it. Polling alone would eventually notice, but the
 * link is what makes approval feel immediate and what pulls the app back in
 * front of someone who has just switched windows to click a button.
 *
 * What the link is allowed to carry is the point of this module. It carries a
 * code and nothing else — never the session credential. A URL is not a private
 * channel: it is written to shell history on Linux, to the registry-invoked
 * command line on Windows, to browser history everywhere, and to whatever the
 * OS logs about the process it launched. The credential is fetched over HTTPS
 * by the app itself, so the link only ever says "go collect", never "here it
 * is".
 *
 * Nor is the code in the link trusted on its own. Anything can hand this app a
 * `logicpacks://` URL — a web page, a chat message, a `.desktop` file. Parsing
 * returns the code so the caller can compare it against the enrollment this
 * process actually started; a link naming any other code describes somebody
 * else's machine and must not move this one.
 *
 * @module DeviceEnrollment
 */

/** The scheme registered with the OS. Lowercase, because that is how every platform stores it. */
export const DESKTOP_DEEP_LINK_SCHEME = "logicpacks";

const DEEP_LINK_PREFIX = `${DESKTOP_DEEP_LINK_SCHEME}:`;

/**
 * The one action the browser can name today.
 *
 * Kept as a literal union rather than a free string so that adding a second
 * deep link is a type error at every place that switches on this, instead of an
 * unhandled URL that silently does nothing.
 */
export type DesktopDeepLinkAction = "enroll";

/**
 * What the approval page reported, when it says anything at all.
 *
 * `null` is the honest and expected answer: the link is a nudge, and the server
 * is the authority on whether this machine was approved. A caller that treats a
 * missing outcome as "approved" would let any page that can open a URL claim an
 * approval nobody gave.
 */
export type DesktopDeepLinkOutcome = "approved" | "denied";

export interface EnrollmentDeepLink {
  readonly action: "enroll";
  readonly code: string;
  readonly outcome: DesktopDeepLinkOutcome | null;
}

export type DesktopDeepLink = EnrollmentDeepLink;

/**
 * Codes are bounded and alphanumeric-ish so that a parsed code is safe to put
 * straight into a request path. Base64url's `-` and `_` are allowed because the
 * server may well encode random bytes that way; nothing else is, which rules
 * out path traversal, query injection and the whitespace that a copy-paste
 * through a chat client tends to attach.
 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

function normaliseCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return CODE_PATTERN.test(trimmed) ? trimmed : null;
}

function normaliseOutcome(raw: string | null | undefined): DesktopDeepLinkOutcome | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "approved") return "approved";
  if (value === "denied") return "denied";
  return null;
}

/**
 * Whether this string is even addressed to us.
 *
 * Separate from parsing because argv scanning needs to ask the cheap question
 * about every argument before paying for a `URL` construction, and because
 * "looks like our link but is malformed" is worth distinguishing from "is some
 * other argument entirely" when logging why a launch did nothing.
 */
export function isDesktopDeepLink(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase().startsWith(DEEP_LINK_PREFIX);
}

/**
 * Parses a `logicpacks://` URL, or returns `null` for anything unrecognised.
 *
 * Total by construction: every malformed input — wrong scheme, unparseable URL,
 * unknown action, missing or hostile code — leaves through the same `null`
 * rather than throwing. This runs on `open-url` and on second-instance argv,
 * both of which are fed by the operating system from sources this app does not
 * control, and a throw there kills a launch.
 */
export function parseDesktopDeepLink(value: unknown): DesktopDeepLink | null {
  if (!isDesktopDeepLink(value) || typeof value !== "string") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol.toLowerCase() !== `${DESKTOP_DEEP_LINK_SCHEME}:`) {
    return null;
  }

  // `logicpacks://enroll?code=x` puts the action in the host; `logicpacks:enroll?code=x`
  // — which is what some Linux handlers and hand-typed links produce — puts it in
  // the path. Both are the same intent, so both are read the same way rather
  // than one of them quietly failing depending on who launched the app.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const action = (url.hostname || segments.shift() || "").toLowerCase();
  if (action !== "enroll") {
    return null;
  }

  // Windows in particular likes to hand back `logicpacks://enroll/CODE`, while a
  // query parameter is the friendlier form to generate. Query wins when both
  // are present, because it is the one the approval page writes deliberately.
  const code = normaliseCode(url.searchParams.get("code")) ?? normaliseCode(segments.shift());
  if (!code) {
    return null;
  }

  return {
    action: "enroll",
    code,
    outcome: normaliseOutcome(url.searchParams.get("status")),
  };
}

/**
 * The arguments `setAsDefaultProtocolClient` needs to register a working handler.
 *
 * A packaged app is its own executable, so the OS can be pointed straight at
 * it. A development run is not: `process.execPath` is the Electron binary and
 * the app is an argument to it, so registering without that argument tells the
 * OS to launch bare Electron — which opens a blank window and drops the link.
 * `process.defaultApp` is how Electron reports which of the two this is.
 *
 * Returns `null` when the script path cannot be determined, because registering
 * a handler that launches the wrong thing is worse than not registering one:
 * the broken association persists in the OS after the dev run ends.
 */
export function resolveProtocolClientRegistration(input: {
  readonly isDefaultApp: boolean;
  readonly execPath: string;
  readonly argv: readonly string[];
}): { readonly execPath: string; readonly args: readonly string[] } | null {
  if (!input.isDefaultApp) {
    return { execPath: input.execPath, args: [] };
  }
  const scriptPath = input.argv[1];
  if (typeof scriptPath !== "string" || scriptPath.trim().length === 0) {
    return null;
  }
  return { execPath: input.execPath, args: [scriptPath] };
}

/**
 * Finds the deep link among a process's arguments.
 *
 * macOS delivers the URL through `open-url`; Windows and Linux append it to the
 * command line of a *second* instance instead. So on those platforms the link
 * arrives buried in argv next to the executable path and whatever Chromium
 * switches Electron adds, and it has to be picked out rather than read off a
 * known index — which is why this scans instead of taking `argv[1]`.
 *
 * The last match wins. Arguments accumulate left to right, so if a launch
 * somehow carries two links, the later one is the more recent intent.
 */
export function findDeepLinkInArgv(argv: readonly string[] | undefined): DesktopDeepLink | null {
  if (!Array.isArray(argv)) {
    return null;
  }

  let found: DesktopDeepLink | null = null;
  for (const argument of argv) {
    const parsed = parseDesktopDeepLink(argument);
    if (parsed) {
      found = parsed;
    }
  }
  return found;
}
