import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compileGitignore,
  createUnknownPathPredicate,
  hashBytes,
  isPathIgnored,
  isPathOrAncestorIgnored,
  loadProjectIgnoreFilter,
  type ScanResult,
  scanProject,
  summariseScan,
  SYNC_TEMP_FILE_SUFFIX,
} from "./scan.ts";

const temporaryDirectories: string[] = [];

/** Tests take permissions away; the cleanup has to put them back before it can delete. */
function restorePermissions(directory: string): void {
  try {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        restorePermissions(full);
      } else if (!entry.isSymbolicLink()) {
        fs.chmodSync(full, 0o600);
      }
    }
  } catch {
    // Best effort; the removal below reports anything that actually matters.
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    restorePermissions(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(prefix = "t3-cloud-sync-scan-"): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFile(root: string, relativePath: string, contents: string): string {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
  return absolute;
}

function pathsIn(result: ScanResult): string[] {
  return [...result.files.keys()].toSorted();
}

function skipFor(result: ScanResult, relativePath: string) {
  return result.skipped.find((skip) => skip.path === relativePath);
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("scanProject", () => {
  it("hashes every ordinary file, keyed by a slash-separated relative path", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "index.ts", "export const a = 1;\n");
    writeFile(root, "src/nested/deep.txt", "hello");

    const result = await scanProject({ root });

    expect(result.complete).toBe(true);
    expect(result.incompleteReasons).toEqual([]);
    expect(pathsIn(result)).toEqual(["index.ts", "src/nested/deep.txt"]);
    expect(result.files.get("src/nested/deep.txt")?.hash).toBe(hashBytes(Buffer.from("hello")));
    expect(result.files.get("src/nested/deep.txt")?.sizeBytes).toBe(5);
  });

  it("does not follow a symlink that points outside the project", async () => {
    const root = makeTemporaryDirectory();
    const outside = makeTemporaryDirectory("t3-cloud-sync-outside-");
    fs.writeFileSync(path.join(outside, "id_rsa"), "PRIVATE KEY");
    fs.mkdirSync(path.join(outside, "secrets"));
    fs.writeFileSync(path.join(outside, "secrets", "token"), "hunter2");

    writeFile(root, "app.ts", "ok");
    fs.symlinkSync(path.join(outside, "id_rsa"), path.join(root, "key-link"));
    fs.symlinkSync(outside, path.join(root, "home-link"), "dir");

    const result = await scanProject({ root });

    expect(pathsIn(result)).toEqual(["app.ts"]);
    expect(skipFor(result, "key-link")?.reason).toBe("symlink");
    expect(skipFor(result, "home-link")?.reason).toBe("symlink");
    // Nothing from the linked tree may appear under any name.
    expect([...result.files.keys()].some((entry) => entry.includes("token"))).toBe(false);
    for (const file of result.files.values()) {
      expect(file.hash).not.toBe(hashBytes(Buffer.from("hunter2")));
    }
  });

  it("keeps a symlinked path out of the scan even when it points inside the project", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "real.txt", "content");
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "alias.txt"));

    const result = await scanProject({ root });

    // Syncing the link as a second copy of the file would replace it with a real file on
    // the machine that downloads it, which is a change the person did not make.
    expect(pathsIn(result)).toEqual(["real.txt"]);
    expect(skipFor(result, "alias.txt")?.reason).toBe("symlink");
  });

  it("excludes .git, node_modules, OS droppings and our own temp files", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "keep.txt", "keep");
    writeFile(root, ".git/HEAD", "ref: refs/heads/main");
    writeFile(root, ".git/objects/ab/cdef", "object");
    writeFile(root, "node_modules/left-pad/index.js", "module.exports = 1;");
    writeFile(root, "packages/app/node_modules/dep/index.js", "nested");
    writeFile(root, ".DS_Store", "finder");
    writeFile(root, "src/.DS_Store", "finder");
    writeFile(root, "src/Thumbs.db", "windows");
    writeFile(root, "src/._resource", "apple double");
    writeFile(root, `src/.partial${SYNC_TEMP_FILE_SUFFIX}`, "half a download");

    const result = await scanProject({ root });

    expect(pathsIn(result)).toEqual(["keep.txt"]);
    expect(skipFor(result, ".git")?.reason).toBe("ignored");
    expect(skipFor(result, "node_modules")?.reason).toBe("ignored");
    expect(skipFor(result, "packages/app/node_modules")?.reason).toBe("ignored");
    expect(skipFor(result, ".DS_Store")?.reason).toBe("ignored");
    expect(skipFor(result, `src/.partial${SYNC_TEMP_FILE_SUFFIX}`)?.reason).toBe("ignored");
  });

  it("honours .gitignore, including nested files and negations", async () => {
    const root = makeTemporaryDirectory();
    writeFile(
      root,
      ".gitignore",
      ["# comment", "", "dist/", "*.log", "!keep.log", "/root-only"].join("\n"),
    );
    writeFile(root, "src/.gitignore", "generated.ts");

    writeFile(root, "app.ts", "app");
    writeFile(root, "dist/bundle.js", "bundle");
    writeFile(root, "noise.log", "noise");
    writeFile(root, "keep.log", "keep");
    writeFile(root, "root-only", "anchored");
    writeFile(root, "src/root-only", "not anchored here");
    writeFile(root, "src/generated.ts", "generated");
    writeFile(root, "src/kept.ts", "kept");

    const result = await scanProject({ root });

    expect(pathsIn(result)).toEqual([
      ".gitignore",
      "app.ts",
      "keep.log",
      "src/.gitignore",
      "src/kept.ts",
      "src/root-only",
    ]);
    expect(skipFor(result, "dist")?.reason).toBe("ignored");
    expect(skipFor(result, "src/generated.ts")?.reason).toBe("ignored");
  });

  it("reports complete: false when a directory cannot be read, and does not shrink quietly", async () => {
    if (isRoot) {
      // Running as root makes the permission bits advisory, so there is nothing to test.
      return;
    }
    const root = makeTemporaryDirectory();
    writeFile(root, "visible.txt", "visible");
    writeFile(root, "locked/secret.txt", "secret");
    fs.chmodSync(path.join(root, "locked"), 0o000);

    const result = await scanProject({ root });

    expect(result.complete).toBe(false);
    expect(result.incompleteReasons.join(" ")).toContain("locked");
    expect(skipFor(result, "locked")?.reason).toBe("unreadable");
    expect(result.files.has("locked/secret.txt")).toBe(false);
    // The readable part is still reported; the flag, not the map, is what says "partial".
    expect(result.files.has("visible.txt")).toBe(true);
  });

  it("reports complete: false when the project directory is missing", async () => {
    const root = path.join(makeTemporaryDirectory(), "never-created");

    const result = await scanProject({ root });

    // The most dangerous input there is: an empty map that looks like "the user deleted
    // everything" unless the scan says it could not look.
    expect(result.complete).toBe(false);
    expect(result.files.size).toBe(0);
  });

  it("reports complete: false when a .gitignore cannot be read", async () => {
    if (isRoot) {
      return;
    }
    const root = makeTemporaryDirectory();
    writeFile(root, "app.ts", "app");
    const gitignorePath = writeFile(root, ".gitignore", "dist/\n");
    fs.chmodSync(gitignorePath, 0o000);

    const result = await scanProject({ root });

    expect(result.complete).toBe(false);
    expect(result.incompleteReasons.join(" ")).toContain(".gitignore");
  });

  it("reports complete: false when the walk is aborted", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "a/one.txt", "one");
    writeFile(root, "b/two.txt", "two");
    const controller = new AbortController();
    controller.abort();

    const result = await scanProject({ root, signal: controller.signal });

    expect(result.complete).toBe(false);
    expect(result.incompleteReasons.join(" ")).toContain("cancelled");
  });

  it("skips files over the ceiling and says so", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "small.txt", "small");
    writeFile(root, "big.bin", "x".repeat(4096));

    const result = await scanProject({ root, maxFileBytes: 1024 });

    expect(pathsIn(result)).toEqual(["small.txt"]);
    const skip = skipFor(result, "big.bin");
    expect(skip?.reason).toBe("tooLarge");
    expect(skip?.sizeBytes).toBe(4096);
    // An oversized file is excluded, never reported as deleted.
    expect(result.complete).toBe(true);
  });

  it("reuses a hash only while the inode is untouched, and the hash always decides", async () => {
    const root = makeTemporaryDirectory();
    const filePath = writeFile(root, "notes.md", "first");

    const first = await scanProject({ root });
    expect(first.filesHashed).toBe(1);

    const second = await scanProject({ root, previous: first.files });
    expect(second.filesReused).toBe(1);
    expect(second.filesHashed).toBe(0);
    expect(second.files.get("notes.md")?.hash).toBe(first.files.get("notes.md")?.hash);

    // Same length, and the modification time put back exactly where it was: everything a
    // caller can forge. The change is still caught, because ctime is not forgeable and
    // because a hash, not a timestamp, is what is reported.
    const before = fs.statSync(filePath);
    fs.writeFileSync(filePath, "SECND");
    fs.utimesSync(filePath, before.atime, before.mtime);

    const third = await scanProject({ root, previous: second.files });
    expect(third.filesHashed).toBe(1);
    expect(third.files.get("notes.md")?.hash).toBe(hashBytes(Buffer.from("SECND")));
  });

  it("re-reads everything when asked, whatever the previous scan remembered", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "notes.md", "first");
    const first = await scanProject({ root });

    const forced = await scanProject({ root, previous: first.files, rehashAll: true });

    expect(forced.filesHashed).toBe(1);
    expect(forced.filesReused).toBe(0);
  });
});

