import * as Crypto from "node:crypto";

import { Effect, Layer, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ShareLinkService } from "./Services/ShareLinkService.ts";

/**
 * Redeeming a share link, with no account and no session.
 *
 * This is the only route in the product that hands out a workspace's files to
 * someone the workspace has never heard of, and the token in the URL is the
 * entire access control. Everything below is written for a caller who is
 * hostile, patient, and running a script.
 *
 * The path is `/s/<token>` and it is deliberately two characters long: this URL
 * gets pasted into chat windows, typed off a screen and wrapped by email
 * clients, and every character of prefix is a character that can be lost.
 */

/** Short because it is pasted; the token after it carries all the entropy. */
export const SHARE_LINK_ROUTE_PREFIX = "/s";

const SHARE_LINK_FINGERPRINT_SALT = "share-link-fingerprint";
const SHARE_LINK_FINGERPRINT_SALT_BYTES = 32;

/**
 * Headers every reply carries, refusal included.
 *
 * - `no-store`, because the token is in the URL: a caching proxy that keeps
 *   this response keeps a copy of a private file keyed by a credential.
 * - `noindex`, because "public" here means "anyone with the link", not "anyone
 *   with a search engine". A crawler that finds one forwarded URL would
 *   otherwise publish it for good.
 * - `no-referrer`, for the same reason and the sharper one: the token is *in*
 *   the URL, so any navigation away from this page would send it to a third
 *   party in the `Referer` header.
 * - `nosniff` plus a `sandbox` CSP, because the bytes come from a file somebody
 *   else wrote. Content-type confusion is the whole attack — a shared
 *   `index.html` interpreted as HTML on the product's own origin is stored XSS
 *   against every signed-in user who opens it.
 */
const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; sandbox",
};

/**
 * The one answer for every failure.
 *
 * Missing, expired, revoked, wrong shape, a path that escapes the root — all of
 * them, with the same status, the same body and the same headers. Any variation
 * is an oracle: a caller who can tell "expired" from "no such link" can confirm
 * that a token they guessed was once real, and a caller who can tell "no such
 * file" from "outside the project" can walk the filesystem one request at a
 * time.
 */
const unavailable = HttpServerResponse.text("This link is not available.", {
  status: 404,
  contentType: "text/plain; charset=utf-8",
  headers: SAFETY_HEADERS,
});

/**
 * The salt behind every recorded fingerprint, read once per process.
 *
 * Persisted rather than generated per boot so that repeat visits still group
 * together across a restart, which is the only thing the fingerprint is for.
 * Cached in a module variable because the alternative is a disk read on every
 * single visit to every link.
 */
let cachedSalt: Uint8Array | null = null;

const fingerprintSalt = Effect.gen(function* () {
  if (cachedSalt !== null) {
    return cachedSalt;
  }
  const secrets = yield* ServerSecretStore;
  const salt = yield* secrets.getOrCreateRandom(
    SHARE_LINK_FINGERPRINT_SALT,
    SHARE_LINK_FINGERPRINT_SALT_BYTES,
  );
  cachedSalt = salt;
  return salt;
}).pipe(
  // No salt, no fingerprint. Falling back to an unsalted hash would be worse
  // than recording nothing: an unsalted hash of an IPv4 address is reversible
  // by exhausting four billion inputs, which is a few seconds of work.
  Effect.catch(() => Effect.succeed(null)),
);

/**
 * Who to count this visit against, without writing down who they are.
 *
 * `x-forwarded-for` is preferred because this server runs behind a tunnel, and
 * the socket address there is the tunnel's for every visitor alike. It is
 * spoofable, which is fine: the header cannot grant access, so the worst a liar
 * achieves is being counted as several people.
 */
function clientAddress(request: HttpServerRequest.HttpServerRequest): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  if (first !== undefined && first.length > 0) {
    return first;
  }
  return Option.getOrElse(request.remoteAddress, () => "").trim() || null;
}

