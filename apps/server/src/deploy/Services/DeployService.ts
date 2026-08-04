import { Context } from "effect";
import type { Effect } from "effect";

import type {
  DeployCreateTargetInput,
  DeployError,
  DeployRun,
  DeployTarget,
  DeployTargetId,
  ProjectId,
} from "@t3tools/contracts";

export interface DeployActor {
  readonly label: string;
}

export interface DeployServiceShape {
  readonly listTargets: (input: {
    readonly projectId?: ProjectId;
  }) => Effect.Effect<ReadonlyArray<DeployTarget>, DeployError>;

  readonly createTarget: (
    input: DeployCreateTargetInput,
  ) => Effect.Effect<DeployTarget, DeployError>;

  readonly deleteTarget: (input: {
    readonly targetId: DeployTargetId;
  }) => Effect.Effect<void, DeployError>;

  /**
   * Execute a deploy target and record the run. Resolves once the deploy
   * process exits; a non-zero exit is reported as a failed run, not an error.
   */
  readonly run: (input: {
    readonly targetId: DeployTargetId;
    readonly actor: DeployActor;
    readonly workspaceRoot: string;
  }) => Effect.Effect<DeployRun, DeployError>;

  readonly listRuns: (input: {
    readonly projectId?: ProjectId;
    readonly targetId?: DeployTargetId;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<DeployRun>, DeployError>;
}

export class DeployService extends Context.Service<DeployService, DeployServiceShape>()(
  "t3/deploy/Services/DeployService",
) {}
