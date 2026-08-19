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
 *
 * `?projectId=` asks the same question about one project instead of the account.
 * It is one route rather than two because it is one read with two scopes, and
 * the panel shows one *or* the other — it is on a page about a project or it is
 * not — so naming a project also means the account-wide workspace scan is
 * skipped entirely rather than computed and thrown away.
 */

import { ProjectId, type TenantId, type WorkspaceId } from "@t3tools/contracts";
import { Data, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AnalyticsStore } from "../analytics/Services/AnalyticsStore.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { CollaborationService } from "../collaboration/Services/CollaborationService.ts";
import { DeploymentRegistry } from "../deploy/Services/DeploymentRegistry.ts";
import { DeployService } from "../deploy/Services/DeployService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { ShareLinkService } from "../shareLinks/Services/ShareLinkService.ts";

export const DESKTOP_ACTIVITY_PATH = "/api/desktop/activity";

/**
 * A tenant with more workspaces than this is a dashboard's problem. The cap
 * exists so a hover panel refreshing every few seconds cannot turn into an
 * unbounded scan; going over it is reported as `partial` rather than hidden.
 */
const MAX_SCANNED_WORKSPACES = 24;

/** The same cap, for the same reason, over a project's declared streams. */
const MAX_SCANNED_STREAMS = 12;

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

/**
 * One project's deployments and streams.
 *
 * The counts and the sums are separate fields on purpose. `streamCount` and
 * `reportingCount` are what let the panel say "nothing is declared to report
 * to" instead of printing `0` against a deployment that *cannot* report — the
 * same distinction `deploymentLoad.logic.ts` draws on the infrastructure page,
 * where collapsing the two would make broken wiring look like a quiet
 * afternoon.
 */
export interface DesktopProjectActivity {
  readonly deploymentCount: number;
  /** What the registry was told, not a probe: nothing here calls a deployment. */
  readonly liveCount: number;
  readonly reportingCount: number;
  readonly streamCount: number;
  /** Events across every declared stream. `null` when none could be counted. */
  readonly events: number | null;
  /** Events across the streams the deployments name. `null` when uncountable. */
  readonly reportedEvents: number | null;
  readonly lastDeployAt: string | null;
  readonly lastDeployStatus: string | null;
  /** A stream was skipped or failed to count, so the sums are floors. */
  readonly partial: boolean;
}

export interface DesktopActivity {
  readonly signedIn: boolean;
  readonly workspaceCount: number;
  /** Some workspace read failed or was skipped, so the sums are floors. */
  readonly partial: boolean;
  /** `null` means every read failed, which is not the same as zero. */
  readonly shareViews: DesktopShareViews | null;
  readonly tokenSpend: DesktopTokenSpend | null;
  /** Present only when the caller named a project, and never alongside sums. */
  readonly project: DesktopProjectActivity | null;
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
  project: null,
};

interface WorkspaceScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/** ISO-8601 UTC sorts lexicographically, so the widest window is a string compare. */
export function extendWindow(
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

/**
 * One stream's total.
 *
 * A grouped query answers with a bucket per group, so the total is their sum
 * and not the first row — the same rule `totalEvents` follows in
 * `apps/web/src/components/infra/deploymentLoad.logic.ts`. The addition happens
 * here so the panel is handed a figure rather than a table it would have to
 * re-derive, and so the two cannot drift apart.
 */
export function sumBucketEvents(buckets: ReadonlyArray<{ readonly events: number }>): number {
  return buckets.reduce((running, bucket) => running + bucket.events, 0);
}

/** `null` when the caller asked about the account rather than one project. */
function readRequestedProjectId(
  request: HttpServerRequest.HttpServerRequest,
): ProjectId | null {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return null;
  }
  const raw = url.value.searchParams.get("projectId")?.trim();
  // The id grants nothing by itself; `readProjectActivity` proves it is this
  // tenant's before it reads anything.
  return raw ? ProjectId.make(raw) : null;
}

type ProjectReading =
  | { readonly kind: "ok"; readonly project: DesktopProjectActivity }
  | { readonly kind: "not-found" };

/**
 * What one project has live, and whether anything is reaching it.
 *
 * The three list reads are all-or-nothing: if any of them fails the answer is a
 * 500 and the panel says "unavailable", because a `lastDeployAt` of `null` has
 * to mean "no deploy run was ever recorded" and nothing else. Only the
 * per-stream counts degrade, and they degrade to `partial`, which the panel
 * renders as a floor rather than as a total.
 */
const readProjectActivity = (
  projectId: ProjectId,
  tenantId: TenantId,
): Effect.Effect<
  ProjectReading,
  DesktopActivityError,
  ProjectionProjectRepository | DeploymentRegistry | DeployService | AnalyticsStore
