import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  conflictedCopyPath,
  type FilePresence,
  isConflictedCopyPath,
  type PathAction,
} from "@t3tools/shared/cloudSync/reconcile";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyPathAction,
  CloudSyncApplyError,
  disambiguateConflictedCopyPath,
  type FetchRemoteFile,
} from "./apply.ts";
import { hashBytes, SYNC_TEMP_FILE_SUFFIX } from "./scan.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(prefix = "t3-cloud-sync-apply-"): string {
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

function presenceOf(contents: string): FilePresence {
  const bytes = Buffer.from(contents);
  return { hash: hashBytes(bytes), sizeBytes: bytes.byteLength };
}

/** Serves exactly the bytes it was given, as the transport eventually will. */
function serve(contents: string): FetchRemoteFile {
  return () => Buffer.from(contents);
}

/** Serves the chunks in order, then throws if there is a failure to deliver. */
function serveChunks(chunks: readonly string[], failWith?: Error): FetchRemoteFile {
  async function* stream(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
    if (failWith !== undefined) {
      throw failWith;
    }
  }
  return () => stream();
}

/** A transport that cannot reach the server at all. */
const serveNothing: FetchRemoteFile = () => {
  throw new Error("offline");
};

function listAll(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

function temporaryLeftovers(root: string): string[] {
  return listAll(root).filter((entry) => entry.endsWith(SYNC_TEMP_FILE_SUFFIX));
}

describe("applyPathAction — downloads", () => {
  it("creates missing directories and lands the file whole", async () => {
    const root = makeTemporaryDirectory();
    const remote = presenceOf("downloaded\n");

    const outcome = await applyPathAction(
      { kind: "download", path: "src/new/file.ts", remote },
      { root, fetchRemoteFile: serve("downloaded\n") },
    );

    expect(outcome).toMatchObject({ kind: "wroteLocal", path: "src/new/file.ts" });
    expect(fs.readFileSync(path.join(root, "src/new/file.ts"), "utf8")).toBe("downloaded\n");
    expect(temporaryLeftovers(root)).toEqual([]);
  });

  it("keeps the executable bit when it replaces a file that had one", async () => {
    const root = makeTemporaryDirectory();
    const script = writeFile(root, "run.sh", "#!/bin/sh\necho old\n");
    fs.chmodSync(script, 0o755);

    await applyPathAction(
      {
        kind: "restoreLocalFromRemote",
        path: "run.sh",
        remote: presenceOf("#!/bin/sh\necho new\n"),
      },
      { root, fetchRemoteFile: serve("#!/bin/sh\necho new\n") },
    );

    expect(fs.readFileSync(script, "utf8")).toBe("#!/bin/sh\necho new\n");
    expect(fs.statSync(script).mode & 0o777).toBe(0o755);
  });

  it("accepts a streamed body without holding the file in memory", async () => {
    const root = makeTemporaryDirectory();
    const contents = "chunk-one/chunk-two/chunk-three";

    await applyPathAction(
      { kind: "download", path: "streamed.txt", remote: presenceOf(contents) },
      { root, fetchRemoteFile: serveChunks(["chunk-one/", "chunk-two/", "chunk-three"]) },
    );

    expect(fs.readFileSync(path.join(root, "streamed.txt"), "utf8")).toBe(contents);
  });
});

describe("applyPathAction — an interrupted write", () => {
  it("leaves no partial file at the target path, and no temp file behind", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "notes.md", "the version I have been working on\n");
    const remote = presenceOf("a much longer remote version that never finishes arriving\n");

    const fetchRemoteFile = serveChunks(["a much longer remote "], new Error("connection reset"));

    await expect(
      applyPathAction({ kind: "download", path: "notes.md", remote }, { root, fetchRemoteFile }),
    ).rejects.toMatchObject({ code: "fetch-failed" });

    // Untouched: not truncated, not partially overwritten, not replaced by the prefix.
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe(
      "the version I have been working on\n",
    );
    expect(temporaryLeftovers(root)).toEqual([]);
    expect(listAll(root)).toEqual(["notes.md"]);
  });

  it("refuses bytes that do not hash to what the server promised", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "app.ts", "local\n");

    await expect(
      applyPathAction(
        { kind: "download", path: "app.ts", remote: presenceOf("expected\n") },
        { root, fetchRemoteFile: serve("something else entirely\n") },
      ),
    ).rejects.toMatchObject({ code: "hash-mismatch" });

    expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("local\n");
    expect(listAll(root)).toEqual(["app.ts"]);
  });

  it("creates nothing at all when a new path's download fails", async () => {
    const root = makeTemporaryDirectory();

    await expect(
      applyPathAction(
        { kind: "download", path: "deep/new/file.ts", remote: presenceOf("x") },
        { root, fetchRemoteFile: serveNothing },
      ),
    ).rejects.toBeInstanceOf(CloudSyncApplyError);

    expect(listAll(root)).toEqual([]);
  });
});

