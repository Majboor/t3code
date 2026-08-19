import * as Crypto from "node:crypto";

import { Effect, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { ShareLinkToken } from "@t3tools/contracts";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
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

/**
 * Where a workspace link lands.
 *
 * A workspace link is not content, it is an offer to join, and taking it up
 * means signing in or signing up — which is the app's own surface and not
 * something this route can render inside a `sandbox` CSP. So the redemption of
 * one ends in a redirect to the app, which then asks the two questions below.
 *
 * The token travels in the query rather than the path so that the app's router
 * treats `/share` as one route however the token is shaped, and it stays in the
 * URL rather than being stashed somewhere because the page has to survive the
 * full reload that a sign-in performs. It is the same secret the visitor was
 * sent; putting it back in their address bar tells them nothing new.
 *
 * `/share` must also be listed in the app's own "do not bounce this to the
 * pairing screen" paths — `apps/web/src/routes/__root.tsx` and `authRouting.ts`
 * — or a recipient lands on a pairing-token form they can never satisfy.
 */
export const SHARE_LINK_JOIN_ROUTE = "/share";
export const SHARE_LINK_JOIN_TOKEN_PARAM = "s";

/** The two exchanges the join page makes, in the order it makes them. */
export const SHARE_LINK_PREVIEW_ROUTE = "/api/share-links/preview";
export const SHARE_LINK_CLAIM_ROUTE = "/api/share-links/claim";

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

const readFingerprintSalt = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const salt = yield* secrets.getOrCreateRandom(
    SHARE_LINK_FINGERPRINT_SALT,
    SHARE_LINK_FINGERPRINT_SALT_BYTES,
  );
  cachedSalt = salt;
  return salt;
}).pipe(
  // The store is built here rather than asked of the server, and the cache
  // above is checked before this runs, so it is constructed exactly once — on
  // the first visit to the first link — and never again. Reaching for it
  // through the ambient context instead would mean making every server secret
  // available to every HTTP route in the product for the sake of one salt.
  Effect.provide(ServerSecretStoreLive),
);

const fingerprintSalt = Effect.suspend(() =>
  cachedSalt !== null ? Effect.succeed(cachedSalt) : readFingerprintSalt,
).pipe(
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

  // A workspace link goes to the join page, which is a page in the app rather
  // than anything this route can draw: it has to be able to sign somebody in,
  // sign somebody up, and then put them inside the workspace.
  //
  // Nothing about the link travels in the redirect but the token the visitor
  // already holds — no workspace id, no label, and above all no address. The
  // page asks for all of that afterwards, over routes that can decide what the
  // caller has earned.
  //
  // 303, not 302: the visitor arrived by GET and must continue by GET, and
  // spelling that out costs nothing.
  // Relative, and built from the token this request arrived with rather than
  // from anything in the row: `redemption.link.token` is the withheld
  // placeholder, and a `Location` assembled from a host header would be an
  // open redirect with a valid share token attached.
  const joinSearch = new URLSearchParams([[SHARE_LINK_JOIN_TOKEN_PARAM, token]]).toString();
  return HttpServerResponse.redirect(`${SHARE_LINK_JOIN_ROUTE}?${joinSearch}`, {
    status: 303,
    headers: SAFETY_HEADERS,
  });
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
);

/**
 * The two exchanges behind the join page.
 *
 * Both are POST with a JSON body, and that is a decision rather than a habit.
 * A token in a query string is a credential in an access log and in a
 * `Referer`; a JSON body is also the one thing a cross-site form cannot send,
 * so a page on another origin cannot make a signed-in user's browser join a
 * workspace behind their back. The CORS layer allows no credentials, so a
 * cross-origin `fetch` cannot carry the session cookie either.
 *
 * Neither route caches, for the same reason `/s/` does not.
 */
const JOIN_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * The one refusal both routes share, and the same words `/s/` uses.
 *
 * Missing, expired, revoked, not a workspace link, or a body that made no
 * sense: one status and one sentence. The join page renders it verbatim, so a
 * visitor cannot learn from the wording whether the token they hold was ever
 * real.
 */