/**
 * A salted digest, and never the address itself.
 *
 * The views table is read by a product analytics page, and an analytics page
 * must not become a place where visitor IP addresses accumulate — once they are
 * written down they are subject to every request, subpoena and breach that
 * follows. Truncated because 192 bits is far past collision territory for a
 * counter, and a shorter value is less useful to anyone who does get the table.
 */
function fingerprintOf(salt: Uint8Array | null, address: string | null): string | null {
  if (salt === null || address === null) {
    return null;
  }
  return Crypto.createHash("sha256")
    .update(salt)
    .update("\n")
    .update(address)
    .digest("base64url")
    .slice(0, 32);
}

/**
 * The token, taken from the path and left exactly as it arrived.
 *
 * No percent-decoding. The generator emits base64url precisely so that a token
 * survives a URL untouched, so decoding here would buy nothing and would add a
 * transformation of an attacker-controlled string between the URL and the
 * database lookup — the shape that turns one encoding trick into a bypass.
 */
function tokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(`${SHARE_LINK_ROUTE_PREFIX}/`)) {
    return null;
  }
  const token = pathname.slice(SHARE_LINK_ROUTE_PREFIX.length + 1).split("/")[0] ?? "";
  return token.length > 0 ? token : null;
}

const shareLinkRedeemRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return unavailable;
  }
  const token = tokenFromPath(url.value.pathname);
  if (token === null) {
    return unavailable;
  }

  const shareLinks = yield* ShareLinkService;
  const salt = yield* fingerprintSalt;
  const redemption = yield* shareLinks.redeem({
    token,
    // Only meaningful for a project link; the service refuses it on the others
    // rather than ignoring it, so a file link cannot be widened by a query
    // parameter.
    path: url.value.searchParams.get("path"),
    viewerFingerprint: fingerprintOf(salt, clientAddress(request)),
  });

  if (redemption.kind === "file") {
    // Always `text/plain`, whatever the file is called. The alternative is
    // deciding a content type from an extension somebody else chose, on this
    // product's own origin — which is how a shared `.html` or `.svg` becomes
    // script running as the viewer. The filename is deliberately not echoed
    // into a `Content-Disposition` header either: that would put an
    // attacker-controlled string into a response header for no gain here.
    return HttpServerResponse.uint8Array(redemption.contents, {
      status: 200,
      contentType: "text/plain; charset=utf-8",
      headers: SAFETY_HEADERS,
    });
  }

  if (redemption.kind === "project") {
    return HttpServerResponse.jsonUnsafe(
      {
        scope: "project",
        label: redemption.link.label,
        projectTitle: redemption.projectTitle,
        entries: redemption.entries,
        truncated: redemption.truncated,
      },
      { status: 200, headers: SAFETY_HEADERS },
    );
  }

  // Enough to offer joining and nothing else. No member list, no project names,
  // no file listing: whoever holds this URL has not joined yet, and everything
  // beyond the invitation itself is for people who have.
  return HttpServerResponse.jsonUnsafe(
    {
      scope: "workspace",
      label: redemption.link.label,
      tenantId: redemption.link.tenantId,
      workspaceId: redemption.link.workspaceId,
    },
    { status: 200, headers: SAFETY_HEADERS },
  );
}).pipe(
  // Every failure the service can raise, and every defect underneath it, land
  // on the same reply. A 500 with a stack trace would be its own oracle.
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

/**
 * `GET /s/<token>` serves the link, and `?path=` picks one file out of a
 * project link's listing. One route rather than three, because a visitor cannot
 * be expected to know which kind of link they were sent.
 *
 * Mounted with a trailing wildcard so a stray trailing slash or a token pasted
 * with something after it still reaches this handler and gets the same refusal
 * as everything else, instead of falling through to the static file route.
 */
export const shareLinkRedeemRouteLayer = HttpRouter.add(
  "GET",
  `${SHARE_LINK_ROUTE_PREFIX}/*`,
  shareLinkRedeemRoute,
).pipe(
  // The secret store is provided here rather than asked of the server, because
  // the fingerprint salt is this route's own business and nothing else reads
  // it. The store is file-backed and its creation is race-safe, so a second
  // instance alongside the auth stack's is harmless.
  Layer.provide(ServerSecretStoreLive),
);