describe("applyPathAction — conflicts", () => {
  function conflictAction(now: Date, localText: string, remoteText: string): PathAction {
    return {
      kind: "conflict",
      path: "notes.md",
      conflictedCopyPath: conflictedCopyPath("notes.md", now),
      local: presenceOf(localText),
      remote: presenceOf(remoteText),
    };
  }

  it("keeps both versions, with the remote one at the path", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "notes.md", "my morning's work\n");
    const action = conflictAction(
      new Date("2026-08-19T09:00:00Z"),
      "my morning's work\n",
      "their version\n",
    );

    const outcome = await applyPathAction(action, {
      root,
      fetchRemoteFile: serve("their version\n"),
    });

    expect(outcome.kind).toBe("conflictPreserved");
    const copyPath = outcome.kind === "conflictPreserved" ? outcome.conflictedCopyPath : null;
    expect(copyPath).toBe("notes (conflicted copy 2026-08-19).md");

    // Both survive, and they are not the same file.
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe("their version\n");
    expect(fs.readFileSync(path.join(root, copyPath ?? ""), "utf8")).toBe("my morning's work\n");
    expect(listAll(root)).toEqual(["notes (conflicted copy 2026-08-19).md", "notes.md"]);
  });

  it("never overwrites a conflicted copy that already has that name", async () => {
    const root = makeTemporaryDirectory();
    const now = new Date("2026-08-19T09:00:00Z");
    // This morning's conflict, still waiting for a person.
    writeFile(
      root,
      "notes (conflicted copy 2026-08-19).md",
      "the first conflict, still unresolved\n",
    );
    writeFile(root, "notes.md", "this afternoon's work\n");

    const outcome = await applyPathAction(
      conflictAction(now, "this afternoon's work\n", "their newer version\n"),
      { root, fetchRemoteFile: serve("their newer version\n") },
    );

    const copyPath = outcome.kind === "conflictPreserved" ? outcome.conflictedCopyPath : null;
    expect(copyPath).toBe("notes (conflicted copy 2026-08-19 2).md");
    // Still recognised as a conflicted copy, so the UI keeps listing it and a third
    // conflict does not nest a marker inside a marker.
    expect(isConflictedCopyPath(copyPath ?? "")).toBe(true);

    expect(fs.readFileSync(path.join(root, "notes (conflicted copy 2026-08-19).md"), "utf8")).toBe(
      "the first conflict, still unresolved\n",
    );
    expect(fs.readFileSync(path.join(root, copyPath ?? ""), "utf8")).toBe(
      "this afternoon's work\n",
    );
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe("their newer version\n");
  });

  it("keeps disambiguating rather than reusing a taken name", async () => {
    const root = makeTemporaryDirectory();
    const now = new Date("2026-08-19T09:00:00Z");
    writeFile(root, "notes (conflicted copy 2026-08-19).md", "one\n");
    writeFile(root, "notes (conflicted copy 2026-08-19 2).md", "two\n");
    writeFile(root, "notes (conflicted copy 2026-08-19 3).md", "three\n");
    writeFile(root, "notes.md", "four\n");

    const outcome = await applyPathAction(conflictAction(now, "four\n", "remote\n"), {
      root,
      fetchRemoteFile: serve("remote\n"),
    });

    expect(outcome.kind === "conflictPreserved" ? outcome.conflictedCopyPath : null).toBe(
      "notes (conflicted copy 2026-08-19 4).md",
    );
    expect(fs.readFileSync(path.join(root, "notes (conflicted copy 2026-08-19).md"), "utf8")).toBe(
      "one\n",
    );
    expect(
      fs.readFileSync(path.join(root, "notes (conflicted copy 2026-08-19 2).md"), "utf8"),
    ).toBe("two\n");
    expect(
      fs.readFileSync(path.join(root, "notes (conflicted copy 2026-08-19 3).md"), "utf8"),
    ).toBe("three\n");
  });

  it("leaves the local version where it is when the remote half cannot be fetched", async () => {
    const root = makeTemporaryDirectory();
    const now = new Date("2026-08-19T09:00:00Z");
    writeFile(root, "notes.md", "my work\n");

    await expect(
      applyPathAction(conflictAction(now, "my work\n", "theirs\n"), {
        root,
        fetchRemoteFile: serveNothing,
      }),
    ).rejects.toMatchObject({ code: "fetch-failed" });

    // Not moved aside and then abandoned: the file is exactly where the person left it.
    expect(listAll(root)).toEqual(["notes.md"]);
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe("my work\n");
  });

  it("still installs the remote version when the local file vanished first", async () => {
    const root = makeTemporaryDirectory();
    const now = new Date("2026-08-19T09:00:00Z");

    const outcome = await applyPathAction(conflictAction(now, "gone\n", "theirs\n"), {
      root,
      fetchRemoteFile: serve("theirs\n"),
    });

    expect(outcome).toMatchObject({ kind: "conflictPreserved", conflictedCopyPath: null });
    expect(listAll(root)).toEqual(["notes.md"]);
  });
});

