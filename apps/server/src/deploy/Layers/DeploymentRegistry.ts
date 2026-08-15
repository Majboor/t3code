import { DateTime, Effect, Layer, Option } from "effect";

import {
  type AnalyticsStream,
  type AnalyticsStreamId,
  type Deployment,
  DeploymentId,
  DeployError,
} from "@t3tools/contracts";

import { AnalyticsRepository } from "../../persistence/Services/Analytics.ts";
import { DeployRepository } from "../../persistence/Services/DeployTargets.ts";
import { DeploymentRepository } from "../../persistence/Services/Deployments.ts";
import {
  DeploymentRegistry,
  type DeploymentRegistryShape,
} from "../Services/DeploymentRegistry.ts";

/**
 * Turn the stream names a caller used into the ids a deployment stores.
 *
 * An unknown name is refused rather than dropped. A deployment that silently
 * forgot half the streams it was told about would read, later, as a deployment
 * that genuinely reports nothing — and the whole point of the link is to answer
 * "where do these numbers come from" without guessing.
 */
export function resolveStreamIds(
  declared: ReadonlyArray<Pick<AnalyticsStream, "id" | "name">>,
  requested: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly ids: ReadonlyArray<AnalyticsStreamId> }
  | { readonly ok: false; readonly missing: ReadonlyArray<string> } {
  const byName = new Map(declared.map((stream) => [stream.name as string, stream.id]));
  const ids: AnalyticsStreamId[] = [];
  const missing: string[] = [];

  for (const name of requested) {
    const id = byName.get(name);
    if (id === undefined) {
      missing.push(name);
      continue;
    }
    // The same stream named twice is one link, not two.
    if (!ids.includes(id)) ids.push(id);
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true, ids };
}

const makeDeploymentRegistry = Effect.gen(function* () {
  const deployments = yield* DeploymentRepository;
  const targets = yield* DeployRepository;
  const analytics = yield* AnalyticsRepository;

  const storageError = (message: string) => (cause: unknown) =>
    new DeployError({ code: "execution-failed", message, cause });

  const now = Effect.map(DateTime.now, (instant) => DateTime.formatIso(DateTime.toUtc(instant)));

  /** Resolve names against what the project has actually declared. */
  const streamIdsFor = (projectId: Deployment["projectId"], requested: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (requested.length === 0) return [] as ReadonlyArray<AnalyticsStreamId>;

      const declared = yield* analytics
        .listStreams({ projectId })
        .pipe(Effect.mapError(storageError("Failed to read the project's analytics streams.")));

      const resolved = resolveStreamIds(declared, requested);
      if (!resolved.ok) {
        return yield* new DeployError({
          code: "invalid-deployment",
          message: `${resolved.missing.join(", ")} ${
            resolved.missing.length === 1 ? "is not a stream" : "are not streams"
          } declared on this project, so a deployment cannot report to ${
            resolved.missing.length === 1 ? "it" : "them"
          }.`,
        });
      }
      return resolved.ids;
    });

  const getExisting = (deploymentId: DeploymentId) =>
    Effect.gen(function* () {
      const found = yield* deployments
        .get({ deploymentId })
        .pipe(Effect.mapError(storageError("Failed to read the deployment.")));
      if (Option.isNone(found) || found.value.archivedAt !== null) {
        return yield* new DeployError({
          code: "deployment-not-found",
          message: "That deployment is not registered.",
        });
      }
      return found.value;
    });

  const list: DeploymentRegistryShape["list"] = (input) =>
    deployments
      .list({
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      })
      .pipe(Effect.mapError(storageError("Failed to list deployments.")));

  const register: DeploymentRegistryShape["register"] = (input) =>
    Effect.gen(function* () {
      const target = yield* targets
        .getTarget({ targetId: input.targetId })
        .pipe(Effect.mapError(storageError("Failed to read the deploy target.")));
      if (Option.isNone(target)) {
        return yield* new DeployError({
          code: "target-not-found",
          message: "That deploy target does not exist.",
        });
      }
      // A deployment naming another project's target would put one project's
      // numbers behind another project's permission check.
      if (target.value.projectId !== input.projectId) {
        return yield* new DeployError({
          code: "invalid-deployment",
          message: "That deploy target belongs to a different project.",
        });
      }

      const analyticsStreamIds = yield* streamIdsFor(input.projectId, input.streams ?? []);
      const timestamp = yield* now;

      const existing = yield* deployments
        .find({ projectId: input.projectId, name: input.name })
        .pipe(Effect.mapError(storageError("Failed to read the deployment.")));

      const deployment: Deployment = Option.isSome(existing)
        ? {
            ...existing.value,
            targetId: input.targetId,
            url: input.url ?? existing.value.url,
            status: input.status ?? existing.value.status,
            lastRunId: input.lastRunId ?? existing.value.lastRunId,
            analyticsStreamIds:
              input.streams === undefined ? existing.value.analyticsStreamIds : analyticsStreamIds,
            updatedAt: timestamp,
          }
        : {
            id: DeploymentId.make(`deployment:${crypto.randomUUID()}`),
            projectId: input.projectId,
            targetId: input.targetId,
            name: input.name,
            url: input.url ?? null,
            // Registered without a claim about its state is exactly the case
            // `unknown` exists for.
            status: input.status ?? "unknown",
            lastRunId: input.lastRunId ?? null,
            analyticsStreamIds,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: null,
          };

      yield* deployments
        .upsert(deployment)
        .pipe(Effect.mapError(storageError("Failed to store the deployment.")));

      return deployment;
    });

  const update: DeploymentRegistryShape["update"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* getExisting(input.deploymentId);
      const analyticsStreamIds = yield* streamIdsFor(existing.projectId, input.streams ?? []);
      const timestamp = yield* now;

      const deployment: Deployment = {
        ...existing,
        url: input.url ?? existing.url,
        status: input.status ?? existing.status,
        lastRunId: input.lastRunId ?? existing.lastRunId,
        analyticsStreamIds:
          input.streams === undefined ? existing.analyticsStreamIds : analyticsStreamIds,
        updatedAt: timestamp,
      };

      yield* deployments
        .upsert(deployment)
        .pipe(Effect.mapError(storageError("Failed to store the deployment.")));

      return deployment;
    });

  const archive: DeploymentRegistryShape["archive"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* getExisting(input.deploymentId);
      const timestamp = yield* now;
      yield* deployments
        .upsert({ ...existing, updatedAt: timestamp, archivedAt: timestamp })
        .pipe(Effect.mapError(storageError("Failed to archive the deployment.")));
    });

  const projectOf: DeploymentRegistryShape["projectOf"] = (input) =>
    Effect.map(getExisting(input.deploymentId), (deployment) => deployment.projectId);

  return { list, register, update, archive, projectOf } satisfies DeploymentRegistryShape;
});

export const DeploymentRegistryLive = Layer.effect(DeploymentRegistry, makeDeploymentRegistry);
