import { DateTime, Effect, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { AccountMachineRepository } from "../persistence/Services/AccountMachines.ts";
import {
  DeviceEnrollmentRepository,
  hashDeviceEnrollmentCode,
} from "../persistence/Services/DeviceEnrollments.ts";
import { makeFixedWindowLimiter } from "./rateLimit.ts";

/**
 * Enrolling a machine into an account, over HTTP.
 *
 * Four of these five routes are unauthenticated, because the machine asking to
 * join has no account yet — that is the entire problem the flow solves. The one
 * that is not is `approve`, and it carries the whole feature: it is the only
 * place a real signed-in person says yes, and everything else is plumbing around
 * that single click. If approve ever stops requiring a session, the rest of this
 * file becomes a way to hand a stranger a credential by guessing a URL.
 *
 * The shape, end to end:
 *
 *   app        POST /api/devices/enrollments        -> code, approveUrl
 *   app        opens approveUrl in the browser
 *   person     GET  .../:code                       -> what am I approving?
 *   person     POST .../:code/approve               -> session required
 *   app        POST .../:code/collect               -> session credential, once
 *
 * The code is a bearer credential for the length of that exchange, so it is
 * treated like one: hashed at rest, never logged, never echoed back by any route
 * but the one that mints it, and rate limited on the two routes a holder of a
 * stolen code would hammer.
 *
 * @module DeviceEnrollment
 */

export const DEVICE_ENROLLMENTS_ROUTE = "/api/devices/enrollments";
export const DEVICE_ENROLLMENT_ROUTE = `${DEVICE_ENROLLMENTS_ROUTE}/:code`;
export const DEVICE_ENROLLMENT_APPROVE_ROUTE = `${DEVICE_ENROLLMENT_ROUTE}/approve`;
export const DEVICE_ENROLLMENT_DENY_ROUTE = `${DEVICE_ENROLLMENT_ROUTE}/deny`;
export const DEVICE_ENROLLMENT_COLLECT_ROUTE = `${DEVICE_ENROLLMENT_ROUTE}/collect`;

/**
 * Where the browser lands to approve. A page in the app, not anything this
 * server draws: approving has to happen somewhere a person is already signed in,
 * and that is the app's own surface.
 */
export const DEVICE_ENROLLMENT_CONNECT_PATH = "/connect";
export const DEVICE_ENROLLMENT_CONNECT_CODE_PARAM = "code";

/**
 * Ten minutes, and the reasoning is worth keeping.
 *
 * Long enough for somebody to find the browser window, sign in if they were
 * signed out, read what they are approving and click. Short enough that a code
 * left in a shell's scrollback or a terminal screenshot is worthless by the time
 * anyone finds it. Nothing sweeps the table, so this deadline is enforced at read
 * time by `decideEnrollment` and not by a status column going stale.
 */
export const DEVICE_ENROLLMENT_TTL_MS = 10 * 60 * 1000;

/**
 * Headers on every reply, refusal included.
 *
 * `no-store` because the code is in the path: a caching proxy that keeps one of
 * these keeps a credential keyed by a credential. `no-referrer` for the sharper
 * version of the same thing — a navigation away from a page that fetched
 * `.../:code` would otherwise put the code in a `Referer` header bound for a
 * third party. `noindex` because nothing here should ever be discoverable.
 */
const ENROLLMENT_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: ENROLLMENT_HEADERS });

/**
 * One sentence for "no such enrollment", and the same one whatever the truth is.
 *
 * A caller who can tell "never existed" from "existed and lapsed" can confirm
 * that a code they guessed was once real, which is the first half of an attack
 * on the second half.
 */
const notFound = json({ error: "This enrollment is not available." }, 404);

/** The one answer when anything under the hood fails. Never a stack trace. */
const unavailable = json({ error: "This enrollment is not available." }, 503);

const tooManyAttempts = HttpServerResponse.jsonUnsafe(
  { error: "Too many attempts. Try again shortly." },
  { status: 429, headers: { ...ENROLLMENT_HEADERS, "retry-after": "60" } },
);

const signInRequired = json({ error: "Sign in to approve this device." }, 401);

/**
 * Two limiters, because they are answering two different questions.
 *
 * The brief said "by code", and by code alone is genuinely useful: it caps what
 * somebody who *stole* one code can do with it, and it stops a wedged client
 * polling a thousand times a second. But it cannot stop guessing, because a
 * guesser presents a different code every time and so lands in a fresh bucket on
 * every attempt. So there is a second bucket keyed by caller address, which is
 * the one that actually makes enumeration pointless.
 *
 * Neither is load-bearing on its own. The code is 256 bits; the limiters exist
 * so that a mistake in that assumption is expensive rather than free.
 *
 * The code bucket is keyed by a digest of the code, not the code, so that a
 * process dump or a heap snapshot does not contain live credentials.
 */
