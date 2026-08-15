import * as OS from "node:os";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "win32"]);

/**
 * Key for "is this the same folder?" comparisons.
 *
 * Normalization stores the realpath so the persisted workspace root stays the
 * human-readable path the user recognises; case is folded only here, in the
 * comparison, and only on filesystems that are case-insensitive by default.
 * Folding everywhere would make `/repo/Foo` and `/repo/foo` collide on Linux,
 * where they really are two different folders.
 */
export function workspaceRootComparisonKey(
  workspaceRoot: string,
  platform: string = process.platform,
): string {
  const trimmed = workspaceRoot.trim();
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? trimmed.toLowerCase() : trimmed;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
            }),
        ),
      );
      workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }

    // Two names for one folder must normalize to one string, or project.create
    // cannot see that a folder is already registered. realpath collapses
    // symlinked ancestors (/tmp -> /private/tmp, a symlinked home, a symlinked
    // checkout). It cannot fail here now that the directory is known to exist,
    // but a racing unlink or a permission error must not turn a working
    // registration into an error, so fall back to the resolved path.
    return yield* fileSystem
      .realPath(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(normalizedWorkspaceRoot)));
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);
