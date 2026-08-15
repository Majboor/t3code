import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import {
  Deployment,
  DeploymentId,
  DeployTargetId,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

export const UpsertDeploymentInput = Deployment;
export type UpsertDeploymentInput = typeof UpsertDeploymentInput.Type;

export const ListDeploymentsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  targetId: Schema.optional(DeployTargetId),
});
export type ListDeploymentsInput = typeof ListDeploymentsInput.Type;

export const GetDeploymentInput = Schema.Struct({
  deploymentId: DeploymentId,
});
export type GetDeploymentInput = typeof GetDeploymentInput.Type;

/**
 * A deployment is addressed by project and name wherever an id is not already
 * in hand — which is everywhere an agent speaks about it.
 */
export const FindDeploymentInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
});
export type FindDeploymentInput = typeof FindDeploymentInput.Type;

export interface DeploymentRepositoryShape {
  readonly upsert: (input: UpsertDeploymentInput) => Effect.Effect<void, PersistenceSqlError>;
  readonly list: (
    input: ListDeploymentsInput,
  ) => Effect.Effect<ReadonlyArray<Deployment>, PersistenceSqlError>;
  readonly get: (
    input: GetDeploymentInput,
  ) => Effect.Effect<Option.Option<Deployment>, PersistenceSqlError>;
  readonly find: (
    input: FindDeploymentInput,
  ) => Effect.Effect<Option.Option<Deployment>, PersistenceSqlError>;
}

export class DeploymentRepository extends Context.Service<
  DeploymentRepository,
  DeploymentRepositoryShape
>()("t3/persistence/Services/Deployments/DeploymentRepository") {}
