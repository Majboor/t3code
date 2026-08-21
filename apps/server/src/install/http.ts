import { Effect, FileSystem, Path } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * `GET /install.sh` — the one-line installer, served by the hub it installs
 * against.
 *
 * `infra/install/t3-environment.sh` has existed and been tested for a while,
 * and nothing served it, so the `curl -fsSL … | sh` line in its README had no
 * host to name. This route is that host: not a release CDN somebody still has
 * to build, but whatever server the person is already looking at. If you can
 * reach the app, you can reach its installer.
 *
 * The route does two things and both matter:
 *
 *   1. It serves the real file. Not a copy, not a generated approximation —
 *      the bytes on disk, so the script that is tested is the script that runs.
 *      The path is a constant; nothing in the request chooses a file.
 *
 *   2. It bakes in the origin the request arrived on, so a box installed from a
 *      hub already knows that hub. That is the part with the teeth, because the
 *      origin comes out of a request header and lands in a file people pipe to
 *      `sh`. See `sanitizeHubOrigin`: a header is substituted only if it is a
 *      plain `scheme://host[:port]` and nothing else, and anything short of
 *      that is dropped rather than escaped. Dropping it costs somebody a flag.
 *      Escaping it wrong costs them their machine.
 *
 * @module Install
 */

/**
 * Short, guessable and at the root, because it is typed by hand and read aloud.
 * `apps/web/src/components/devices/environmentInstall.logic.ts` mirrors it for
 * the line the UI shows; change both or neither.
 */
export const INSTALL_SCRIPT_ROUTE = "/install.sh";

/** The file this route serves, and the only file it can serve. */
const INSTALL_SCRIPT_FILE_NAME = "t3-environment.sh";

/**
 * The one line the served script gets rewritten in.
 *
 * Kept as an exact literal rather than a regex over "some assignment to
 * T3_HUB_URL", so that the seam is a fixed point both sides can be checked
 * against instead of a pattern that quietly widens. The script's own comment
 * block above the line says the same thing from the other direction, and
 * deliberately does not quote the line, so that "exactly one occurrence" stays
 * true of the file.
 */
export const INSTALL_HUB_SEAM = 'T3_HUB_URL="${T3_HUB_URL:-}"';

/**
 * What a hub origin is allowed to look like, written out rather than delegated.
 *
 * `new URL()` is not a validator here. It is happy to parse
 * `http://example.com$(id)` — `$`, `(` and `)` are not forbidden host code
 * points — and hand back an `origin` containing a command substitution, which
 * inside the double quotes of a shell assignment is a shell running whatever
 * the header said. So the parser is used for normalisation and this pattern is
 * used for permission: letters, digits, dots and hyphens in labels, an optional
 * bracketed IPv6 literal, an optional numeric port, and nothing else. No
 * userinfo, no path, no query, no quote, no `$`, no whitespace, no newline.
 */
const HUB_ORIGIN_PATTERN =
  /^https?:\/\/(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/;

/**
 * A `Host` header is at most 255 bytes of anything a client felt like sending.
 * The bound is here so that a megabyte of legal-looking hostname cannot be
 * spent on the regex above, and so the emitted line stays a line.
 */
const MAX_HUB_ORIGIN_LENGTH = 255;

/**
 * The origin to bake in, or null to bake nothing in.
 *
 * Null is not an error path, it is the ordinary answer for a request this
 * server cannot honestly name an address from — a missing `Host`, a proxy that
 * rewrote it into something strange, a header written by somebody trying their
 * luck. The caller then gets the script exactly as it sits on disk, which is
 * the behaviour that shipped before this route existed: it works, and the
 * person names the hub themselves. There is no version of this function that
 * returns a best guess.
 *
 * Both regex tests are deliberate. The first refuses the raw candidate before
 * the parser sees it; the second refuses the parser's own output, because
 * normalisation is a transformation and the value that gets written to the file
 * is the one that has to be safe. The parser sits between them only to collapse
 * default ports and case, so `Host: EXAMPLE.com:80` and `Host: example.com`
 * produce one answer.
 */
export function sanitizeHubOrigin(candidate: string | null | undefined): string | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HUB_ORIGIN_LENGTH) {
    return null;
  }
  if (!HUB_ORIGIN_PATTERN.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Belt and braces: `origin` on a hierarchical http(s) URL never carries
  // these, and the pattern above already forbade them, but the whole file is
  // written for the case where one of those two sentences turns out to be
  // wrong.
  if (parsed.username !== "" || parsed.password !== "") {
    return null;
  }
  const origin = parsed.origin;
  if (origin.length > MAX_HUB_ORIGIN_LENGTH || !HUB_ORIGIN_PATTERN.test(origin)) {
    return null;
  }
  return origin;
}

/**
 * The address this request reached us on, by the same rule `approveUrl` uses in
 * `deviceEnrollment/http.ts`: the `Host` header, and `https` only when
 * `x-forwarded-proto` says so exactly.
 *
 * Both headers are attacker-controlled and that is survivable for the same
 * reason it is there: a caller who lies about `Host` gets a script pointing at
 * the host they invented, delivered to nobody but themselves. It is not a
 * redirect and it is not a credential — the enrollment it eventually performs
 * still ends at a person clicking approve in a browser on the real hub.
 *
 * Unlike `HttpServerRequest.toURL`, an absent `Host` is null rather than
 * `localhost`. Baking `http://localhost` into a script bound for somebody
 * else's VPS would be a confident wrong answer, and the honest one — no hub,
 * pass `--account-url` — is right there.
 */
function hubOriginFor(request: HttpServerRequest.HttpServerRequest): string | null {
  const host = request.headers["host"];
  if (typeof host !== "string") {
    return null;
  }
  const scheme = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return sanitizeHubOrigin(`${scheme}://${host}`);
}

