/**
 * Putting a reconciler decision onto the disk.
 *
 * If you are reading this because you are deciding whether to trust this code with your
 * work, these are the promises it keeps, and how.
 *
 * **It never deletes anything of yours.** There is no branch here that removes a file you
 * have. `deleteRemote` is a decision about the cloud copy and touches nothing locally;
 * `upload` reads. The only `unlink` calls in this file are on temp files this module
 * created moments earlier, and on the source of a rename it has already completed.
 *
 * **On a conflict, your version is moved aside before the other one is written.** Not
 * copied — moved, so there is never a moment where your bytes exist only in a buffer. The
 * remote bytes are staged in a temp file first, which means the two things that touch real
 * paths are a rename away from your file's new home and a rename onto the old one, in that
 * order. If the power fails between them, your work is at the conflicted copy and the
 * original path is briefly missing; the next pass sees a path the remote still has and
 * downloads it. The reverse order — write first, move aside after — turns the same power
 * failure into a conflicted copy containing the *other* person's version, and yours gone.
 *
 * **A conflicted-copy name is never overwritten.** Two conflicts on one path on the same
 * UTC day want the same name; the name is claimed by an operation that fails when it is
 * taken, and the loser tries the next one. The reconciler cannot do this — it does not
 * touch the disk — so it is the third obligation the spec hands to this module.
 *
 * **Nothing appears at a real path half-written.** Every write goes to a temp file in the
 * same directory, is flushed, is checked against the hash the server promised, and only
 * then is renamed into place. An interrupted download leaves a temp file and the original
 * file exactly as it was.
 *
 * Bytes come from an injected fetcher rather than from a network call here, so all of the
 * above is testable, and so that a transport change is not a change to the code that
 * touches files.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { FilePresence, PathAction } from "@t3tools/shared/cloudSync/reconcile";

import { createContentHasher, SYNC_TEMP_FILE_SUFFIX } from "./scan.ts";

export type RemoteBytes = Uint8Array | AsyncIterable<Uint8Array>;

/**
 * Where the bytes for a `download`, a `restoreLocalFromRemote` or the remote half of a
 * `conflict` come from. Async iterables are accepted so a large file never has to be whole
 * in memory on the way to the disk.
 */
export type FetchRemoteFile = (input: {
  readonly path: string;
  readonly remote: FilePresence;
}) => Promise<RemoteBytes> | RemoteBytes;

export type ApplyOptions = {
  /** The project directory. Nothing is written outside it, whatever the action says. */
  readonly root: string;
  readonly fetchRemoteFile: FetchRemoteFile;
};

export type ApplyOutcome =
  /**
   * The action needs the transport, or nothing at all. Uploads, remote deletes and base
   * advances change no local file, and this module deliberately has nothing to say about
   * them beyond naming them.
   */
  | { readonly kind: "noLocalChange"; readonly path: string; readonly action: PathAction["kind"] }
  | {
      readonly kind: "wroteLocal";
      readonly path: string;
      readonly hash: string;
      readonly bytesWritten: number;
    }
  | {
      readonly kind: "conflictPreserved";
      readonly path: string;
      /**
       * Where the local version went. Null only when there was no local file left to move
       * by the time we got here — it was deleted between the scan and now — in which case
       * nothing was preserved because there was nothing to preserve.
       */
      readonly conflictedCopyPath: string | null;
      readonly hash: string;
      readonly bytesWritten: number;
    };

export type ApplyErrorCode =
  /** The action named a path outside the project, or reachable only through a symlink. */
  | "outside-root"
  /** The bytes did not hash to what the server said they would. Nothing was installed. */
  | "hash-mismatch"
  /** The fetcher threw or ended early. Nothing was installed. */
  | "fetch-failed"
  /** Every conflicted-copy name we were willing to try was taken. Nothing was overwritten. */
  | "name-exhausted"
  | "io";

export class CloudSyncApplyError extends Error {
  readonly code: ApplyErrorCode;
  readonly path: string;

  constructor(code: ApplyErrorCode, filePath: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CloudSyncApplyError";
    this.code = code;
    this.path = filePath;
  }
}

// ---------------------------------------------------------------------------------------
// Staying inside the project
// ---------------------------------------------------------------------------------------

