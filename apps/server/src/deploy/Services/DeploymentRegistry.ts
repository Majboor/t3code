import { Context } from "effect";
import type { Effect } from "effect";

import type {
  Deployment,
  DeploymentArchiveInput,
  DeploymentId,
  DeploymentRegisterInput,
  DeploymentUpdateInput,
  DeployError,
  DeployTargetId,
  ProjectId,
} from "@t3tools/contracts";

export interface DeploymentRegistryShape {
  readonly list: (input: {
    readonly projectId?: ProjectId;
    readonly targetId?: DeployTargetId;
  }) => Effect.Effect<ReadonlyArray<Deployment>, DeployError>;

  /**
   * Record what a target put live. Registering the same name twice on one
   * project updates the deployment rather than opening a second one: re-running
   * a deploy replaces what is serving, it does not add to it.
   */
  readonly register: (input: DeploymentRegisterInput) => Effect.Effect<Deployment, DeployError>;

  readonly update: (input: DeploymentUpdateInput) => Effect.Effect<Deployment, DeployError>;

  readonly archive: (input: DeploymentArchiveInput) => Effect.Effect<void, DeployError>;

  /** The project a deployment belongs to, for the permission check above the RPC. */
  readonly projectOf: (input: {
    readonly deploymentId: DeploymentId;
  }) => Effect.Effect<ProjectId, DeployError>;
}

export class DeploymentRegistry extends Context.Service<
  DeploymentRegistry,
  DeploymentRegistryShape
>()("t3/deploy/Services/DeploymentRegistry") {}