const CODE_ATTEMPTS_PER_MINUTE = 60;
const ADDRESS_ATTEMPTS_PER_MINUTE = 120;
/**
 * Creating is capped too, though nothing asked for it. The route is
 * unauthenticated and writes a row, so without a ceiling it is an anonymous
 * `INSERT` loop against the same SQLite file everything else in the product
 * lives in — and nothing sweeps expired enrollments, so the rows stay. Twenty a
 * minute is far more than a person clicking "connect this machine" and far less
 * than a script needs to be interesting.
 */
const CREATE_ATTEMPTS_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const codeLimiter = makeFixedWindowLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: CODE_ATTEMPTS_PER_MINUTE,
});
const addressLimiter = makeFixedWindowLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: ADDRESS_ATTEMPTS_PER_MINUTE,
});
const createLimiter = makeFixedWindowLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxAttempts: CREATE_ATTEMPTS_PER_MINUTE,
});

/** Tests own the process, so they own the counters. Not used at runtime. */
export const resetDeviceEnrollmentRateLimits = () => {
  codeLimiter.reset();
  addressLimiter.reset();
  createLimiter.reset();
};

/**
 * Who to count this request against.
 *
 * `x-forwarded-for` first because this server runs behind a tunnel, where the
 * socket address is the tunnel's for everybody alike. It is spoofable, which is
 * survivable: the header grants nothing, so the worst a liar achieves is
 * spreading their own attempts across more buckets — and the per-code bucket
 * still holds. It is also what gets written to `requested_ip` and shown on the
 * approval screen, where "unknown" is an honest answer and a wrong one is not.
 */
function clientAddress(request: HttpServerRequest.HttpServerRequest): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  if (first !== undefined && first.length > 0) {
    return first;
  }
  return Option.getOrElse(request.remoteAddress, () => "").trim() || null;
}

const withinRateLimit = (input: {
  readonly bucket: string;
  readonly code: string;
  readonly request: HttpServerRequest.HttpServerRequest;
}) =>
  Effect.sync(() => {
    const nowMs = Date.now();
    const address = clientAddress(input.request);
    // Both are consulted, and both count the attempt, so a caller cannot dodge
    // one by exhausting the other.
    const codeAllowed = codeLimiter.check(
      `${input.bucket}:${hashDeviceEnrollmentCode(input.code)}`,
      nowMs,
    );
    const addressAllowed =
      address === null ? true : addressLimiter.check(`${input.bucket}:${address}`, nowMs);
    return codeAllowed && addressAllowed;
  });

/** The `:code` segment, left exactly as it arrived — see `shareLinks/http.ts`. */
const codeFromRoute = HttpRouter.params.pipe(
  Effect.map((params) => {
    const code = params["code"];
    return typeof code === "string" && code.length > 0 ? code : null;
  }),
);

/** A body is optional on every POST here; a missing one is not an error. */
const optionalJsonBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
});

function optionalString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return null;
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  // Bounded, because these strings are attacker-supplied and end up rendered on
  // somebody's approval screen. A label is a hint, not a payload.
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

/**
 * `POST /api/devices/enrollments`
 *
 * Unauthenticated by necessity: the caller is a machine with no account, which
 * is the whole premise. It therefore grants nothing — it writes a pending row
 * and hands back a code that is worth precisely nothing until a signed-in person
 * approves it.
 *
 * Capped per caller address all the same. Granting nothing is not the same as
 * costing nothing: this is an anonymous write to the product's database, and
 * nothing deletes the rows it leaves behind.
 */
const createEnrollmentRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = clientAddress(request);
  if (address !== null && !createLimiter.check(`create:${address}`, Date.now())) {
    return tooManyAttempts;
  }

  const enrollments = yield* DeviceEnrollmentRepository;
  const body = yield* optionalJsonBody;
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);

  const created = yield* enrollments.create({
    createdAt: DateTime.formatIso(DateTime.toUtc(now)),
    expiresAtMs: nowMs + DEVICE_ENROLLMENT_TTL_MS,
    deviceLabel: optionalString(body, "deviceLabel"),
    devicePlatform: optionalString(body, "devicePlatform"),
    requestedIp: clientAddress(request),
  });

  return json(
    {
      code: created.code,
      expiresAtMs: created.expiresAtMs,
      approveUrl: approveUrlFor(request, created.code),
    },
    201,
  );
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

/**
 * The link the app opens, absolute so it can be handed to a browser.
 *
 * Built from the request's own host, because that is the address the caller
 * already reached this server on and the only one this process reliably knows —
 * there is no configured public origin. Unlike a `Location` header, a
 * host-derived URL here cannot be an open redirect: nothing follows it but the
 * caller that asked, and a caller that lies about `Host` gets a link back to the
 * host it invented.
 */
