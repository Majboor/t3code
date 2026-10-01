import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { JOINED_PROJECT_CREATE_REFUSAL } from "./projectKindRules.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-kind-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const now = new Date().toISOString();

const projectCreate = (input: {
  readonly workspaceRoot: string;
  readonly kind?: "local" | "hosted" | "self-hosted" | "joined" | null;
}) =>
  ({
    type: "project.create",
    commandId: CommandId.make("cmd-normalizer-kind"),
    projectId: ProjectId.make("project-normalizer-kind"),
    title: "Aero Build",
    workspaceRoot: input.workspaceRoot,
    createWorkspaceRootIfMissing: true,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    createdAt: now,
  }) as Parameters<typeof normalizeDispatchCommand>[0];

it.layer(TestLayer)("normalizeDispatchCommand project.create kind", (it) => {
  describe("a kind nobody can create", () => {
    it.effect("refuses joined before the workspace directory it asked for is created", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-normalizer-kind-",
        });
        const workspaceRoot = path.join(parent, "joined-project");

        const error = yield* normalizeDispatchCommand(
          projectCreate({ workspaceRoot, kind: "joined" }),
        ).pipe(Effect.flip);

        expect(error.message).toBe(JOINED_PROJECT_CREATE_REFUSAL);
        // The reason the check sits where it does. `createWorkspaceRootIfMissing`
        // was set, so a refusal made one step later would have left this folder
        // on disk for a project the server never created.
        expect(yield* fileSystem.exists(workspaceRoot)).toBe(false);
      }),
    );
  });

  describe("the kinds that travel", () => {
    it.effect("carries a stated kind through normalization untouched", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-normalizer-kind-",
        });
        const workspaceRoot = path.join(parent, "hosted-project");

        const normalized = yield* normalizeDispatchCommand(
          projectCreate({ workspaceRoot, kind: "hosted" }),
        );

        expect(normalized.type).toBe("project.create");
        expect(normalized).toMatchObject({ kind: "hosted" });
        expect(yield* fileSystem.exists(workspaceRoot)).toBe(true);
      }),
    );

    it.effect("leaves an omitted kind omitted rather than settling it to local", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-normalizer-kind-",
        });
        const workspaceRoot = path.join(parent, "unstated-project");

        const normalized = yield* normalizeDispatchCommand(projectCreate({ workspaceRoot }));

        // "Nobody chose" and "somebody chose local" have to stay different
        // facts, which is the whole reason the column is nullable. Every client
        // that predates kinds — `t3 project add` included — arrives here.
        expect("kind" in normalized).toBe(false);
        expect(yield* fileSystem.exists(workspaceRoot)).toBe(true);
      }),
    );
  });
});