describe("createUnknownPathPredicate", () => {
  it("treats every exclusion except a vanished file as unknown", () => {
    const isUnknown = createUnknownPathPredicate({
      skipped: [
        { path: "node_modules", reason: "ignored", isDirectory: true },
        { path: "huge.bin", reason: "tooLarge", isDirectory: false },
        { path: "link", reason: "symlink", isDirectory: false },
        { path: "locked", reason: "unreadable", isDirectory: true },
        { path: "gone.txt", reason: "vanished", isDirectory: false },
      ],
    });

    expect(isUnknown("node_modules")).toBe(true);
    expect(isUnknown("node_modules/left-pad/index.js")).toBe(true);
    expect(isUnknown("locked/secret.txt")).toBe(true);
    expect(isUnknown("huge.bin")).toBe(true);
    expect(isUnknown("link")).toBe(true);
    // A file that really was deleted is known to be absent, and the delete must propagate.
    expect(isUnknown("gone.txt")).toBe(false);
    expect(isUnknown("src/app.ts")).toBe(false);
    // A prefix that merely looks similar is not an ancestor.
    expect(isUnknown("node_modules_backup/x")).toBe(false);
  });
});

describe("gitignore matching", () => {
  it("compiles the patterns projects actually contain", () => {
    const layers = [
      {
        base: "",
        patterns: compileGitignore(
          ["build/", "*.tmp", "!important.tmp", "docs/**/draft.md", "**/cache", "log?.txt"].join(
            "\n",
          ),
        ),
      },
    ];

    expect(isPathIgnored(layers, "build", true)).toBe(true);
    expect(isPathIgnored(layers, "build", false)).toBe(false);
    expect(isPathIgnored(layers, "a.tmp", false)).toBe(true);
    expect(isPathIgnored(layers, "nested/a.tmp", false)).toBe(true);
    expect(isPathIgnored(layers, "important.tmp", false)).toBe(false);
    expect(isPathIgnored(layers, "docs/a/b/draft.md", false)).toBe(true);
    expect(isPathIgnored(layers, "docs/draft.md", false)).toBe(true);
    expect(isPathIgnored(layers, "src/cache", true)).toBe(true);
    expect(isPathIgnored(layers, "log1.txt", false)).toBe(true);
    expect(isPathIgnored(layers, "log12.txt", false)).toBe(false);
  });

  it("answers for a deep path without walking the tree", async () => {
    const layers = [{ base: "", patterns: compileGitignore("build/\n") }];

    expect(isPathOrAncestorIgnored(layers, "build/assets/app.js", false)).toBe(true);
    expect(isPathOrAncestorIgnored(layers, "node_modules/dep/index.js", false)).toBe(true);
    expect(isPathOrAncestorIgnored(layers, "src/app.ts", false)).toBe(false);

    const root = makeTemporaryDirectory();
    writeFile(root, ".gitignore", "dist/\n");
    const isIgnored = await loadProjectIgnoreFilter(root);
    expect(isIgnored("dist/bundle.js", false)).toBe(true);
    expect(isIgnored("src/app.ts", false)).toBe(false);
  });
});

describe("summariseScan", () => {
  it("keeps the skipped count honest when the list is truncated", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "a.txt", "aa");
    writeFile(root, "b.txt", "bbb");
    writeFile(root, ".DS_Store", "x");
    writeFile(root, "src/.DS_Store", "x");

    const summary = summariseScan(await scanProject({ root }), 1);

    expect(summary.fileCount).toBe(2);
    expect(summary.totalBytes).toBe(5);
    expect(summary.skippedCount).toBe(2);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.complete).toBe(true);
  });
});
