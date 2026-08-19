/**
 * Walking a project directory, deciding what is allowed to leave the laptop, and hashing
 * it. The laptop half of `docs/cloud-sync-spec.md`; the decisions live in
 * `@t3tools/shared/cloudSync/reconcile` and are not repeated here.
 *
 * Two properties of this module are load-bearing, and both exist because of the same
 * failure. The reconciler is handed a `Map` of what is on disk, and any path missing from
 * that map reads as "the user deleted this" — which, for a path the remote has not
 * touched, becomes a remote delete. So:
 *
 * 1. **A scan says whether it was complete.** A permission error, an abort, or a
 *    `.gitignore` we could not read makes `complete` false. It never makes the map
 *    smaller and calls that a result. A caller that reconciles an incomplete scan deletes
 *    a tree; a caller that refuses one loses a pass.
 * 2. **Everything excluded is named.** A path we decided not to hash is not a path we
 *    know to be absent, so `skipped` carries every one of them and
 *    {@link createUnknownPathPredicate} turns that list into the exclusion the reconciler
 *    cannot express. Without it, adding a line to `.gitignore` deletes the matching files
 *    from the cloud copy.
 *
 * Modification times are used here and only here: as a cheap "might have changed" filter
 * that decides whether to re-read a file. The hash is what is reported and the hash is
 * what decides. See {@link isUnchangedSince} for why the filter looks at more than mtime.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** `sha256:<hex>`. Prefixed so a future algorithm change is visible rather than silent. */
export type ContentHash = string;

/**
 * A file that is on disk and may be synced. `hash` and `sizeBytes` are the reconciler's
 * `FilePresence`; the rest is the pre-filter's memory of what was read last time and is
 * ignored by every decision.
 */
export type ScannedFile = {
  readonly hash: ContentHash;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /**
   * Inode change time. Unlike mtime it cannot be set by a caller, so a rewrite that
   * carefully restores mtime and size still moves it.
   */
  readonly ctimeMs: number;
  /** Guards against a path being replaced wholesale by a different file of the same size. */
  readonly inode: number;
};

export type ScanSkipReason =
  /** Excluded by rule: `.git`, `node_modules`, `.gitignore`, an OS dropping, our own temp file. */
  | "ignored"
  /** Not followed. A link out of the project is how a home directory joins a shared workspace. */
  | "symlink"
  | "tooLarge"
  /** A socket, fifo or device node. There is nothing to hash and nothing a collaborator wants. */
  | "unsupportedType"
  /** Permission denied or an I/O error. Always accompanied by `complete: false`. */
  | "unreadable"
  /** Deleted between listing it and reading it. A genuine absence, not an unknown. */
  | "vanished";

export type ScanSkip = {
  /** Project-relative, `/`-separated, matching the keys of {@link ScanResult.files}. */
  readonly path: string;
  readonly reason: ScanSkipReason;
  /** Set for a directory we did not descend into, so its whole subtree is unknown. */
  readonly isDirectory: boolean;
  readonly sizeBytes?: number;
  readonly detail?: string;
};

export type ScanResult = {
  /** Absolute, resolved. */
  readonly root: string;
  readonly files: ReadonlyMap<string, ScannedFile>;
  /**
   * False when any part of the tree could not be read, or the walk was cut short. The
   * spec's first caller obligation: never hand a partial scan to the reconciler.
   */
  readonly complete: boolean;
  /** Why, in words a person can act on. Empty exactly when `complete`. */
  readonly incompleteReasons: readonly string[];
  readonly skipped: readonly ScanSkip[];
  /** Files whose bytes were actually read this pass, and how many bytes that was. */
  readonly filesHashed: number;
  readonly bytesHashed: number;
  /** Files whose hash came from `previous` because nothing about the inode had moved. */
  readonly filesReused: number;
};