/**
 * The script with the hub written into it, or the script exactly as it is.
 *
 * Refuses on anything ambiguous rather than doing its best. If the seam is
 * missing the script has been edited and this server no longer knows where the
 * value goes; if it appears more than once, one of them is prose and guessing
 * which is not a thing to do to a file people execute as root. Either way the
 * unmodified file is a correct answer — it is the file that was tested — so the
 * failure mode is a missing convenience, never a corrupted installer.
 */
export function bakeHubOrigin(script: string, origin: string | null): string {
  if (origin === null) {
    return script;
  }
  // Third check on the same value, after `sanitizeHubOrigin` did two. This one
  // guards the substitution itself rather than the parse, so that any future
  // caller reaching this function by another path still cannot write a quote,
  // a backtick, a `$` or a newline into the file.
  if (!HUB_ORIGIN_PATTERN.test(origin)) {
    return script;
  }
  if (script.split(INSTALL_HUB_SEAM).length !== 2) {
    return script;
  }
  // A replacer function, not a replacement string: `$` is special on the
  // right-hand side of `String.replace`, and the text being inserted is a
  // shell parameter expansion made mostly of them.
  return script.replace(INSTALL_HUB_SEAM, () => `T3_HUB_URL="\${T3_HUB_URL:-${origin}}"`);
}

/**
 * Where the script lives, for the two layouts this server actually runs in.
 *
 * From a checkout the file is at `infra/install/` relative to the repository
 * root, and this module may be running from `apps/server/src/install/` (source)
 * or from `apps/server/dist/` (bundled), so the root is found by walking up
 * rather than by counting `..` segments and hoping.
 *
 * The bundled sibling is checked first, and it is the layout that matters: an
 * installed server has no repository above it to walk up into, so before
 * `tsdown.config.ts` copied the script into `dist/install/` this route answered
 * 503 on exactly the machines the one-liner exists for. The null branch stays
 * anyway — a `dist` assembled by hand, or a future build that drops the copy,
 * is a thing that can happen, and it should produce a sentence rather than a
 * stack trace.
 *
 * Nothing here is derived from the request. There is one filename and it is a
 * constant, so there is no path for a caller to traverse.
 */
const MAX_REPOSITORY_WALK_UP = 6;

const resolveInstallScriptPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  const bundled = path.resolve(import.meta.dirname, "install", INSTALL_SCRIPT_FILE_NAME);
  if (yield* exists(bundled)) {
    return bundled;
  }

  let directory = path.resolve(import.meta.dirname);
  for (let step = 0; step <= MAX_REPOSITORY_WALK_UP; step += 1) {
    const candidate = path.join(directory, "infra", "install", INSTALL_SCRIPT_FILE_NAME);
    if (yield* exists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return null;
});

/**
 * `nosniff` because the body is a program and the browser has no business
 * deciding it is anything else. `no-store` because the body is not the same for
 * every caller — it carries the requesting origin — and a shared cache keyed
 * only on the path would hand one hub's baked script to somebody installing
 * against another.
 */
const SCRIPT_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * The answer when the file is not on this machine — a `dist` that was assembled
 * without it, or a source tree cut off from its repository root. A 404 would
 * suggest the feature does not exist; this says which one of the two it is, in a
 * shell comment,
 * because whatever reads it is a pipe into `sh` and a bare sentence there is a
 * command not found.
 */
const scriptUnavailable = HttpServerResponse.text(
  [
    "#!/bin/sh",
    "# This server does not have a copy of the T3 environment installer.",
    "# It is in the repository at infra/install/t3-environment.sh; copy it to",
    "# the machine and run it there.",
    "echo 't3: this server has no copy of the installer script.' >&2",
    "exit 1",
    "",
  ].join("\n"),
  {
    status: 503,
    contentType: "text/x-shellscript; charset=utf-8",
    headers: SCRIPT_HEADERS,
  },
);

const installScriptRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scriptPath = yield* resolveInstallScriptPath;
  if (scriptPath === null) {
    return scriptUnavailable;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  // Read per request rather than cached at boot. The file is 50 kB and this
  // route is hit once per machine anybody ever installs, so the read is free,
  // and not caching means an edit to the script during development is served
  // immediately instead of after a restart.
  const script = yield* fileSystem
    .readFileString(scriptPath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (script === null) {
    return scriptUnavailable;
  }

  return HttpServerResponse.text(bakeHubOrigin(script, hubOriginFor(request)), {
    status: 200,
    // The type for a shell script. It makes a browser download the file rather
    // than render it, which is the lesser cost: the audience for this URL is
    // `curl`, and anybody who wants to read it first is told to run
    // `curl -fsSL … | less` by the README rather than by a content type that
    // lies about what the bytes are.
    contentType: "text/x-shellscript; charset=utf-8",
    headers: SCRIPT_HEADERS,
  });
}).pipe(
  // Every failure above is already turned into `null` where it happens, so
  // there is no error channel left to catch — only defects, which land here
  // rather than as a stack trace on a route people pipe into a shell.
  Effect.catchDefect(() => Effect.succeed(scriptUnavailable)),
);

/**
 * Public and unauthenticated, necessarily: the caller is a bare `curl` on a
 * machine that has no account yet, which is the same premise the enrollment
 * routes start from. It discloses a file that is already in the repository and
 * grants nothing — the machine still has to enroll, and a person still has to
 * approve it in a browser.
 *
 * Must be registered before the static catch-all in `server.ts`, or `/install.sh`
 * is just a path that does not exist in the web bundle.
 */
export const installScriptRouteLayer = HttpRouter.add(
  "GET",
  INSTALL_SCRIPT_ROUTE,
  installScriptRoute,
);