function approveUrlFor(request: HttpServerRequest.HttpServerRequest, code: string): string {
  const search = new URLSearchParams([[DEVICE_ENROLLMENT_CONNECT_CODE_PARAM, code]]).toString();
  const relative = `${DEVICE_ENROLLMENT_CONNECT_PATH}?${search}`;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return relative;
  }
  return new URL(relative, url.value.origin).toString();
}

/**
 * `GET /api/devices/enrollments/:code`
 *
 * Two callers, one answer: the approval screen asking what it is about to
 * approve, and the machine polling to find out whether anybody said yes.
 *
 * It returns no credential and never has. The most it discloses is what the
 * enrolling machine itself supplied — its own label, platform and address —
 * which is exactly what a person has to see for "approve this machine?" to be a
 * question rather than a formality.
 */
const previewEnrollmentRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const code = yield* codeFromRoute;
  if (code === null) {
    return notFound;
  }
  if (!(yield* withinRateLimit({ bucket: "preview", code, request }))) {
    return tooManyAttempts;
  }

  const enrollments = yield* DeviceEnrollmentRepository;
  const found = yield* enrollments.getByCode({ code });
  if (Option.isNone(found)) {
    return notFound;
  }

  const record = found.value;
  const now = yield* DateTime.now;
  return json(
    {
      // Reported as expired the moment it is, rather than when something gets
      // around to rewriting the row. A poller that trusted the stored status
      // would sit on a dead code forever.
      status:
        record.status === "pending" && DateTime.toEpochMillis(now) >= record.expiresAtMs
          ? "expired"
          : record.status,
      deviceLabel: record.deviceLabel,
      devicePlatform: record.devicePlatform,
      requestedIp: record.requestedIp,
      expiresAtMs: record.expiresAtMs,
    },
    200,
  );
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

/**
 * The security boundary, in one function.
 *
 * `approve` and `deny` are the same shape and the same requirement: a browser
 * session, checked before the code is even looked at, so that an unauthenticated
 * caller learns nothing about whether the code they hold is real.
 */
const decideEnrollmentRoute = (action: "approve" | "deny") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;

    const session = yield* serverAuth
      .authenticateHttpRequest(request)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (session === null) {
      return signInRequired;
    }

    const code = yield* codeFromRoute;
    if (code === null) {
      return notFound;
    }

    const enrollments = yield* DeviceEnrollmentRepository;
    const now = yield* DateTime.now;
    const approverUserId = resolveAuthenticatedUserId(session);
    const applied = yield* enrollments.applyTransition({
      code,
      action:
        action === "approve" ? { type: "approve", byUserId: approverUserId } : { type: "deny" },
      nowMs: DateTime.toEpochMillis(now),
      nowIso: DateTime.formatIso(DateTime.toUtc(now)),
      ...(action === "approve"
        ? {
            approvedByUserId: approverUserId,
            // Written down rather than derived later: see migration 058. The
            // machine will be handed a session under exactly this subject and
            // role, so it can never end up with more than the approver had.
            approvedBySubject: session.subject,
            approvedByRole: session.role,
          }
        : {}),
    });

    if (applied.outcome === "not-found") {
      return notFound;
    }
    if (applied.outcome === "reject") {
      return json({ error: rejectionMessage(applied.reason), reason: applied.reason }, 409);
    }

    return json({ status: applied.record.status }, 200);
  }).pipe(
    Effect.catch(() => Effect.succeed(unavailable)),
    Effect.catchDefect(() => Effect.succeed(unavailable)),
  );

function rejectionMessage(reason: string): string {
  switch (reason) {
    case "expired":
      return "This enrollment has expired. Start again on the device.";
    case "already-approved":
      return "This enrollment has already been approved.";
    case "already-collected":
      return "This enrollment has already been used.";
    case "denied":
      return "This enrollment was denied.";
    case "not-approved":
      return "This enrollment has not been approved yet.";
    default:
      return "This enrollment is not available.";
  }
}

/**
 * `POST /api/devices/enrollments/:code/collect`
 *
 * The polling machine, unauthenticated, holding a code. On the one call that
 * finds an approved row it gets a session credential and the row becomes
 * `collected`; every call after that is refused, forever.
 *
 * The order below matters and is deliberate. The row is marked collected
 * *before* the session is minted, so that a failure between the two costs the
 * caller a credential rather than leaving one collectable twice. Losing a
 * credential means starting the flow again, which is annoying. Handing out two
 * from one approval is the failure this whole design exists to prevent.
 */
const collectEnrollmentRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const code = yield* codeFromRoute;
  if (code === null) {
    return notFound;
  }
  if (!(yield* withinRateLimit({ bucket: "collect", code, request }))) {
    return tooManyAttempts;
  }

  const enrollments = yield* DeviceEnrollmentRepository;
  const now = yield* DateTime.now;
  const applied = yield* enrollments.applyTransition({
    code,
    action: { type: "collect" },
    nowMs: DateTime.toEpochMillis(now),
    nowIso: DateTime.formatIso(DateTime.toUtc(now)),
  });

  if (applied.outcome === "not-found") {
    return notFound;
  }
  if (applied.outcome === "reject") {
    // `not-approved` is the ordinary shape of a poll, not an error: the person
    // simply has not clicked yet. It answers `425 Too Early` — "retry this
    // later, unchanged" — while every other rejection is a `409`, which means
    // the opposite: stop, this code will never work again. A poller that could
    // not tell those apart would either abandon a live enrollment or hammer a
    // dead one until the deadline. Never a 200: a client must not be able to
    // mistake a refusal for a credential.
    return json(
      { error: rejectionMessage(applied.reason), reason: applied.reason },
      applied.reason === "not-approved" ? 425 : 409,
    );
  }

  const record = applied.record;
  const subject = record.approvedBySubject;
  const ownerUserId = record.approvedByUserId;
  if (subject === null || ownerUserId === null) {
    // An approval recorded before this server knew how to write down a subject,
    // or a row written by something that skipped it. There is no safe guess
    // about whose session this should be, so there is no session. The owner is
    // held to the same standard: a credential nobody can be shown to own is a
    // credential nobody can revoke.
    yield* Effect.logWarning("device enrollment approved without a session subject");
    return json({ error: "This enrollment is not available." }, 409);
  }

  const sessions = yield* SessionCredentialService;
  const issued = yield* sessions.issue({
    // A bearer token, not a cookie: the collector is an application on somebody's
    // machine, and this is the same credential `/api/auth/bootstrap/bearer`
    // hands a paired client.
    method: "bearer-session-token",
    subject,
    role: record.approvedByRole === "owner" ? "owner" : "client",
    client: deriveAuthClientMetadata({
      request,
      ...(record.deviceLabel ? { label: record.deviceLabel } : {}),
    }),
  });

  /**
   * The account writes down which machine now holds that credential.
   *
   * This is the only instant where the machine, the person and the credential
   * are all in hand at once — after this the code is spent, the enrollment is
   * closed, and the token is on somebody's laptop. Left out, the machine has
   * access nothing can enumerate and nothing can end, which was the state of
   * the world before this call existed.
   *
   * So a failure here takes the credential back rather than shrugging. A
   * machine that has to start the flow over is a nuisance; a live session that
   * never reaches its owner's list of machines is the "I lost my laptop" case
   * with no answer, and that is what this whole feature is for. The enrollment
   * row is already `collected`, which is the same cost the doc comment above
   * already accepts for a failure at this point.
   */
  const machines = yield* AccountMachineRepository;
  const registered = yield* machines
    .register({
      userId: ownerUserId,
      authSessionId: issued.sessionId,
      label: record.deviceLabel,
      platform: record.devicePlatform,
      nowIso: DateTime.formatIso(DateTime.toUtc(now)),
    })
    .pipe(Effect.catch(() => Effect.succeed(null)));

  if (registered === null) {
    yield* Effect.logError("device enrollment could not register the collecting machine");
    // Best effort: if this fails too the session outlives the failure, but it
    // is at least an ordinary session that `Revoke others` can still reach.
    yield* sessions.revoke(issued.sessionId).pipe(Effect.catch(() => Effect.succeed(false)));
    return unavailable;
  }

  return json(
    {
      authenticated: true,
      role: issued.role,
      sessionMethod: "bearer-session-token",
      expiresAt: DateTime.formatIso(DateTime.toUtc(issued.expiresAt)),
      sessionToken: issued.token,
    },
    200,
  );
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

export const deviceEnrollmentCreateRouteLayer = HttpRouter.add(
  "POST",
  DEVICE_ENROLLMENTS_ROUTE,
  createEnrollmentRoute,
);

export const deviceEnrollmentPreviewRouteLayer = HttpRouter.add(
  "GET",
  DEVICE_ENROLLMENT_ROUTE,
  previewEnrollmentRoute,
);

/** The two that need a person. Everything else in this file is plumbing. */
export const deviceEnrollmentApproveRouteLayer = HttpRouter.add(
  "POST",
  DEVICE_ENROLLMENT_APPROVE_ROUTE,
  decideEnrollmentRoute("approve"),
);

export const deviceEnrollmentDenyRouteLayer = HttpRouter.add(
  "POST",
  DEVICE_ENROLLMENT_DENY_ROUTE,
  decideEnrollmentRoute("deny"),
);

export const deviceEnrollmentCollectRouteLayer = HttpRouter.add(
  "POST",
  DEVICE_ENROLLMENT_COLLECT_ROUTE,
  collectEnrollmentRoute,
);
