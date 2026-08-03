import { IsoDateTime, NonNegativeInt, TenantId, ThreadId, UserId } from "@t3tools/contracts";
import { Context, Effect, Schema } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPreference = Schema.Struct({
  tenantId: TenantId,
  userId: UserId,
  threadId: ThreadId,
  favorite: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPreference = typeof ProjectionThreadPreference.Type;

export const UpsertProjectionThreadPreferenceInput = ProjectionThreadPreference;
export type UpsertProjectionThreadPreferenceInput =
  typeof UpsertProjectionThreadPreferenceInput.Type;

export const ListProjectionThreadPreferencesByUserInput = Schema.Struct({
  tenantId: TenantId,
  userId: UserId,
});
export type ListProjectionThreadPreferencesByUserInput =
  typeof ListProjectionThreadPreferencesByUserInput.Type;

export interface ProjectionThreadPreferenceRepositoryShape {
  readonly upsert: (
    input: UpsertProjectionThreadPreferenceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByUser: (
    input: ListProjectionThreadPreferencesByUserInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPreference>, ProjectionRepositoryError>;
}

export class ProjectionThreadPreferenceRepository extends Context.Service<
  ProjectionThreadPreferenceRepository,
  ProjectionThreadPreferenceRepositoryShape
>()("t3/persistence/Services/ProjectionThreadPreferences/ProjectionThreadPreferenceRepository") {}
