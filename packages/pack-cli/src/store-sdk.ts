/**
 * The same store, backed by a T3 server over the SDK.
 *
 * A registry that lives beside the agent is the common case; a registry that
 * lives in a workspace on a server is the shared one, and it is the same
 * directory either way. Paths here are relative to the project root the client
 * was pointed at, which is what the SDK's file surface takes.
 *
 * @module store-sdk
 */
import type { T3WorkspaceApi } from "@t3tools/sdk";

import type { PackStore } from "./store.ts";

/** Registry-relative, POSIX, with the root addressed as the empty string. */
function joinRelative(...segments: ReadonlyArray<string>): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}

export function makeSdkPackStore(input: {
  readonly workspace: T3WorkspaceApi;
  /** Project root on the server that holds the registry. */
  readonly cwd: string;
}): PackStore {
  const { workspace, cwd } = input;
  return {
    resolve: (...segments) => joinRelative(...segments),
    list: async (directory) => {
      try {
        const result = await workspace.listDirectory({
          cwd,
          ...(directory.length > 0 ? { directoryPath: directory } : {}),
        });
        return result.entries.map((entry) => ({ name: entry.name, kind: entry.kind }));
      } catch {
        return [];
      }
    },
    read: async (path) => {
      try {
        const file = await workspace.readFile({ cwd, relativePath: path });
        // A binary or truncated read is not a manifest, and reporting it as
        // empty would be a lie the caller cannot see through.
        return file.isBinary || file.tooLarge ? undefined : file.contents;
      } catch {
        return undefined;
      }
    },
    write: async (path, contents) => {
      await workspace.writeFile({ cwd, relativePath: path, contents });
    },
    makeDirectory: async (path) => {
      if (path.length === 0) {
        return;
      }
      await workspace.createEntry({ cwd, relativePath: path, kind: "directory" });
    },
  };
}