describe("applyPathAction — actions that must not touch the disk", () => {
  it("changes nothing local for an upload, a remote delete, a base advance or a no-op", async () => {
    const root = makeTemporaryDirectory();
    writeFile(root, "kept.txt", "kept\n");
    const local = presenceOf("kept\n");
    const options = {
      root,
      fetchRemoteFile: (() => {
        throw new Error("no bytes should be fetched");
      }) as FetchRemoteFile,
    };

    const actions: PathAction[] = [
      { kind: "upload", path: "kept.txt", local },
      { kind: "restoreRemoteFromLocal", path: "kept.txt", local },
      // The one action that deletes anything anywhere, and it still deletes nothing here.
      { kind: "deleteRemote", path: "already-gone.txt" },
      { kind: "advanceBase", path: "kept.txt", agreed: local },
      { kind: "nothing", path: "kept.txt" },
    ];

    for (const action of actions) {
      expect(await applyPathAction(action, options)).toMatchObject({ kind: "noLocalChange" });
    }

    expect(listAll(root)).toEqual(["kept.txt"]);
    expect(fs.readFileSync(path.join(root, "kept.txt"), "utf8")).toBe("kept\n");
  });
});

describe("applyPathAction — staying inside the project", () => {
  it("refuses a path that climbs out of the project", async () => {
    const root = makeTemporaryDirectory();
    const outside = makeTemporaryDirectory("t3-cloud-sync-outside-");

    await expect(
      applyPathAction(
        { kind: "download", path: "../escape.txt", remote: presenceOf("x") },
        { root, fetchRemoteFile: serve("x") },
      ),
    ).rejects.toMatchObject({ code: "outside-root" });

    await expect(
      applyPathAction(
        {
          kind: "download",
          path: path.join(outside, "absolute.txt"),
          remote: presenceOf("x"),
        },
        { root, fetchRemoteFile: serve("x") },
      ),
    ).rejects.toMatchObject({ code: "outside-root" });

    expect(listAll(outside)).toEqual([]);
  });

  it("refuses to write through a symlinked directory inside the project", async () => {
    const root = makeTemporaryDirectory();
    const outside = makeTemporaryDirectory("t3-cloud-sync-outside-");
    fs.writeFileSync(path.join(outside, "keep-me"), "existing\n");
    fs.symlinkSync(outside, path.join(root, "link"), "dir");

    await expect(
      applyPathAction(
        { kind: "download", path: "link/planted.txt", remote: presenceOf("planted") },
        { root, fetchRemoteFile: serve("planted") },
      ),
    ).rejects.toMatchObject({ code: "outside-root" });

    expect(listAll(outside)).toEqual(["keep-me"]);
  });
});

describe("disambiguateConflictedCopyPath", () => {
  it("counts inside the marker so the name stays a recognised conflicted copy", () => {
    const first = conflictedCopyPath("src/notes.md", new Date("2026-08-19T00:00:00Z"));
    expect(disambiguateConflictedCopyPath(first, 1)).toBe(first);
    expect(disambiguateConflictedCopyPath(first, 2)).toBe(
      "src/notes (conflicted copy 2026-08-19 2).md",
    );
    expect(isConflictedCopyPath(disambiguateConflictedCopyPath(first, 7))).toBe(true);

    // A name that never carried a marker still gets a distinct one rather than a collision.
    expect(disambiguateConflictedCopyPath("plain.txt", 3)).toBe("plain (3).txt");
    expect(disambiguateConflictedCopyPath("archive.tar.gz", 2)).toBe("archive.tar (2).gz");
  });
});
