import { AuthSessionId, resolveMachineRole } from "@t3tools/contracts";
import { DateTime, Effect, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { resolveAuthenticatedUserId, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { AccountMachineRepository } from "../persistence/Services/AccountMachines.ts";
import type { AccountMachineRecord } from "../persistence/Services/AccountMachines.ts";

/**
 * "Which machines are connected to my account", and "cut that one off".
 *
 * Enrollment answers whether a machine may in; this answers what happened
 * afterwards. Both routes require a session and both scope everything to
 * `resolveAuthenticatedUserId`, because the entire value of the list is that it
 * is *yours* — a machine list that could be read across accounts would be a map
 * of somebody else's hardware.
 *
 *   person   GET  /api/devices/machines                  -> my machines
 *   person   POST /api/devices/machines/:id/revoke        -> that one is out
 *
 * The revoke route is the point of the feature, and the thing worth being
 * precise about: it revokes the *auth session* the machine holds before it
 * touches the machine row. Deleting a row while the token keeps working would
 * be a Disconnect button that disconnects nothing, and this exists precisely
 * for the case where the hardware is already in somebody else's hands.
 *
 * @module AccountMachines
 */

export const ACCOUNT_MACHINES_ROUTE = "/api/devices/machines";
export const ACCOUNT_MACHINE_REVOKE_ROUTE = `${ACCOUNT_MACHINES_ROUTE}/:machineId/revoke`;

/**
 * `no-store` because this is an account's inventory of its own hardware, and a
 * caching proxy that keeps it hands the next person on the connection a list of
 * where somebody works. The rest matches the enrollment routes.
 */
const MACHINE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

const json = (body: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: MACHINE_HEADERS });

const signInRequired = json({ error: "Sign in to manage connected machines." }, 401);

/**
 * The same sentence for "not yours" and "never existed".
 *
 * A caller who can tell those apart can probe for machine ids that belong to
 * other accounts, and learning that an id is real is the first half of caring
 * which account it belongs to.
 */
const notFound = json({ error: "This machine is not connected to your account." }, 404);

const unavailable = json({ error: "Connected machines are not available right now." }, 503);

const machineIdFromRoute = HttpRouter.params.pipe(
  Effect.map((params) => {
    const machineId = params["machineId"];
    return typeof machineId === "string" && machineId.length > 0 ? machineId : null;
  }),
);

/**
 * What a machine looks like to the person who owns it.
 *
 * The session id never travels. It is the account's link to a credential and
 * the browser has no use for it: everything the UI does is by `machineId`, and
 * a session id in a JSON body is one more place for it to end up in a log.
 *
 * `current` is the field that keeps this screen usable. Without it the list is
 * a row of identical-looking machines, one of which is the browser reading the
 * page, and the first thing a person does with a Disconnect button is lock
 * themselves out with it.
 *
 * `role` is the same argument made once more. A laptop and a deploy box are not
 * interchangeable and the consequences of cutting off the wrong one are not
 * comparable, but until this field they looked identical on this page.
 */
function toMachineView(machine: AccountMachineRecord, currentSessionId: string) {
  return {
    machineId: machine.machineId,
    label: machine.label,
    platform: machine.platform,
    /**
     * Resolved here rather than passed through, so the browser is never handed
     * a `null` to interpret. The rule about what an absent role means lives in
     * exactly one function and this is where it is applied on the way out —
     * every client, of every version, then sees a role it can render.
     */
    role: resolveMachineRole(machine),
    firstSeenAt: machine.firstSeenAt,
    lastSeenAt: machine.lastSeenAt,
    current: machine.authSessionId === currentSessionId,
  };
}

const authenticated = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth
    .authenticateHttpRequest(request)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  return session;
});

/**
 * `GET /api/devices/machines`
 *
 * Every machine of mine that still holds a credential, most recently seen
 * first, with the one asking marked.
 *
 * Asking also counts as being seen. That is the cheapest honest heartbeat
 * available: `last_seen_at` is documented as a floor rather than a timestamp of
 * the last request, and moving it here means a machine that opens Settings
 * stops looking abandoned without putting a write in front of every request the
 * server serves.
 */
const listMachinesRoute = Effect.gen(function* () {
  const session = yield* authenticated;
  if (session === null) {
    return signInRequired;
  }

  const machines = yield* AccountMachineRepository;
  const now = yield* DateTime.now;
  yield* machines.touchByAuthSession({
    authSessionId: session.sessionId,
    lastSeenAt: DateTime.formatIso(DateTime.toUtc(now)),
  });

  const owned = yield* machines.listActiveForUser({
    userId: resolveAuthenticatedUserId(session),
  });

  return json({ machines: owned.map((machine) => toMachineView(machine, session.sessionId)) }, 200);
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

/**
 * `POST /api/devices/machines/:machineId/revoke`
 *
 * The order below is the feature. The session is revoked first, and only then
 * is the row marked — so a crash between the two leaves a machine that is
 * genuinely locked out but still listed, which a person can press Disconnect on
 * again. The opposite order leaves a row that says "disconnected" next to a
 * token that still opens their projects, which is the lie this whole thing was
 * built to stop telling.
 */
const revokeMachineRoute = Effect.gen(function* () {
  const session = yield* authenticated;
  if (session === null) {
    return signInRequired;
  }

  const machineId = yield* machineIdFromRoute;
  if (machineId === null) {
    return notFound;
  }

  const machines = yield* AccountMachineRepository;
  const userId = resolveAuthenticatedUserId(session);
  const found = yield* machines.getForUser({ machineId, userId });
  if (Option.isNone(found) || found.value.revokedAt !== null) {
    return notFound;
  }

  const machine = found.value;
  if (machine.authSessionId === session.sessionId) {
    // Refused rather than obeyed, matching `revokeClientSession`: a request to
    // revoke the credential you are making the request with is nearly always a
    // misread row, and honouring it signs someone out of the only screen that
    // could have undone it. Signing out is the deliberate way to do this.
    return json(
      {
        error: "This is the device you are using. Sign out here instead of disconnecting it.",
        reason: "current-device",
      },
      403,
    );
  }

  const sessions = yield* SessionCredentialService;
  // The one line that makes Disconnect mean anything: `verify` refuses a
  // revoked session, so the machine's next request is a 401 whoever is holding
  // the hardware.
  yield* sessions.revoke(AuthSessionId.make(machine.authSessionId));

  const now = yield* DateTime.now;
  yield* machines.markRevoked({
    machineId,
    userId,
    revokedAt: DateTime.formatIso(DateTime.toUtc(now)),
  });

  return json({ revoked: true, machineId }, 200);
}).pipe(
  Effect.catch(() => Effect.succeed(unavailable)),
  Effect.catchDefect(() => Effect.succeed(unavailable)),
);

export const accountMachinesListRouteLayer = HttpRouter.add(
  "GET",
  ACCOUNT_MACHINES_ROUTE,
  listMachinesRoute,
);

export const accountMachineRevokeRouteLayer = HttpRouter.add(
  "POST",
  ACCOUNT_MACHINE_REVOKE_ROUTE,
  revokeMachineRoute,
);