const joinUnavailable = HttpServerResponse.jsonUnsafe(
  { error: "This link is not available." },
  { status: 404, headers: JOIN_HEADERS },
);

/** The token out of a JSON body, judged exactly as strictly as the path is. */
function tokenFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("token" in body)) {
    return null;
  }
  const token = (body as { token: unknown }).token;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

const shareLinkPreviewRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json;
  const token = tokenFromBody(body);
  if (token === null) {
    return joinUnavailable;
  }

  const shareLinks = yield* ShareLinkService;
  const preview = yield* shareLinks.previewWorkspaceLink({ token });
  // Exactly the three fields of `ShareLinkPreview` and nothing wider: this
  // reply goes to whoever holds the URL, which may be whoever the URL was
  // forwarded to.
  return HttpServerResponse.jsonUnsafe(
    { scope: preview.scope, audience: preview.audience, label: preview.label },
    { status: 200, headers: JOIN_HEADERS },
  );
}).pipe(
  Effect.catch(() => Effect.succeed(joinUnavailable)),
  Effect.catchDefect(() => Effect.succeed(joinUnavailable)),
);

/**
 * Who the claimant is, according to this server and not according to them.
 *
 * The address comes from the local account row or from the verified claims of
 * the token that established the session — never from the request body, which
 * is why the body carries nothing but the share token. `null` here is not
 * "unknown, allow it": the service refuses an email-scoped link outright when
 * it gets one.
 */
const resolveClaimActor = (session: AuthenticatedSession) =>
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const profile = yield* serverAuth.resolveUserProfile(session);
    const localAccount = yield* serverAuth.resolveLocalAccount(session);
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarInitials: profile.avatarInitials,
      email: localAccount?.email ?? session.email ?? null,
    };
  });

const shareLinkClaimRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;

  // Before the token is even read. A visitor who has not signed in is told to,
  // in the one place that can tell them so — and learns nothing about the link.
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.mapError(
      () =>
        new AuthError({
          message: "Sign in to open this link.",
          status: 401,
        }),
    ),
  );

  const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
  const token = tokenFromBody(body);
  if (token === null) {
    return joinUnavailable;
  }

  const actor = yield* resolveClaimActor(session);
  const shareLinks = yield* ShareLinkService;
  const claimed = yield* Effect.result(shareLinks.claim(actor, { token: token as ShareLinkToken }));
  if (claimed._tag === "Failure") {
    // `forbidden` is the audience refusing this account, and it is the one
    // outcome worth telling apart: the visitor is signed in as the wrong person
    // and can do something about it. Its message names no address. Everything
    // else collapses into the same "not available" as always.
    return claimed.failure.code === "forbidden"
      ? HttpServerResponse.jsonUnsafe(
          { error: claimed.failure.message },
          { status: 403, headers: JOIN_HEADERS },
        )
      : joinUnavailable;
  }

  return HttpServerResponse.jsonUnsafe(
    {
      tenantId: claimed.success.tenantId,
      workspaceId: claimed.success.workspaceId,
      joined: claimed.success.joined,
    },
    { status: 200, headers: JOIN_HEADERS },
  );
}).pipe(
  Effect.catchTag("AuthError", (error) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe(
        { error: error.message },
        { status: error.status ?? 500, headers: JOIN_HEADERS },
      ),
    ),
  ),
  Effect.catch(() => Effect.succeed(joinUnavailable)),
  Effect.catchDefect(() => Effect.succeed(joinUnavailable)),
);

/** What a page may say about a link to someone who has not signed in. */
export const shareLinkPreviewRouteLayer = HttpRouter.add(
  "POST",
  SHARE_LINK_PREVIEW_ROUTE,
  shareLinkPreviewRoute,
);

/** The only route that grants anything, and the only one that needs a session. */
export const shareLinkClaimRouteLayer = HttpRouter.add(
  "POST",
  SHARE_LINK_CLAIM_ROUTE,
  shareLinkClaimRoute,
);
