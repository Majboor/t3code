/**
 * The one read the desktop shell makes on its own behalf.
 *
 * Everything the notch panel shows already exists, but only behind
 * `shareLinks.list` and `collaboration.usage.query` — Effect RPC over the `/ws`
 * socket, and both demanding a `tenantId`/`workspaceId` pair. The Electron main
 * process has neither half: no RPC client, and the ids live in renderer state
 * it cannot see. So the missing read is not "these numbers" but "these numbers
 * for whoever is signed in", and that is what this answers: the scope comes
 * from the session, so the caller names nothing.
 *
 * It is not a new way in. `authenticateHttpRequest` is the same guard every
 * other `/api` read uses, and the tenant is the one the session already
 * resolved to — this route can neither widen a caller's reach nor be reached
 * without a credential.
 *
 * Failures are reported per section rather than as a status code, because the
 * panel has to tell "nothing happened" from "we could not find out"; collapsing
 * the second into the first is how a dashboard starts lying.
 */

import type { TenantId, WorkspaceId } from "@t3tools/contracts";
import { Data, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { CollaborationService } from "../collaboration/Services/CollaborationService.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { ShareLinkService } from "../shareLinks/Services/ShareLinkService.ts";

export const DESKTOP_ACTIVITY_PATH = "/api/desktop/activity";

/**
 * A tenant with more workspaces than this is a dashboard's problem. The cap
 * exists so a hover panel refreshing every few seconds cannot turn into an
 * unbounded scan; going over it is reported as `partial` rather than hidden.
 */
const MAX_SCANNED_WORKSPACES = 24;

export interface DesktopShareViews {
  readonly total: number;
  readonly linkCount: number;
  readonly lastViewedAt: string | null;
}

export interface DesktopTokenSpend {
  /** An estimate from the server's rate table — see `MODEL_TOKEN_RATES_USD`. */
  readonly estimatedUsd: number;
  readonly totalTokens: number;
  /** Tokens from models with no published rate, excluded from `estimatedUsd`. */
  readonly unpricedTokens: number;
  readonly since: string | null;
  readonly until: string | null;
}

export interface DesktopActivity {
  readonly signedIn: boolean;
  readonly workspaceCount: number;
  /** Some workspace read failed or was skipped, so the sums are floors. */
  readonly partial: boolean;
  /** `null` means every read failed, which is not the same as zero. */
  readonly shareViews: DesktopShareViews | null;
  readonly tokenSpend: DesktopTokenSpend | null;
}

class DesktopActivityError extends Data.TaggedError("DesktopActivityError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** An authenticated session with no account behind it, e.g. desktop bootstrap. */
const SIGNED_OUT: DesktopActivity = {
  signedIn: false,
  workspaceCount: 0,
  partial: false,
  shareViews: null,
  tokenSpend: null,
};

interface WorkspaceScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/** ISO-8601 UTC sorts lexicographically, so the widest window is a string compare. */
function extendWindow(
  left: string | null,
  right: string | null,
  direction: "earliest" | "latest",
): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  const leftWins = direction === "earliest" ? left <= right : left >= right;
  return leftWins ? left : right;
}

export const desktopActivityRouteLayer = HttpRouter.add(
  "GET",
  DESKTOP_ACTIVITY_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);

    // Holding a session is not the same as being signed in: the desktop shell
    // has one from the moment the server starts. Saying so explicitly is what
    // keeps the panel from drawing a signed-out machine as a tenant that spent
    // nothing.
    const tenantSession = session.tenantSessionContext;
    if (!tenantSession) {
      return HttpServerResponse.jsonUnsafe(SIGNED_OUT satisfies DesktopActivity, { status: 200 });
    }

    const profile = yield* serverAuth.resolveUserProfile(session);
    const actor = {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarInitials: profile.avatarInitials,
    };

    const tenancy = yield* TenancyRepository;
    const shareLinks = yield* ShareLinkService;
    const collaboration = yield* CollaborationService;

    const snapshot = yield* tenancy.loadWorkspaces().pipe(
      Effect.mapError(
        (cause) =>
          new DesktopActivityError({ message: "Failed to load workspaces.", cause }),
      ),
    );
    const scopes: WorkspaceScope[] = snapshot.workspaces
      .filter(
        (workspace) =>
          workspace.tenantId === tenantSession.tenantId && workspace.archivedAt === null,
      )
      .map((workspace) => ({ tenantId: workspace.tenantId, workspaceId: workspace.id }));
    const scanned = scopes.slice(0, MAX_SCANNED_WORKSPACES);

    let readAnyShare = false;
    let shareTotal = 0;
    let shareLinkCount = 0;
    let shareLastViewedAt: string | null = null;

    let readAnyUsage = false;
    let estimatedUsd = 0;
    let totalTokens = 0;
    let unpricedTokens = 0;
    let since: string | null = null;
    let until: string | null = null;

    let partial = scanned.length < scopes.length;

    for (const scope of scanned) {
      // A workspace the caller is not on the roster for, or one whose read
      // fails, is skipped rather than fatal: one unreadable workspace should
      // cost the panel that workspace's numbers, not all of them. The skip is
      // what `partial` reports.
      const links = yield* shareLinks
        .list(actor, { tenantId: scope.tenantId, workspaceId: scope.workspaceId })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (links === null) {
        partial = true;
      } else {
        readAnyShare = true;
        shareLinkCount += links.links.length;
        for (const link of links.links) {
          shareTotal += link.viewCount;
          shareLastViewedAt = extendWindow(shareLastViewedAt, link.lastViewedAt, "latest");
        }
      }

      // The window is left to the server, which defaults to the last 30 days —
      // the same default the web usage panel runs on, so the two agree.
      const usage = yield* collaboration
        .queryUsage(actor, { tenantId: scope.tenantId, workspaceId: scope.workspaceId })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (usage === null) {
        partial = true;
      } else {
        readAnyUsage = true;
        estimatedUsd += usage.estimatedCost.estimatedTotalCost;
        totalTokens += usage.totals.totalTokens;
        unpricedTokens += usage.estimatedCost.unpricedTokens;
        since = extendWindow(since, usage.since, "earliest");
        until = extendWindow(until, usage.until, "latest");
      }
    }

    return HttpServerResponse.jsonUnsafe(
      {
        signedIn: true,
        workspaceCount: scopes.length,
        partial,
        shareViews: readAnyShare
          ? { total: shareTotal, linkCount: shareLinkCount, lastViewedAt: shareLastViewedAt }
          : null,
        tokenSpend: readAnyUsage
          ? { estimatedUsd, totalTokens, unpricedTokens, since, until }
          : null,
      } satisfies DesktopActivity,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("DesktopActivityError", (error) =>
      Effect.gen(function* () {
        yield* Effect.logError("desktop activity route failed", {
          message: error.message,
          cause: error.cause,
        });
        return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
      }),
    ),
  ),
);