> =>
  Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    const registry = yield* DeploymentRegistry;
    const deploys = yield* DeployService;
    const analytics = yield* AnalyticsStore;

    const fail = (message: string) => (cause: unknown) => new DesktopActivityError({ message, cause });

    const found = yield* projects
      .getById({ projectId })
      .pipe(Effect.mapError(fail("Failed to read the project.")));
    if (Option.isNone(found) || found.value.deletedAt !== null) {
      return { kind: "not-found" };
    }
    // Project ids are global and this one arrives in a query string, so without
    // this check any signed-in account could read any project's deployments by
    // typing its id. A project with no ownership at all predates tenancy and
    // belongs to whoever is running the server — the same allowance
    // `ShareLinkService.readProject` makes, and for the same reason: refusing it
    // would break every single-user install for a comparison with no other side.
    const ownership = found.value.ownership;
    if (ownership !== null && ownership.tenantId !== tenantId) {
      return { kind: "not-found" };
    }

    const deployments = yield* registry
      .list({ projectId })
      .pipe(Effect.mapError(fail("Failed to read the project's deployments.")));
    const streams = yield* analytics
      .listStreams({ projectId })
      .pipe(Effect.mapError(fail("Failed to read the project's analytics streams.")));
    const runs = yield* deploys
      .listRuns({ projectId, limit: 1 })
      .pipe(Effect.mapError(fail("Failed to read the project's deploy runs.")));

    const declaredIds = new Set<string>(streams.streams.map((stream) => stream.id));
    // A deployment naming a stream that is no longer declared cannot report,
    // which is why the id has to resolve before it counts as reporting — the
    // `dangling` case `linkDeployments` keeps separate for the same reason.
    const reportedIds = new Set<string>();
    let reportingCount = 0;
    for (const deployment of deployments) {
      const live = deployment.analyticsStreamIds.filter((id) => declaredIds.has(id));
      if (live.length > 0) {
        reportingCount += 1;
        for (const id of live) {
          reportedIds.add(id);
        }
      }
    }

    const scannedStreams = streams.streams.slice(0, MAX_SCANNED_STREAMS);
    let partial = scannedStreams.length < streams.streams.length;
    const countsById = new Map<string, number>();
    for (const stream of scannedStreams) {
      // One stream that will not answer costs the panel that stream, not every
      // stream; the skip is what `partial` reports.
      const result = yield* analytics
        .query({ projectId, stream: stream.name, aggregate: "count" })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (result === null) {
        partial = true;
      } else {
        countsById.set(stream.id, sumBucketEvents(result.buckets));
      }
    }

    const addUp = (ids: Iterable<string>): number | null => {
      let total = 0;
      let counted = 0;
      for (const id of ids) {
        const events = countsById.get(id);
        if (events !== undefined) {
          total += events;
          counted += 1;
        }
      }
      // Nothing counted is not the same as nothing happened.
      return counted === 0 ? null : total;
    };

    const lastRun = runs[0] ?? null;

    return {
      kind: "ok",
      project: {
        deploymentCount: deployments.length,
        liveCount: deployments.filter((deployment) => deployment.status === "live").length,
        reportingCount,
        streamCount: streams.streams.length,
        events: addUp(countsById.keys()),
        reportedEvents: addUp(reportedIds),
        lastDeployAt: lastRun?.startedAt ?? null,
        lastDeployStatus: lastRun?.status ?? null,
        partial,
      },
    };
  });

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

    const tenancy = yield* TenancyRepository;
    const snapshot = yield* tenancy
      .loadWorkspaces()
      .pipe(
        Effect.mapError(
          (cause) => new DesktopActivityError({ message: "Failed to load workspaces.", cause }),
        ),
      );
    const scopes: WorkspaceScope[] = snapshot.workspaces
      .filter(
        (workspace) =>
          workspace.tenantId === tenantSession.tenantId && workspace.archivedAt === null,
      )
      .map((workspace) => ({ tenantId: workspace.tenantId, workspaceId: workspace.id }));

    /*
     * A named project answers about that project and stops there. The panel is
     * either on a page about a project or it is not, so scanning every
     * workspace as well would be work it pays for on a fifteen-second cadence
     * and never draws.
     */
    const requestedProjectId = readRequestedProjectId(request);
    if (requestedProjectId !== null) {
      const reading = yield* readProjectActivity(requestedProjectId, tenantSession.tenantId);
      if (reading.kind === "not-found") {
        // Distinct from a 500: no retry fixes a project this account cannot
        // see, and the panel says so instead of blaming the server.
        return HttpServerResponse.jsonUnsafe({ error: "Unknown project." }, { status: 404 });
      }
      return HttpServerResponse.jsonUnsafe(
        {
          signedIn: true,
          workspaceCount: scopes.length,
          partial: false,
          shareViews: null,
          tokenSpend: null,
          project: reading.project,
        } satisfies DesktopActivity,
        { status: 200 },
      );
    }

    const profile = yield* serverAuth.resolveUserProfile(session);
    const actor = {
      userId: profile.userId,
      displayName: profile.displayName,
      avatarInitials: profile.avatarInitials,
    };

    const shareLinks = yield* ShareLinkService;
    const collaboration = yield* CollaborationService;

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
        project: null,
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
