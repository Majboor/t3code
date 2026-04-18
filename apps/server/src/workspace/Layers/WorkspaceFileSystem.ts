import fsPromises from "node:fs/promises";

import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

const PROJECT_EDITOR_MAX_BYTES = 512_000;

function isProbablyBinaryContent(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, 1_024));
  let suspiciousByteCount = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isControlByte = byte < 7 || (byte > 14 && byte < 32);
    if (isControlByte) {
      suspiciousByteCount += 1;
    }
  }

  return suspiciousByteCount / sample.length > 0.2;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const resolveTargetPath = Effect.fn("WorkspaceFileSystem.resolveTargetPath")(function* (input: {
    cwd: string;
    relativePath: string;
  }) {
    return yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
  });

  const ensureTargetParentDirectory = Effect.fn("WorkspaceFileSystem.ensureTargetParentDirectory")(
    function* (input: { cwd: string; relativePath: string; absolutePath: string }) {
      yield* fileSystem.makeDirectory(path.dirname(input.absolutePath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.makeDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
    },
  );

  const pathExists = Effect.fn("WorkspaceFileSystem.pathExists")(function* (input: {
    cwd: string;
    relativePath: string;
    absolutePath: string;
  }) {
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          await fsPromises.stat(input.absolutePath);
          return true;
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
            return false;
          }
          throw cause;
        }
      },
      catch: (cause) => {
        return new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.stat",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      },
    });
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* resolveTargetPath({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });

      const stats = yield* Effect.tryPromise({
        try: () => fsPromises.stat(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.stat",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      if (!stats.isFile()) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "Target path is not a file.",
        });
      }

      if (stats.size > PROJECT_EDITOR_MAX_BYTES) {
        return {
          relativePath: target.relativePath,
          contents: "",
          isBinary: false,
          tooLarge: true,
          sizeBytes: stats.size,
        };
      }

      const bytes = yield* Effect.tryPromise({
        try: () => fsPromises.readFile(target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      if (isProbablyBinaryContent(bytes)) {
        return {
          relativePath: target.relativePath,
          contents: "",
          isBinary: true,
          tooLarge: false,
          sizeBytes: bytes.length,
        };
      }

      return {
        relativePath: target.relativePath,
        contents: bytes.toString("utf8"),
        isBinary: false,
        tooLarge: false,
        sizeBytes: bytes.length,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* resolveTargetPath({
      cwd: input.cwd,
      relativePath: input.relativePath,
    });

    yield* ensureTargetParentDirectory({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });

    if (input.encoding === "base64") {
      yield* Effect.tryPromise({
        try: () => fsPromises.writeFile(target.absolutePath, Buffer.from(input.contents, "base64")),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    } else {
      yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.writeFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
    }

    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createEntry: WorkspaceFileSystemShape["createEntry"] = Effect.fn(
    "WorkspaceFileSystem.createEntry",
  )(function* (input) {
    const target = yield* resolveTargetPath({
      cwd: input.cwd,
      relativePath: input.relativePath,
    });

    const exists = yield* pathExists({
      cwd: input.cwd,
      relativePath: input.relativePath,
      absolutePath: target.absolutePath,
    });

    if (exists) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.createEntry",
        detail: "Target path already exists.",
      });
    }

    if (input.kind === "directory") {
      yield* fileSystem.makeDirectory(target.absolutePath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.makeDirectory",
              detail: cause.message,
              cause,
            }),
        ),
      );
    } else {
      yield* ensureTargetParentDirectory({
        cwd: input.cwd,
        relativePath: input.relativePath,
        absolutePath: target.absolutePath,
      });
      yield* fileSystem.writeFileString(target.absolutePath, "").pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceFileSystemError({
              cwd: input.cwd,
              relativePath: input.relativePath,
              operation: "workspaceFileSystem.createFile",
              detail: cause.message,
              cause,
            }),
        ),
      );
    }

    yield* workspaceEntries.invalidate(input.cwd);
    return {
      relativePath: target.relativePath,
      kind: input.kind,
    };
  });

  return { createEntry, readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
