import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import {
  DeployRun,
  DeployRunId,
  DeployTarget,
  DeployTargetId,
  ProjectId,
} from "@t3tools/contracts";

import type { PersistenceSqlError } from "../Errors.ts";

export const UpsertDeployTargetInput = DeployTarget;
export type UpsertDeployTargetInput = typeof UpsertDeployTargetInput.Type;

export const ListDeployTargetsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type ListDeployTargetsInput = typeof ListDeployTargetsInput.Type;

export const GetDeployTargetInput = Schema.Struct({
  targetId: DeployTargetId,
});
export type GetDeployTargetInput = typeof GetDeployTargetInput.Type;

export const UpsertDeployRunInput = DeployRun;
export type UpsertDeployRunInput = typeof UpsertDeployRunInput.Type;

export const ListDeployRunsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  targetId: Schema.optional(DeployTargetId),
  limit: Schema.optional(Schema.Int),
});
export type ListDeployRunsInput = typeof ListDeployRunsInput.Type;

export const GetDeployRunInput = Schema.Struct({
  runId: DeployRunId,
});
export type GetDeployRunInput = typeof GetDeployRunInput.Type;

export interface DeployRepositoryShape {
  readonly upsertTarget: (
    input: UpsertDeployTargetInput,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly listTargets: (
    input: ListDeployTargetsInput,
  ) => Effect.Effect<ReadonlyArray<DeployTarget>, PersistenceSqlError>;
  readonly getTarget: (
    input: GetDeployTargetInput,
  ) => Effect.Effect<Option.Option<DeployTarget>, PersistenceSqlError>;
  readonly upsertRun: (input: UpsertDeployRunInput) => Effect.Effect<void, PersistenceSqlError>;
  readonly listRuns: (
    input: ListDeployRunsInput,
  ) => Effect.Effect<ReadonlyArray<DeployRun>, PersistenceSqlError>;
  readonly getRun: (
    input: GetDeployRunInput,
  ) => Effect.Effect<Option.Option<DeployRun>, PersistenceSqlError>;
}

export class DeployRepository extends Context.Service<DeployRepository, DeployRepositoryShape>()(
  "t3/persistence/Services/DeployTargets/DeployRepository",
) {}