function resolveWithinRoot(root: string, relativePath: string): string {
  if (relativePath === "" || relativePath.includes("\0")) {
    throw new CloudSyncApplyError("outside-root", relativePath, "Refusing an unusable path.");
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new CloudSyncApplyError(
      "outside-root",
      relativePath,
      "Refusing an absolute path from a sync action.",
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    // `../../.ssh/authorized_keys` is a path a collaborator can create in a browser. The
    // laptop is where it would land, so the laptop is where it is refused.
    throw new CloudSyncApplyError(
      "outside-root",
      relativePath,
      "Refusing to write outside the project directory.",
    );
  }
  return resolved;
}

/**
 * Containment by string comparison is not enough: a symlinked directory inside the project
 * redirects a perfectly ordinary-looking relative path anywhere on the machine. The leaf
 * itself is safe — `rename` replaces a symlink rather than following it — so only the
 * directories above the file are checked.
 */
async function assertNoSymlinkedAncestors(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split(/[/\\]/).filter((segment) => segment !== "");
  let current = path.resolve(root);

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch {
      // Not there yet; it will be created as a real directory by `mkdir` below.
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new CloudSyncApplyError(
        "outside-root",
        relativePath,
        `Refusing to write through the symlinked directory ${segment}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------------------

const TEMP_BASE_NAME_MAX_LENGTH = 80;

function temporaryPathFor(absolutePath: string): string {
  const directory = path.dirname(absolutePath);
  // Truncated because most filesystems cap a name at 255 bytes and the suffix and random
  // component have to fit; the name only has to be unique, not descriptive.
  const base = path.basename(absolutePath).slice(0, TEMP_BASE_NAME_MAX_LENGTH);
  return path.join(
    directory,
    `.${base}.${crypto.randomBytes(6).toString("hex")}${SYNC_TEMP_FILE_SUFFIX}`,
  );
}

async function removeQuietly(absolutePath: string): Promise<void> {
  try {
    await fs.promises.unlink(absolutePath);
  } catch {
    // Already gone, or never created. Either way there is nothing to clean up.
  }
}

async function* toChunks(source: RemoteBytes): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  yield* source;
}

/**
 * Streams the remote bytes into a temp file beside the target, verifies them, and returns
 * the temp path. Nothing is visible at the target path when this returns, or when it
 * throws — which is the point. The caller decides when the file becomes real.
 */
async function stageRemoteFile(input: {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly remote: FilePresence;
  readonly fetchRemoteFile: FetchRemoteFile;
}): Promise<{ readonly temporaryPath: string; readonly bytesWritten: number }> {
  const temporaryPath = temporaryPathFor(input.absolutePath);
  const hasher = createContentHasher();
  let bytesWritten = 0;

  // 0o600 while it is a temp file: a half-written copy of somebody's source has no reason
  // to be world-readable, even briefly.
  const handle = await fs.promises.open(temporaryPath, "wx", 0o600);
  try {
    const source = await input.fetchRemoteFile({ path: input.relativePath, remote: input.remote });
    for await (const chunk of toChunks(source)) {
      hasher.update(chunk);
      await handle.write(chunk);
      bytesWritten += chunk.byteLength;
    }
    // Flushed before the rename, so a crash cannot leave a renamed file whose bytes never
    // reached the disk — a zero-length file at a real path, which is what "it corrupted my
    // work" looks like from the outside.
    await handle.sync();
  } catch (error) {
    await handle.close();
    await removeQuietly(temporaryPath);
    if (error instanceof CloudSyncApplyError) {
      throw error;
    }
    throw new CloudSyncApplyError(
      "fetch-failed",
      input.relativePath,
      `Could not fetch ${input.relativePath} from the cloud copy.`,
      { cause: error },
    );
  }
  await handle.close();

  const hash = hasher.digest();
  if (hash !== input.remote.hash) {
    await removeQuietly(temporaryPath);
    throw new CloudSyncApplyError(
      "hash-mismatch",
      input.relativePath,
      `The bytes fetched for ${input.relativePath} did not match the hash the server gave for them.`,
    );
  }

  return { temporaryPath, bytesWritten };
}

/**
 * Renames the staged file onto the target. `rename` within a directory is atomic, so a
 * reader either sees the old file or the new one, never a mixture and never nothing.
 */
async function installStagedFile(temporaryPath: string, absolutePath: string): Promise<void> {
  try {
    const existing = await fs.promises.stat(absolutePath).catch(() => null);
    if (existing !== null) {
      // An executable script that comes back non-executable is a broken project, and the
      // sync would look like the thing that broke it.
      await fs.promises.chmod(temporaryPath, existing.mode & 0o777);
    } else {
      await fs.promises.chmod(temporaryPath, 0o644);
    }
    await fs.promises.rename(temporaryPath, absolutePath);
  } catch (error) {
    await removeQuietly(temporaryPath);
    throw new CloudSyncApplyError("io", absolutePath, `Could not install ${absolutePath}.`, {
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------------------
// Conflicted copies
// ---------------------------------------------------------------------------------------

/** The marker `conflictedCopyPath` produces. Matched, never re-derived. */
const CONFLICTED_COPY_MARKER = / \(conflicted copy ([^()]*)\)$/;

function splitFileName(relativePath: string): {
  readonly directory: string;
  readonly stem: string;
  readonly extension: string;
} {
  const separatorIndex = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  const directory = relativePath.slice(0, separatorIndex + 1);
  const name = relativePath.slice(separatorIndex + 1);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0
    ? { directory, stem: name.slice(0, dotIndex), extension: name.slice(dotIndex) }
    : { directory, stem: name, extension: "" };
}

/**
 * The n-th name to try for a conflicted copy. The counter goes *inside* the marker —
 * `notes (conflicted copy 2026-08-19 2).md` — so the result is still recognised as a
 * conflicted copy by `isConflictedCopyPath`. Appending `(2)` after the marker instead
 * would produce a name that no longer matches, and a later conflict on that file would
 * nest a marker inside a marker.
 */
export function disambiguateConflictedCopyPath(relativePath: string, attempt: number): string {
  if (attempt <= 1) {
    return relativePath;
  }
  const { directory, stem, extension } = splitFileName(relativePath);
  const marker = CONFLICTED_COPY_MARKER.exec(stem);
  if (marker === null) {
    return `${directory}${stem} (${attempt})${extension}`;
  }
  const withoutMarker = stem.slice(0, marker.index);
  return `${directory}${withoutMarker} (conflicted copy ${marker[1]} ${attempt})${extension}`;
}

const MAX_CONFLICTED_COPY_ATTEMPTS = 1000;

/**
 * Moves the local file to the first conflicted-copy name that is free, and returns that
 * name. Returns `null` when the local file is no longer there.
 *
 * The name is claimed with `link`, which fails rather than replaces when the name is
 * taken — the difference between "never overwritten" as a promise and as a hope. A
 * `rename` here would silently destroy the copy from this morning's conflict. On a
 * filesystem without hard links the fallback claims the name with an exclusive create
 * first, which is a smaller guarantee (the claim and the rename are two steps) but still
 * refuses to write over a name that already existed.
 */
async function preserveLocalVersion(input: {
  readonly root: string;
  readonly localAbsolutePath: string;
  readonly desiredRelativePath: string;
}): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_CONFLICTED_COPY_ATTEMPTS; attempt += 1) {
    const candidateRelative = disambiguateConflictedCopyPath(input.desiredRelativePath, attempt);
    const candidateAbsolute = resolveWithinRoot(input.root, candidateRelative);

    try {
      await fs.promises.link(input.localAbsolutePath, candidateAbsolute);
      await fs.promises.unlink(input.localAbsolutePath);
      return candidateRelative;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        continue;
      }
      if (code === "ENOENT") {
        // The local file went away between the scan and now. Nothing to preserve, and
        // nothing lost: what would have been moved no longer exists.
        return null;
      }
      if (code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOSYS" && code !== "EMLINK") {
        throw new CloudSyncApplyError(
          "io",
          input.desiredRelativePath,
          `Could not preserve the local version of ${input.desiredRelativePath}.`,
          { cause: error },
        );
      }

      // No hard links on this filesystem. Claim the name exclusively, then move onto it.
      let claimed: fs.promises.FileHandle;
      try {
        claimed = await fs.promises.open(candidateAbsolute, "wx");
      } catch (claimError) {
        if ((claimError as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw new CloudSyncApplyError(
          "io",
          input.desiredRelativePath,
          `Could not preserve the local version of ${input.desiredRelativePath}.`,
          { cause: claimError },
        );
      }
      await claimed.close();
      try {
        await fs.promises.rename(input.localAbsolutePath, candidateAbsolute);
        return candidateRelative;
      } catch (renameError) {
        await removeQuietly(candidateAbsolute);
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw new CloudSyncApplyError(
          "io",
          input.desiredRelativePath,
          `Could not preserve the local version of ${input.desiredRelativePath}.`,
          { cause: renameError },
        );
      }
    }
  }

  throw new CloudSyncApplyError(
    "name-exhausted",
    input.desiredRelativePath,
    `Gave up after ${MAX_CONFLICTED_COPY_ATTEMPTS} conflicted-copy names for ${input.desiredRelativePath}; refusing to overwrite any of them.`,
  );
}

// ---------------------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------------------

async function writeRemoteToPath(input: {
  readonly options: ApplyOptions;
  readonly relativePath: string;
  readonly remote: FilePresence;
}): Promise<{ readonly bytesWritten: number; readonly absolutePath: string }> {
  const absolutePath = resolveWithinRoot(input.options.root, input.relativePath);
  await assertNoSymlinkedAncestors(input.options.root, input.relativePath);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });

  const staged = await stageRemoteFile({
    absolutePath,
    relativePath: input.relativePath,
    remote: input.remote,
    fetchRemoteFile: input.options.fetchRemoteFile,
  });
  await installStagedFile(staged.temporaryPath, absolutePath);
  return { bytesWritten: staged.bytesWritten, absolutePath };
}

/**
 * Applies one decision to the disk.
 *
 * Throws rather than reporting a partial success: a caller that records an agreed base for
 * a file that did not actually land has taught both sides to stop noticing the difference,
 * and the file is then wrong forever. Failing loudly costs a retry.
 */
export async function applyPathAction(
  action: PathAction,
  options: ApplyOptions,
): Promise<ApplyOutcome> {
  switch (action.kind) {
    case "nothing":
    case "advanceBase":
    case "upload":
    case "restoreRemoteFromLocal":
    case "deleteRemote": {
      // Every one of these is either bookkeeping or the transport's job. `deleteRemote` in
      // particular deletes in the cloud and *nothing* here — the local absence that caused
      // it is already the state of the disk.
      return { kind: "noLocalChange", path: action.path, action: action.kind };
    }

    case "download":
    case "restoreLocalFromRemote": {
      const written = await writeRemoteToPath({
        options,
        relativePath: action.path,
        remote: action.remote,
      });
      return {
        kind: "wroteLocal",
        path: action.path,
        hash: action.remote.hash,
        bytesWritten: written.bytesWritten,
      };
    }

    case "conflict": {
      const absolutePath = resolveWithinRoot(options.root, action.path);
      // Validated before anything moves: if the copy's name is unusable we want to find out
      // while the local file is still at its original path.
      resolveWithinRoot(options.root, action.conflictedCopyPath);
      await assertNoSymlinkedAncestors(options.root, action.path);

      // Staged first. This is not the write the spec orders — nothing is visible at a real
      // path yet — and doing it here means a failed download leaves the local file exactly
      // where it was instead of aside, with the path empty.
      const staged = await stageRemoteFile({
        absolutePath,
        relativePath: action.path,
        remote: action.remote,
        fetchRemoteFile: options.fetchRemoteFile,
      });

      let conflictedCopyPath: string | null;
      try {
        conflictedCopyPath = await preserveLocalVersion({
          root: options.root,
          localAbsolutePath: absolutePath,
          desiredRelativePath: action.conflictedCopyPath,
        });
      } catch (error) {
        // The local version could not be moved aside, so the remote version does not get
        // the path. Keeping both is the whole obligation; installing now would keep one.
        await removeQuietly(staged.temporaryPath);
        throw error;
      }

      await installStagedFile(staged.temporaryPath, absolutePath);

      return {
        kind: "conflictPreserved",
        path: action.path,
        conflictedCopyPath,
        hash: action.remote.hash,
        bytesWritten: staged.bytesWritten,
      };
    }
  }
}
