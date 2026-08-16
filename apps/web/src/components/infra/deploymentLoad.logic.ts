/**
 * What a project has live, and whether anything is actually reaching it.
 *
 * The infrastructure page used to list only enabled packs, which answers "what
 * did I turn on" and not "is any of it running". A deployment carries the
 * stream ids it reports to, and analytics can count events on a stream, so the
 * two together answer the question a person opens this page with: something is
 * deployed — is traffic hitting it?
 *
 * `events` is deliberately nullable and distinct from zero. A deployment wired
 * to no stream *cannot* report load, and saying "0 requests" about it would be
 * a measurement nobody took; a deployment wired to a stream that genuinely saw
 * nothing is a real zero and worth showing. Collapsing the two would make a
 * broken wiring look like a quiet afternoon.
 *
 * @module components/infra/deploymentLoad.logic
 */
import type { AnalyticsQueryResult, AnalyticsStream, Deployment } from "@t3tools/contracts";

import { linkDeployments, type DeploymentLink } from "../analytics/deploymentLinks.logic";

type NamedStream = Pick<AnalyticsStream, "id" | "name">;

export interface DeploymentLoad extends DeploymentLink {
  /** Events across every stream it reports to, or null when it reports to none. */
  readonly events: number | null;
}

/**
 * Adds up the buckets of one stream's query. A grouped query returns a bucket
 * per group, so the stream's total is their sum rather than the first row.
 */
export function totalEvents(result: AnalyticsQueryResult): number {
  return result.buckets.reduce((running, bucket) => running + bucket.events, 0);
}

/**
 * Joins deployments to their streams and to the counts those streams returned.
 *
 * Counts are keyed by stream *name* because that is what a query echoes back;
 * a stream a deployment names but which no longer resolves contributes nothing
 * and is already counted as `dangling` by `linkDeployments`.
 */
export function summariseLoad(
  deployments: ReadonlyArray<Deployment>,
  streams: ReadonlyArray<NamedStream>,
  countsByStreamName: ReadonlyMap<string, number>,
): ReadonlyArray<DeploymentLoad> {
  return linkDeployments(deployments, streams).map((link) => ({
    ...link,
    events:
      link.streamNames.length === 0
        ? null
        : link.streamNames.reduce(
            (running, name) => running + (countsByStreamName.get(name) ?? 0),
            0,
          ),
  }));
}

/**
 * How the load figure should read.
 *
 * The no-stream case says why there is no number rather than printing one,
 * because "nothing reported yet" and "nothing can report" send a reader to two
 * different places.
 */
export function describeLoad(load: DeploymentLoad): string {
  if (load.events === null) {
    return load.dangling > 0
      ? "Reports to a stream that no longer exists"
      : "Not wired to analytics, so it cannot report load";
  }
  if (load.events === 0) return "No traffic reported yet";
  return `${load.events.toLocaleString()} event${load.events === 1 ? "" : "s"} reported`;
}

/**
 * Live first, then whatever was touched most recently.
 *
 * Same rule as `orderForAttention` uses for packs: the thing a person came to
 * look at goes at the top, and the order does not shuffle as counts change.
 */
export function orderDeployments(
  loads: ReadonlyArray<DeploymentLoad>,
): ReadonlyArray<DeploymentLoad> {
  return loads.toSorted((left, right) => {
    const leftLive = left.deployment.status === "live";
    const rightLive = right.deployment.status === "live";
    if (leftLive !== rightLive) return leftLive ? -1 : 1;
    return right.deployment.updatedAt.localeCompare(left.deployment.updatedAt);
  });
}
