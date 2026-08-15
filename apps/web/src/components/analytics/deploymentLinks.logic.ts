/**
 * The link between what a project put live and the numbers it reports.
 *
 * A deployment stores stream ids and a person reads stream names, so something
 * has to resolve one into the other. Doing it here rather than in the component
 * keeps the interesting case testable: a deployment pointing at a stream that no
 * longer resolves. That happens when a stream is archived out from under a live
 * deployment, and it is worth showing rather than hiding — it means events are
 * being posted into nothing.
 *
 * @module components/analytics/deploymentLinks.logic
 */
import type { AnalyticsStream, AnalyticsStreamId, Deployment } from "@t3tools/contracts";

export interface DeploymentLink {
  readonly deployment: Deployment;
  /** Names of the streams it reports to, in the order the deployment lists them. */
  readonly streamNames: ReadonlyArray<string>;
  /** How many of its streams no longer resolve. */
  readonly dangling: number;
}

type NamedStream = Pick<AnalyticsStream, "id" | "name">;

export function linkDeployments(
  deployments: ReadonlyArray<Deployment>,
  streams: ReadonlyArray<NamedStream>,
): ReadonlyArray<DeploymentLink> {
  const nameById = new Map<string, string>(streams.map((stream) => [stream.id, stream.name]));

  return deployments.map((deployment) => {
    const streamNames: string[] = [];
    let dangling = 0;

    for (const id of deployment.analyticsStreamIds) {
      const name = nameById.get(id);
      if (name === undefined) {
        dangling += 1;
        continue;
      }
      streamNames.push(name);
    }

    return { deployment, streamNames, dangling };
  });
}

/**
 * The other direction: given a stream, who writes to it. Answering "where do
 * these numbers come from" is the whole reason the ids are stored.
 */
export function deploymentsReportingTo(
  streamId: AnalyticsStreamId,
  deployments: ReadonlyArray<Deployment>,
): ReadonlyArray<Deployment> {
  return deployments.filter((deployment) => deployment.analyticsStreamIds.includes(streamId));
}

/**
 * How a deployment's address should read. A deployment with no URL is a real
 * state — registered before it had one — and saying so beats an empty link.
 */
export function describeAddress(deployment: Deployment): string {
  return deployment.url ?? "no address yet";
}

/**
 * The deployment an offer to "make this report" should be about.
 *
 * Prefers one that is actually live: a stopped deployment is not a thing to wire
 * analytics into, and `unknown` only means nobody has said. Ties break on the
 * most recently updated, which is the one somebody was last working on.
 */
export function mostRecentLiveDeployment(
  deployments: ReadonlyArray<Deployment>,
): Deployment | null {
  const candidates = deployments.filter((deployment) => deployment.status !== "stopped");
  if (candidates.length === 0) return null;

  return candidates.reduce((best, deployment) => {
    if (best.status !== "live" && deployment.status === "live") return deployment;
    if (best.status === "live" && deployment.status !== "live") return best;
    return deployment.updatedAt > best.updatedAt ? deployment : best;
  });
}
