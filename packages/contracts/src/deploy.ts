/**
 * Deployment contracts.
 *
 * A deploy target describes how a project is shipped: either a command run
 * inside the workspace, or a command run on a remote host over SSH. Runs
 * record the outcome so agents and humans share the same history.
 *
 * A **deployment** is the third idea, and the one the first two cannot express:
 * the thing that is live. A target is a recipe and a run is an event, so
 * between them nothing answers "what is serving right now, at what URL, and
 * which numbers does it report?" That question is what a deployment is for.
 *
 * @module deploy
 */
import { Schema } from "effect";

import { AnalyticsName, AnalyticsProperty, AnalyticsStreamId } from "./analytics.ts";
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

// ── what is live ────────────────────────────────────────────────────────────

/**
 * Whether the deployment is believed to be serving. `unknown` is the honest
 * default: nothing here probes the URL, so a deployment registered and never
 * spoken about again should not keep claiming to be live.
 */
export const DeploymentStatus = Schema.Literals(["live", "stopped", "unknown"]);
export type DeploymentStatus = typeof DeploymentStatus.Type;

export const DeploymentId = Schema.String.pipe(Schema.brand("DeploymentId"));
export type DeploymentId = typeof DeploymentId.Type;

/**
 * Something a project put live.
 *
 * `analyticsStreamIds` holds ids rather than names so the link survives a
 * rename, and it is the whole of the deploy↔analytics connection: given a
 * deployment you can reach its numbers, and given a stream you can find every
 * deployment writing to it.
 */
export const Deployment = Schema.Struct({
  id: DeploymentId,
  projectId: ProjectId,
  /** The target whose run produced this. */
  targetId: DeployTargetId,
  name: TrimmedNonEmptyString,
  /** Where it is reachable. Null while a deployment exists but has no address. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  status: DeploymentStatus,
  /** The most recent run that updated it, if it was deployed through T3. */
  lastRunId: Schema.NullOr(DeployRunId),
  analyticsStreamIds: Schema.Array(AnalyticsStreamId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Deployment = typeof Deployment.Type;

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

/**
 * Ask a deploy to hand the deployment a working ingest key.
 *
 * The key is minted during the deploy and injected into the deploy process's
 * environment, and that is the only place it ever exists outside the deployment
 * itself — it is not stored, not returned over the wire, and redacted out of the
 * captured output. That is the whole point: an ingest key is kept hashed so a
 * leaked database cannot write to anybody's numbers, so there is no later moment
 * at which a key can be handed out. Declaring and injecting have to be the same
 * step or one of those two properties has to go.
 *
 * If the stream already exists its key is reissued, which stops the old one
 * working. A stream that other live deployments report to is therefore refused
 * rather than quietly cut off.
 */
export const DeployAnalyticsInjection = Schema.Struct({
  /** The stream this deployment reports to; declared now if it does not exist. */
  stream: AnalyticsName,
  /** Environment variable the key arrives as. Defaults to T3_ANALYTICS_INGEST_KEY. */
  keyVariable: Schema.optional(TrimmedNonEmptyString),
  /** Used only when the stream has to be declared. */
  purpose: Schema.optional(TrimmedNonEmptyString),
  properties: Schema.optional(Schema.Array(AnalyticsProperty)),
  /** Registered under this name once the run succeeds. Defaults to the target's name. */
  deploymentName: Schema.optional(TrimmedNonEmptyString),
  /** Where the deployment ends up reachable, if the caller knows it up front. */
  url: Schema.optional(TrimmedNonEmptyString),
});
export type DeployAnalyticsInjection = typeof DeployAnalyticsInjection.Type;

export const DeployRunInput = Schema.Struct({
  targetId: DeployTargetId,
  analytics: Schema.optional(DeployAnalyticsInjection),
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

// ── registering what is live ────────────────────────────────────────────────

/**
 * Streams are named rather than referenced by id here: the caller is usually an
 * agent that has just read a stream list, or written the declaration itself, and
 * a name is what it has in hand. The service resolves them, which is also what
 * proves they were declared on this project.
 */
export const DeploymentRegisterInput = Schema.Struct({
  projectId: ProjectId,
  targetId: DeployTargetId,
  name: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(DeploymentStatus),
  lastRunId: Schema.optional(DeployRunId),
  streams: Schema.optional(Schema.Array(AnalyticsName)),
});
export type DeploymentRegisterInput = typeof DeploymentRegisterInput.Type;

export const DeploymentRegisterResult = Schema.Struct({
  deployment: Deployment,
});
export type DeploymentRegisterResult = typeof DeploymentRegisterResult.Type;

export const DeploymentListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  targetId: Schema.optional(DeployTargetId),
});
export type DeploymentListInput = typeof DeploymentListInput.Type;

export const DeploymentListResult = Schema.Struct({
  deployments: Schema.Array(Deployment),
});
export type DeploymentListResult = typeof DeploymentListResult.Type;

/**
 * Every field is optional and an omitted one is left alone. `streams`, when
 * given, replaces the set rather than adding to it — "these are the streams it
 * reports to" is the only statement a caller can make without first reading
 * what is already there.
 */
export const DeploymentUpdateInput = Schema.Struct({
  deploymentId: DeploymentId,
  url: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(DeploymentStatus),
  lastRunId: Schema.optional(DeployRunId),
  streams: Schema.optional(Schema.Array(AnalyticsName)),
});
export type DeploymentUpdateInput = typeof DeploymentUpdateInput.Type;

export const DeploymentUpdateResult = Schema.Struct({
  deployment: Deployment,
});
export type DeploymentUpdateResult = typeof DeploymentUpdateResult.Type;

export const DeploymentArchiveInput = Schema.Struct({
  deploymentId: DeploymentId,
});
export type DeploymentArchiveInput = typeof DeploymentArchiveInput.Type;

export class DeployError extends Schema.TaggedErrorClass<DeployError>()("DeployError", {
  code: Schema.Literals([
    "target-not-found",
    "project-not-found",
    "invalid-target",
    "forbidden",
    "execution-failed",
    "deployment-not-found",
    "invalid-deployment",
    /** Issuing a key here would have cut off a deployment already using it. */
    "analytics-conflict",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
