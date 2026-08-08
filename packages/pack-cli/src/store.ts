/**
 * Where pack directories live.
 *
 * A pack is a directory, and both places one can be — the local disk and a
 * project on a T3 server — answer the same four questions. Commands depend on
 * this port rather than on `node:fs`, so a test drives them without touching a
 * filesystem, the same way the SDK's own tests drive it without a server.
 *
 * @module store
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface PackStoreEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

export interface PackStore {
  /** Builds a child path in whatever form this store addresses things. */
  readonly resolve: (...segments: ReadonlyArray<string>) => string;
  /** Empty for a directory that does not exist: a missing registry is not an error. */
  readonly list: (directory: string) => Promise<ReadonlyArray<PackStoreEntry>>;
  /** Undefined for a missing file, so callers distinguish absent from empty. */
  readonly read: (path: string) => Promise<string | undefined>;
  readonly write: (path: string, contents: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
}

export function makeNodePackStore(): PackStore {
  return {
    resolve: (...segments) => resolve(...segments),
    list: async (directory) => {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      } catch {
        return [];
      }
    },
    read: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    write: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
}
