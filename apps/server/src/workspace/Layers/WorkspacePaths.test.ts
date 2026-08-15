import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { WorkspacePathsLive, workspaceRootComparisonKey } from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.fn("makeTempDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-paths-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspacePathsLive", (it) => {
  describe("normalizeWorkspaceRoot", () => {
    it.effect("resolves an existing directory to its canonical path", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(cwd);

        expect(resolved).toBe(yield* fileSystem.realPath(cwd));
      }),
    );

    it.effect("normalizes a symlinked root and its target to the same path", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir();
        const target = path.join(cwd, "real-project");
        const link = path.join(cwd, "linked-project");
        yield* fileSystem.makeDirectory(target, { recursive: true }).pipe(Effect.orDie);
        yield* fileSystem.symlink(target, link).pipe(Effect.orDie);

        const viaTarget = yield* workspacePaths.normalizeWorkspaceRoot(target);
        const viaLink = yield* workspacePaths.normalizeWorkspaceRoot(link);

        // Registering the same folder under two names must not look like two
        // folders, or project.create cannot refuse the duplicate.
        expect(viaLink).toBe(viaTarget);
      }),
    );

    it.effect("normalizes trailing separators away", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(` ${cwd}/ `);

        expect(resolved).toBe(yield* workspacePaths.normalizeWorkspaceRoot(cwd));
      }),
    );

    it.effect("rejects missing directories", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const error = yield* workspacePaths
          .normalizeWorkspaceRoot(path.join(cwd, "missing"))
          .pipe(Effect.flip);

        expect(error.message).toContain("Workspace root does not exist:");
      }),
    );

    it.effect("creates missing directories when createIfMissing is enabled", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const missingPath = path.join(cwd, "nested", "new-project");

        const resolved = yield* workspacePaths.normalizeWorkspaceRoot(missingPath, {
          createIfMissing: true,
        });
        const stat = yield* fileSystem.stat(resolved);

        expect(resolved).toBe(yield* fileSystem.realPath(missingPath));
        expect(stat.type).toBe("Directory");
      }),
    );

    it.effect("rejects file paths", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "README.md");
        yield* writeTextFile(cwd, "README.md", "# hi\n");

        const error = yield* workspacePaths.normalizeWorkspaceRoot(filePath).pipe(Effect.flip);

        expect(error.message).toContain("Workspace root is not a directory:");
      }),
    );
  });

  describe("resolveRelativePathWithinRoot", () => {
    it.effect("resolves relative paths inside the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();
        const path = yield* Path.Path;

        const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: cwd,
          relativePath: "plans/effect-rpc.md",
        });

        expect(resolved).toEqual({
          absolutePath: path.join(cwd, "plans/effect-rpc.md"),
          relativePath: "plans/effect-rpc.md",
        });
      }),
    );

    it.effect("rejects paths that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths;
        const cwd = yield* makeTempDir();

        const error = yield* workspacePaths
          .resolveRelativePathWithinRoot({
            workspaceRoot: cwd,
            relativePath: "../escape.md",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );
  });
});

describe("workspaceRootComparisonKey", () => {
  it("folds case on filesystems that are case-insensitive by default", () => {
    expect(workspaceRootComparisonKey("/Users/Hico/Aero-Build", "darwin")).toBe(
      workspaceRootComparisonKey("/users/hico/aero-build", "darwin"),
    );
    expect(workspaceRootComparisonKey("C:\\Work\\Repo", "win32")).toBe(
      workspaceRootComparisonKey("c:\\work\\repo", "win32"),
    );
  });

  it("keeps case significant on case-sensitive filesystems", () => {
    expect(workspaceRootComparisonKey("/repo/Foo", "linux")).not.toBe(
      workspaceRootComparisonKey("/repo/foo", "linux"),
    );
  });

  it("ignores surrounding whitespace", () => {
    expect(workspaceRootComparisonKey("  /repo/app  ", "linux")).toBe("/repo/app");
  });
});
