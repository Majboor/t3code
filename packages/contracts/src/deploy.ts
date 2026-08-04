/**
 * Deployment contracts.
 *
 * A deploy target describes how a project is shipped: either a command run
 * inside the workspace, or a command run on a remote host over SSH. Runs
 * record the outcome so agents and humans share the same history.
 *
 * @module deploy
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TenantId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const DeployTargetId = Schema.String.pipe(Schema.brand("DeployTargetId"));
export type DeployTargetId = typeof DeployTargetId.Type;

export const DeployRunId = Schema.String.pipe(Schema.brand("DeployRunId"));
export type DeployRunId = typeof DeployRunId.Type;

export const DeployTargetKind = Schema.Literals(["command", "ssh"]);
export type DeployTargetKind = typeof DeployTargetKind.Type;

/**
 * Remote host configuration. Passwords are stored in the server secret store,
 * never in the projection, so only the secret name travels over the wire.
 */
export const DeploySshConfig = Schema.Struct({
  host: TrimmedNonEmptyString,
  user: TrimmedNonEmptyString,
  port: Schema.optional(NonNegativeInt),
  identityFile: Schema.optional(TrimmedNonEmptyString),
  passwordSecretName: Schema.optional(TrimmedNonEmptyString),
  remotePath: Schema.optional(TrimmedNonEmptyString),
});
export type DeploySshConfig = typeof DeploySshConfig.Type;

export const DeployTarget = Schema.Struct({
  id: DeployTargetId,
  projectId: ProjectId,
  tenantId: Schema.NullOr(TenantId),
  name: TrimmedNonEmptyString,
  kind: DeployTargetKind,
  command: TrimmedNonEmptyString,
  ssh: Schema.NullOr(DeploySshConfig),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type DeployTarget = typeof DeployTarget.Type;

export const DeployRunStatus = Schema.Literals(["running", "succeeded", "failed"]);
export type DeployRunStatus = typeof DeployRunStatus.Type;

export const DeployRun = Schema.Struct({
  id: DeployRunId,
  targetId: DeployTargetId,
  projectId: ProjectId,
  status: DeployRunStatus,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.String,
  triggeredBy: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type DeployRun = typeof DeployRun.Type;

// Inputs

export const DeployCreateTargetInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  kind: DeployTargetKind,
  command: TrimmedNonEmptyString,
  ssh: Schema.optional(DeploySshConfig),
});
export type DeployCreateTargetInput = typeof DeployCreateTargetInput.Type;

export const DeployListTargetsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type DeployListTargetsInput = typeof DeployListTargetsInput.Type;

export const DeployListTargetsResult = Schema.Struct({
  targets: Schema.Array(DeployTarget),
});
export type DeployListTargetsResult = typeof DeployListTargetsResult.Type;

export const DeployCreateTargetResult = Schema.Struct({
  target: DeployTarget,
});
export type DeployCreateTargetResult = typeof DeployCreateTargetResult.Type;

export const DeployDeleteTargetInput = Schema.Struct({
  targetId: DeployTargetId,
});
export type DeployDeleteTargetInput = typeof DeployDeleteTargetInput.Type;

export const DeployRunInput = Schema.Struct({
  targetId: DeployTargetId,
});
export type DeployRunInput = typeof DeployRunInput.Type;

export const DeployRunResult = Schema.Struct({
  run: DeployRun,
});
export type DeployRunResult = typeof DeployRunResult.Type;

export const DeployListRunsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  targetId: Schema.optional(DeployTargetId),
  limit: Schema.optional(NonNegativeInt),
});
export type DeployListRunsInput = typeof DeployListRunsInput.Type;

export const DeployListRunsResult = Schema.Struct({
  runs: Schema.Array(DeployRun),
});
export type DeployListRunsResult = typeof DeployListRunsResult.Type;

export class DeployError extends Schema.TaggedErrorClass<DeployError>()("DeployError", {
  code: Schema.Literals([
    "target-not-found",
    "project-not-found",
    "invalid-target",
    "forbidden",
    "execution-failed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
