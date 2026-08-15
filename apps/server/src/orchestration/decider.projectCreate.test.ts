import {
  CommandId,
  type OrchestrationReadModel,
  parseWorkspaceRootAlreadyClaimedProjectId,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = new Date().toISOString();

const decideProjectCreate = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly projectId: string;
  readonly workspaceRoot: string;
}) =>
  decideOrchestrationCommand({
    command: {
      type: "project.create",
      commandId: CommandId.make(`cmd-${input.projectId}`),
      projectId: ProjectId.make(input.projectId),
      title: "Aero Build",
      workspaceRoot: input.workspaceRoot,
      createdAt: now,
    },
    readModel: input.readModel,
  });

const readModelWithProject = (input: {
  readonly projectId: string;
  readonly workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const emptyReadModel = createEmptyReadModel(now);
    const decided = yield* decideProjectCreate({ ...input, readModel: emptyReadModel });
    const event = Array.isArray(decided) ? decided[0]! : decided;
    return yield* projectEvent(emptyReadModel, { ...event, sequence: 1 });
  });

describe("decider project.create workspace root uniqueness", () => {
  it("refuses a second project for a workspace root an active project already owns", async () => {
    const error = await Effect.runPromise(
      readModelWithProject({
        projectId: "project-aero",
        workspaceRoot: "/Users/hico/aero-build",
      }).pipe(
        Effect.flatMap((readModel) =>
          decideProjectCreate({
            readModel,
            projectId: "project-aero-duplicate",
            workspaceRoot: "/Users/hico/aero-build",
          }),
        ),
        Effect.flip,
      ),
    );

    // The failure has to name the project that already owns the folder, so the
    // caller can open it instead of minting yet another row.
    expect(parseWorkspaceRootAlreadyClaimedProjectId(error)).toBe("project-aero");
  });

  it("still allows a different workspace root", async () => {
    const event = await Effect.runPromise(
      readModelWithProject({
        projectId: "project-aero",
        workspaceRoot: "/Users/hico/aero-build",
      }).pipe(
        Effect.flatMap((readModel) =>
          decideProjectCreate({
            readModel,
            projectId: "project-p40",
            workspaceRoot: "/Users/hico/p40",
          }),
        ),
        Effect.map((decided) => (Array.isArray(decided) ? decided[0]! : decided)),
      ),
    );

    expect(event.type).toBe("project.created");
  });
});

const decideProjectMetaUpdate = (input: {
  readonly readModel: OrchestrationReadModel;
  readonly projectId: string;
  readonly workspaceRoot: string;
}) =>
  decideOrchestrationCommand({
    command: {
      type: "project.meta.update",
      commandId: CommandId.make(`cmd-meta-${input.projectId}`),
      projectId: ProjectId.make(input.projectId),
      workspaceRoot: input.workspaceRoot,
    },
    readModel: input.readModel,
  });

/**
 * Same folder-identity rule as `project.create`. Without it the refusal is only
 * a speed bump: create somewhere free, then move onto the taken folder.
 */
describe("decider project.meta.update workspace root uniqueness", () => {
  const twoProjects = Effect.gen(function* () {
    const withFirst = yield* readModelWithProject({
      projectId: "project-aero",
      workspaceRoot: "/Users/hico/aero-build",
    });
    const decided = yield* decideProjectCreate({
      readModel: withFirst,
      projectId: "project-p40",
      workspaceRoot: "/Users/hico/p40",
    });
    const event = Array.isArray(decided) ? decided[0]! : decided;
    return yield* projectEvent(withFirst, { ...event, sequence: 2 });
  });

  it("refuses to move a project onto a folder another project already owns", async () => {
    const error = await Effect.runPromise(
      twoProjects.pipe(
        Effect.flatMap((readModel) =>
          decideProjectMetaUpdate({
            readModel,
            projectId: "project-p40",
            workspaceRoot: "/Users/hico/aero-build",
          }),
        ),
        Effect.flip,
      ),
    );

    expect(parseWorkspaceRootAlreadyClaimedProjectId(error)).toBe("project-aero");
  });

  it("lets a project keep the folder it already owns", async () => {
    const event = await Effect.runPromise(
      twoProjects.pipe(
        Effect.flatMap((readModel) =>
          decideProjectMetaUpdate({
            readModel,
            projectId: "project-aero",
            workspaceRoot: "/Users/hico/aero-build",
          }),
        ),
        Effect.map((decided) => (Array.isArray(decided) ? decided[0]! : decided)),
      ),
    );

    expect(event.type).toBe("project.meta-updated");
  });
});