export type ScanOptions = {
  readonly root: string;
  /**
   * The previous scan's files, used only to skip re-reading bytes. Omit it to force a
   * full re-hash — which is the answer whenever the previous result is not trustworthy.
   */
  readonly previous?: ReadonlyMap<string, ScannedFile> | undefined;
  readonly maxFileBytes?: number | undefined;
  /** Ignores `previous` entirely. For the periodic pass that must not trust any filter. */
  readonly rehashAll?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
};

/**
 * Files bigger than this are reported as skipped rather than uploaded. The spec asks for a
 * ceiling without naming one; this is generous enough that an ordinary project never meets
 * it and small enough that a stray VM image does not hold a first sync hostage.
 */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * The suffix on every half-written file this feature creates. It lives here rather than in
 * `apply.ts` because the scanner is what has to not report them: a temp file that appeared
 * in a scan would be uploaded, and then deleted from the cloud the moment it was renamed
 * into place.
 */
export const SYNC_TEMP_FILE_SUFFIX = ".t3sync-tmp";

/**
 * Directory names refused wherever they appear, not just at the root. A nested
 * `node_modules` is the same mistake as a top-level one, and a nested `.git` is a
 * submodule — the case where half-replicating a repository hurts most.
 */
const ALWAYS_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".TemporaryItems",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

/** Written by the OS, edited by nobody. Syncing them starts arguments between machines. */
const OS_NOISE_FILE_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "ehthumbs.db",
  "desktop.ini",
]);

/** True for a name this feature refuses on sight, before any `.gitignore` is consulted. */
export function isAlwaysIgnoredName(name: string, isDirectory: boolean): boolean {
  if (name.endsWith(SYNC_TEMP_FILE_SUFFIX)) {
    return true;
  }
  if (isDirectory) {
    return ALWAYS_IGNORED_DIRECTORY_NAMES.has(name);
  }
  // `._Foo` is the AppleDouble sidecar macOS writes beside a file on a foreign filesystem.
  return OS_NOISE_FILE_NAMES.has(name) || name.startsWith("._");
}

// ---------------------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------------------

/**
 * One compiled `.gitignore` line.
 *
 * This implements the subset of gitignore that projects actually contain: comments,
 * negation, anchoring, directory-only patterns, `*`, `?`, `**` and character classes. It
 * does not read `.git/info/exclude` or a global core.excludesFile, because both live
 * outside the project and would make the exclusion set depend on which machine scanned —
 * the same tree scanned on a laptop and a colleague's laptop must agree about what is
 * excluded, or one of them appears to have deleted the difference.
 */
type IgnorePattern = {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: RegExp;
};

export type CompiledGitignore = readonly IgnorePattern[];

/** A `.gitignore` and the directory it governs, relative to the project root (`""` at the top). */
export type IgnoreLayer = {
  readonly base: string;
  readonly patterns: CompiledGitignore;
};

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function findCharacterClassEnd(glob: string, openIndex: number): number {
  // A `]` immediately after `[` or `[!` is a literal, per POSIX; git follows the same rule.
  let index = openIndex + 1;
  if (glob.charAt(index) === "!") {
    index += 1;
  }
  if (glob.charAt(index) === "]") {
    index += 1;
  }
  while (index < glob.length) {
    if (glob.charAt(index) === "]") {
      return index;
    }
    index += 1;
  }
  return -1;
}

function globToRegExpSource(glob: string): string {
  let source = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob.charAt(index);

    if (char === "\\") {
      const next = glob.charAt(index + 1);
      source += next === "" ? String.raw`\\` : escapeRegExp(next);
      index += 2;
      continue;
    }

    if (char === "*") {
      if (glob.charAt(index + 1) === "*") {
        // `**/` crosses zero or more directories; a trailing `**` takes the rest.
        if (glob.charAt(index + 2) === "/") {
          source += "(?:[^/]+/)*";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const end = findCharacterClassEnd(glob, index);
      if (end === -1) {
        source += String.raw`\[`;
        index += 1;
        continue;
      }
      const body = glob.slice(index + 1, end);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = end + 1;
      continue;
    }

    source += escapeRegExp(char);
    index += 1;
  }

  return source;
}

export function compileGitignore(contents: string): CompiledGitignore {
  const patterns: IgnorePattern[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    // Trailing whitespace is not part of a pattern unless it was escaped.
    const line = rawLine.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const negated = line.startsWith("!");
    let body = negated ? line.slice(1) : line;
    if (body.startsWith(String.raw`\#`) || body.startsWith(String.raw`\!`)) {
      body = body.slice(1);
    }

    const directoryOnly = body.endsWith("/");
    if (directoryOnly) {
      body = body.slice(0, -1);
    }
    if (body === "") {
      continue;
    }

    // A pattern containing a slash is anchored to the directory holding the file; one
    // without matches by name at any depth below it.
    let anchored = body.includes("/");
    if (body.startsWith("/")) {
      anchored = true;
      body = body.slice(1);
    }

    const source = globToRegExpSource(body);
    patterns.push({
      negated,
      directoryOnly,
      matcher: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`),
    });
  }

  return patterns;
}

function relativeToLayer(layer: IgnoreLayer, relativePath: string): string | null {
  if (layer.base === "") {
    return relativePath;
  }
  const prefix = `${layer.base}/`;
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : null;
}

/**
 * Whether the layers ignore this path. Later layers are deeper, later patterns are newer,
 * and the last match wins — git's rule, and the one people write `!keep-this` expecting.
 */
export function isPathIgnored(
  layers: readonly IgnoreLayer[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;

  for (const layer of layers) {
    const candidate = relativeToLayer(layer, relativePath);
    if (candidate === null) {
      continue;
    }
    for (const pattern of layer.patterns) {
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }
      if (pattern.matcher.test(candidate)) {
        ignored = !pattern.negated;
      }
    }
  }

  return ignored;
}

/**
 * As {@link isPathIgnored}, but also true when any ancestor directory is ignored.
 *
 * The walk never needs this — it stops at the ignored directory and never sees what is
 * below — but a watcher is handed deep paths with no context and has to answer the same
 * question about each one on its own.
 */
export function isPathOrAncestorIgnored(
  layers: readonly IgnoreLayer[],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const partial = segments.slice(0, index + 1).join("/");
    const partialIsDirectory = isLast ? isDirectory : true;
    if (isAlwaysIgnoredName(segment, partialIsDirectory)) {
      return true;
    }
    if (isPathIgnored(layers, partial, partialIsDirectory)) {
      return true;
    }
  }
  return false;
}

/**
 * Reads the project's root `.gitignore` into a predicate, for callers that need to answer
 * "would a scan have kept this?" without walking anything — the watcher, mainly.
 *
 * Only the root file: nested `.gitignore`s are picked up by the walk, and a watcher that
 * missed one costs a wasted scan, while a walk that missed one costs a wrong answer.
 */
export async function loadProjectIgnoreFilter(
  root: string,
): Promise<(relativePath: string, isDirectory: boolean) => boolean> {
  let layers: readonly IgnoreLayer[] = [];
  try {
    const contents = await fs.promises.readFile(path.join(root, ".gitignore"), "utf8");
    layers = [{ base: "", patterns: compileGitignore(contents) }];
  } catch {
    // No `.gitignore`, or an unreadable one. The walk is what has to be strict about this;
    // here the cost of being wrong is an extra scan.
    layers = [];
  }
  return (relativePath, isDirectory) => isPathOrAncestorIgnored(layers, relativePath, isDirectory);
}

// ---------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------

/**
 * `O_NOFOLLOW` closes the gap between deciding a directory entry is a regular file and
 * opening it. Without it, replacing that entry with a symlink in between is enough to make
 * the scanner read a file outside the project — the exact thing the spec refuses. Windows
 * has no such flag; there the `lstat` check above the call is the whole defence.
 */
const O_NOFOLLOW: number = fs.constants.O_NOFOLLOW ?? 0;

const HASH_ALGORITHM = "sha256";
const HASH_CHUNK_BYTES = 1 << 16;

export function hashBytes(bytes: Uint8Array): ContentHash {
  return `${HASH_ALGORITHM}:${crypto.createHash(HASH_ALGORITHM).update(bytes).digest("hex")}`;
}

export function createContentHasher(): {
  update: (chunk: Uint8Array) => void;
  digest: () => ContentHash;
} {
  const hash = crypto.createHash(HASH_ALGORITHM);
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digest: () => `${HASH_ALGORITHM}:${hash.digest("hex")}`,
  };
}

/**
 * Streams the file rather than reading it whole: a scan must not need as much memory as
 * the largest file in the project. Returns the byte count it actually read, which is the
 * number the ceiling is enforced against — a file that grew since `lstat` is caught here.
 */
export async function hashFileAt(
  absolutePath: string,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<
  { readonly hash: ContentHash; readonly sizeBytes: number } | { readonly tooLarge: true }
> {
  const handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const hasher = createContentHasher();
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let sizeBytes = 0;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      sizeBytes += bytesRead;
      if (sizeBytes > maxBytes) {
        return { tooLarge: true };
      }
      hasher.update(buffer.subarray(0, bytesRead));
    }

    return { hash: hasher.digest(), sizeBytes };
  } finally {
    await handle.close();
  }
}

/**
 * The pre-filter. True when nothing about the inode has moved since the previous scan, so
 * the previous hash still describes the bytes.
 *
 * Size and mtime alone are forgeable — `touch -r` after a rewrite reproduces both — so
 * ctime and the inode number are in the comparison too. ctime is set by the kernel on
 * every inode change and cannot be assigned by a caller, which is what makes this a filter
 * rather than a guess. It is still a filter: `rehashAll` exists for the pass that trusts
 * nothing, and the hash, never this, is what any decision is made against.
 */
function isUnchangedSince(previous: ScannedFile | undefined, stats: fs.Stats): boolean {
  return (
    previous !== undefined &&
    previous.sizeBytes === stats.size &&
    previous.mtimeMs === stats.mtimeMs &&
    previous.ctimeMs === stats.ctimeMs &&
    previous.inode === stats.ino
  );
}

// ---------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function joinRelative(base: string, name: string): string {
  return base === "" ? name : `${base}/${name}`;
}

type WalkFrame = {
  readonly relative: string;
  readonly layers: readonly IgnoreLayer[];
};

/**
 * Walks `root` and hashes every file that is allowed to sync.
 *
 * Never recurses into a symlinked directory and never opens a symlinked file, so a link
 * pointing at `$HOME` cannot pull a home directory into a shared workspace. Never
 * follows a link even to decide what kind of thing it points at: every stat here is an
 * `lstat`.
 */
export async function scanProject(options: ScanOptions): Promise<ScanResult> {
  const root = path.resolve(options.root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const previous = options.rehashAll === true ? undefined : options.previous;

  const files = new Map<string, ScannedFile>();
  const skipped: ScanSkip[] = [];
  const incompleteReasons: string[] = [];
  let filesHashed = 0;
  let bytesHashed = 0;
  let filesReused = 0;

  function markIncomplete(reason: string): void {
    incompleteReasons.push(reason);
  }

  const stack: WalkFrame[] = [{ relative: "", layers: [] }];

  while (stack.length > 0) {
    if (options.signal?.aborted === true) {
      // Returning what we have with `complete: true` would present a truncated tree as the
      // whole truth, and every unvisited path would read as a deletion.
      markIncomplete("The scan was cancelled before it finished.");
      break;
    }

    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }

    const absoluteDirectory = frame.relative === "" ? root : path.join(root, frame.relative);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      const vanished = code === "ENOENT" && frame.relative !== "";
      skipped.push({
        path: frame.relative,
        reason: vanished ? "vanished" : "unreadable",
        isDirectory: true,
        detail: describeError(error),
      });
      if (!vanished) {
        // Including a missing root. A project directory that is not there is the one input
        // most likely to erase a cloud copy, and it must never look like an empty project.
        markIncomplete(
          `Could not read ${frame.relative === "" ? "the project directory" : frame.relative}: ${describeError(error)}`,
        );
      }
      continue;
    }

    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    let layers = frame.layers;
    const gitignoreEntry = entries.find((entry) => entry.name === ".gitignore");
    if (gitignoreEntry !== undefined && !gitignoreEntry.isSymbolicLink()) {
      const gitignorePath = path.join(absoluteDirectory, ".gitignore");
      try {
        const handle = await fs.promises.open(gitignorePath, fs.constants.O_RDONLY | O_NOFOLLOW);
        try {
          const contents = await handle.readFile("utf8");
          layers = [...layers, { base: frame.relative, patterns: compileGitignore(contents) }];
        } finally {
          await handle.close();
        }
      } catch (error) {
        // An exclusion rule we cannot read is an exclusion set that differs between passes,
        // and the spec names a changing exclusion set as a cause of mass deletion. Refuse
        // the pass rather than sync a tree under rules we could not load.
        skipped.push({
          path: joinRelative(frame.relative, ".gitignore"),
          reason: "unreadable",
          isDirectory: false,
          detail: describeError(error),
        });
        markIncomplete(
          `Could not read ${joinRelative(frame.relative, ".gitignore")}, so its exclusions are unknown: ${describeError(error)}`,
        );
      }
    }

    const childDirectories: WalkFrame[] = [];

    for (const entry of entries) {
      const relative = joinRelative(frame.relative, entry.name);

      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: "symlink", isDirectory: false });
        continue;
      }

      // Some filesystems report an unknown dirent type; ask the inode rather than guess.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      let stats: fs.Stats | undefined;

      if (!isDirectory && !isFile) {
        try {
          stats = await fs.promises.lstat(path.join(absoluteDirectory, entry.name));
        } catch (error) {
          const code = errorCode(error);
          skipped.push({
            path: relative,
            reason: code === "ENOENT" ? "vanished" : "unreadable",
            isDirectory: false,
            detail: describeError(error),
          });
          if (code !== "ENOENT") {
            markIncomplete(`Could not inspect ${relative}: ${describeError(error)}`);
          }
          continue;
        }
        if (stats.isSymbolicLink()) {
          skipped.push({ path: relative, reason: "symlink", isDirectory: false });
          continue;
        }
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      }

      if (!isDirectory && !isFile) {
        skipped.push({ path: relative, reason: "unsupportedType", isDirectory: false });
        continue;
      }

      if (
        isAlwaysIgnoredName(entry.name, isDirectory) ||
        isPathIgnored(layers, relative, isDirectory)
      ) {
        // Recorded, not merely dropped. An ignored path is a path whose local state we did
        // not look at, and the reconciler must not read that as an absence.
        skipped.push({ path: relative, reason: "ignored", isDirectory });
        continue;
      }

      if (isDirectory) {
        childDirectories.push({ relative, layers });
        continue;
      }

      if (stats === undefined) {
        try {
          stats = await fs.promises.lstat(path.join(absoluteDirectory, entry.name));
        } catch (error) {
          const code = errorCode(error);
          skipped.push({
            path: relative,
            reason: code === "ENOENT" ? "vanished" : "unreadable",
            isDirectory: false,
            detail: describeError(error),
          });
          if (code !== "ENOENT") {
            markIncomplete(`Could not inspect ${relative}: ${describeError(error)}`);
          }
          continue;
        }
      }

      if (stats.size > maxFileBytes) {
        skipped.push({
          path: relative,
          reason: "tooLarge",
          isDirectory: false,
          sizeBytes: stats.size,
        });
        continue;
      }

      const remembered = previous?.get(relative);
      if (isUnchangedSince(remembered, stats) && remembered !== undefined) {
        files.set(relative, {
          hash: remembered.hash,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          inode: stats.ino,
        });
        filesReused += 1;
        continue;
      }

      try {
        const hashed = await hashFileAt(path.join(absoluteDirectory, entry.name), maxFileBytes);
        if ("tooLarge" in hashed) {
          skipped.push({ path: relative, reason: "tooLarge", isDirectory: false });
          continue;
        }
        files.set(relative, {
          hash: hashed.hash,
          sizeBytes: hashed.sizeBytes,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          inode: stats.ino,
        });
        filesHashed += 1;
        bytesHashed += hashed.sizeBytes;
      } catch (error) {
        const code = errorCode(error);
        const vanished = code === "ENOENT";
        skipped.push({
          path: relative,
          reason: vanished ? "vanished" : "unreadable",
          isDirectory: false,
          detail: describeError(error),
        });
        if (!vanished) {
          markIncomplete(`Could not read ${relative}: ${describeError(error)}`);
        }
      }
    }

    // Reversed, so a stack pops them in the order they were listed and two runs over the
    // same tree produce the same sequence of reads.
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      const child = childDirectories[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }

  return {
    root,
    files,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    skipped,
    filesHashed,
    bytesHashed,
    filesReused,
  };
}

// ---------------------------------------------------------------------------------------
// Turning skips into an exclusion the reconciler can be given
// ---------------------------------------------------------------------------------------

/**
 * A predicate for "the scan did not determine this path's local state".
 *
 * Every skip except `vanished` produces one: an ignored, oversized, symlinked or unreadable
 * path is absent from the map for a reason that has nothing to do with the user deleting
 * it, and handing that absence to the reconciler turns it into a remote delete. `vanished`
 * is the one case where absence is the truth — the file really is gone — so it is not
 * excluded and the delete propagates as the user intended.
 *
 * Skipped directories exclude their whole subtree: nothing under a directory we refused to
 * open is known, whatever the server's index says about it.
 */
export function createUnknownPathPredicate(
  result: Pick<ScanResult, "skipped">,
): (relativePath: string) => boolean {
  const unknownFiles = new Set<string>();
  const unknownDirectories = new Set<string>();

  for (const skip of result.skipped) {
    if (skip.reason === "vanished") {
      continue;
    }
    if (skip.isDirectory) {
      unknownDirectories.add(skip.path);
    } else {
      unknownFiles.add(skip.path);
    }
  }

  return (relativePath) => {
    if (unknownFiles.has(relativePath)) {
      return true;
    }
    if (unknownDirectories.size === 0) {
      return false;
    }
    // Walk the ancestors rather than every recorded prefix: a project has deep paths and a
    // long list of skips, and this runs once per path in the union of three trees.
    let index = relativePath.indexOf("/");
    while (index !== -1) {
      if (unknownDirectories.has(relativePath.slice(0, index))) {
        return true;
      }
      index = relativePath.indexOf("/", index + 1);
    }
    return unknownDirectories.has(relativePath);
  };
}

export type ScanSummary = {
  readonly root: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly skippedCount: number;
  readonly skipped: readonly ScanSkip[];
  readonly filesHashed: number;
  readonly filesReused: number;
};

/**
 * A scan reduced to what a UI can render and an IPC boundary can carry. The skip list is
 * truncated because a large ignored tree produces thousands of entries, and `skippedCount`
 * is reported separately so the truncation is visible rather than reassuring.
 */
export function summariseScan(result: ScanResult, maxSkipped = 200): ScanSummary {
  let totalBytes = 0;
  for (const file of result.files.values()) {
    totalBytes += file.sizeBytes;
  }

  return {
    root: result.root,
    fileCount: result.files.size,
    totalBytes,
    complete: result.complete,
    incompleteReasons: result.incompleteReasons,
    skippedCount: result.skipped.length,
    skipped: result.skipped.slice(0, maxSkipped),
    filesHashed: result.filesHashed,
    filesReused: result.filesReused,
  };
}
