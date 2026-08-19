import * as Crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

/**
 * The content-addressed store behind cloud sync's transport.
 *
 * Every byte that crosses the wire is named by the hash of its own content, and
 * that single decision buys the three things `docs/cloud-sync-spec.md` asks of
 * the transport:
 *
 *   - *a re-share of a mostly-unchanged tree moves almost nothing*, because the
 *     laptop asks which hashes the server is missing and sends only those;
 *   - *idempotent per chunk*, because a chunk is identified by the blob it
 *     belongs to and its offset within it, so re-sending one after a dropped
 *     connection overwrites the same bytes with the same bytes;
 *   - *never readable half-written*, because bytes accumulate in a `.part` file
 *     that nothing reads and appear under their hash only after a rename, which
 *     is atomic within a filesystem.
 *
 * A blob is admitted only if it hashes to the name it was sent under. That is
 * not a nicety: the name is the only thing a later pass compares, so a blob
 * stored under the wrong name would be handed out for years as content it is
 * not, and the reconciler would call every copy of it "unchanged".
 */

/**
 * One algorithm, named once, hex and lower case.
 *
 * The reconciler treats hashes as opaque strings and so cannot notice that two
 * sides hashed differently; it would simply report every file as changed on
 * both sides, which is a conflict per file. The agreement therefore has to live
 * somewhere, and it lives here.
 */
export const CLOUD_SYNC_HASH_ALGORITHM = "sha256";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A hash arrives in a URL path and is then used as a filename, so this is a
 * path-traversal guard as much as a format check. Nothing downstream needs to
 * re-examine a hash that got past here: 64 characters of `[0-9a-f]` contains no
 * separator, no `..`, and no NUL.
 */
export function isCloudSyncHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

export function hashBytes(bytes: Uint8Array): string {
  return Crypto.createHash(CLOUD_SYNC_HASH_ALGORITHM).update(bytes).digest("hex");
}

/** Where one project's blobs live. Resolved once and passed around. */
export interface BlobStoreRoot {
  readonly blobsDir: string;
  readonly incomingDir: string;
}

/**
 * A store per project rather than one for the whole server.
 *
 * Content addressing makes a hash a capability: anyone who can name a hash can
 * fetch its bytes, and a collaborator in one workspace can trivially name the
 * hash of a file they already hold. With one shared store that is a read of
 * another workspace's file; scoped per project, the membership check on the
 * route is the only way in and there is nothing to guess. The cost is that two
 * projects containing the same file store it twice, which is a disk-space
 * question rather than a correctness one — and de-duplication *within* a
 * project across passes, which is what makes a re-share cheap, is unaffected.
 *
 * The directory is named by a digest of the project id and never by the id
 * itself. A `ProjectId` is only guaranteed to be a non-empty trimmed string, so
 * it can contain a separator; a digest cannot, whatever arrives on the wire.
 */
export function blobStoreRoot(stateDir: string, projectId: string): BlobStoreRoot {
  const digest = Crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 40);
  const projectDir = nodePath.join(stateDir, "cloud-sync", digest);
  return {
    blobsDir: nodePath.join(projectDir, "blobs"),
    incomingDir: nodePath.join(projectDir, "incoming"),
  };
}

/**
 * Two characters of fan-out. A project of twenty thousand files is the design
 * point, and twenty thousand entries in one directory turns every lookup on
 * several filesystems into a linear scan.
 */
function blobPath(root: BlobStoreRoot, hash: string): string {
  return nodePath.join(root.blobsDir, hash.slice(0, 2), hash);
}

function partPath(root: BlobStoreRoot, hash: string): string {
  return nodePath.join(root.incomingDir, `${hash}.part`);
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const stats = await fsPromises.stat(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export interface BlobStatus {
  /** The blob is complete, verified and readable at its hash. */
  readonly stored: boolean;
  /** Bytes of a resumable upload already accepted. Zero when nothing is in flight. */
  readonly received: number;
  /** Size of the stored blob, or null when it is not stored. */
  readonly sizeBytes: number | null;
}

/**
 * What the server already has, which is the whole of the resume protocol: a
 * client that dropped mid-upload asks this and continues from `received`
 * instead of starting a gigabyte again.
 */
export async function blobStatus(root: BlobStoreRoot, hash: string): Promise<BlobStatus> {
  const stored = await sizeOf(blobPath(root, hash));
  if (stored !== null) {
    return { stored: true, received: stored, sizeBytes: stored };
  }
  return { stored: false, received: (await sizeOf(partPath(root, hash))) ?? 0, sizeBytes: null };
}

/** Which of these the server is missing, in the order they were asked about. */
export async function missingBlobs(
  root: BlobStoreRoot,
  hashes: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const missing: string[] = [];
  for (const hash of hashes) {
    if ((await sizeOf(blobPath(root, hash))) === null) {
      missing.push(hash);
    }
  }
  return missing;
}

export type ChunkOutcome =
  | { readonly kind: "accepted"; readonly received: number }
  /**
   * The offset is past the end of what has been accepted. Writing there would
   * leave a hole of undefined bytes that hashes to nothing anyone can predict,
   * so the gap is reported and the client is told where to resume from.
   */
  | { readonly kind: "gap"; readonly received: number };

/**
 * One chunk, at an explicit offset, idempotent by construction.
 *
 * The offset is the client's, not a cursor the server keeps, and that is what
 * makes a retry safe: a chunk re-sent after a connection died lands on exactly
 * the bytes it landed on the first time. Re-sending an *earlier* chunk is
 * allowed for the same reason — it rewrites bytes with themselves, and the hash
 * check at the end is what decides whether the result is admissible, so nothing
 * here needs to trust that it did.
 */
export async function writeBlobChunk(
  root: BlobStoreRoot,
  hash: string,
  offset: number,
  bytes: Uint8Array,
): Promise<ChunkOutcome> {
  await fsPromises.mkdir(root.incomingDir, { recursive: true });
  const target = partPath(root, hash);
  const existing = (await sizeOf(target)) ?? 0;
  if (offset > existing) {
    return { kind: "gap", received: existing };
  }

  const file = await fsPromises.open(target, "a+");
  try {
    await file.write(bytes, 0, bytes.byteLength, offset);
  } finally {
    await file.close();
  }
  return { kind: "accepted", received: Math.max(existing, offset + bytes.byteLength) };
}

export type FinalizeOutcome =
  | { readonly kind: "stored"; readonly sizeBytes: number }
  /** The bytes do not hash to the name they were sent under. Discarded, never stored. */
  | { readonly kind: "hash-mismatch"; readonly actualHash: string }
  | { readonly kind: "missing" };

const HASH_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Verifies the staged bytes and, only if they check out, publishes them.
 *
 * The hash is computed by reading the staged file back rather than by
 * accumulating one as chunks arrive. Chunks may be retried and reordered, so an
 * incremental hash would be a hash of the wire traffic and not of the file; and
 * a rehash is the only thing that can catch a chunk that was corrupted on its
 * way to disk. On a mismatch the staged file is destroyed rather than left for
 * a resume, because a client that is confidently sending the wrong bytes will
 * otherwise resume sending them.
 */
export async function finalizeBlob(root: BlobStoreRoot, hash: string): Promise<FinalizeOutcome> {
  const staged = partPath(root, hash);
  const size = await sizeOf(staged);
  if (size === null) {
    const stored = await sizeOf(blobPath(root, hash));
    // Already published. Finalising twice is how a client that lost the reply
    // to its last chunk recovers, so it is a success and not a mistake.
    return stored === null ? { kind: "missing" } : { kind: "stored", sizeBytes: stored };
  }

  const digest = Crypto.createHash(CLOUD_SYNC_HASH_ALGORITHM);
  const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
  const file = await fsPromises.open(staged, "r");
  try {
    for (;;) {
      const read = await file.read(buffer, 0, HASH_READ_CHUNK_BYTES, null);
      if (read.bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await file.close();
  }

  const actualHash = digest.digest("hex");
  if (actualHash !== hash) {
    await fsPromises.rm(staged, { force: true });
    return { kind: "hash-mismatch", actualHash };
  }

  const destination = blobPath(root, hash);
  await fsPromises.mkdir(nodePath.dirname(destination), { recursive: true });
  // Rename and not copy: within a filesystem it is atomic, so the blob is
  // either absent or complete and there is no instant at which a reader could
  // see half of it under its final name.
  await fsPromises.rename(staged, destination);
  return { kind: "stored", sizeBytes: size };
}

/** The bytes under a hash, or null if the server does not have them. */
export async function readBlob(root: BlobStoreRoot, hash: string): Promise<Uint8Array | null> {
  try {
    return Uint8Array.from(await fsPromises.readFile(blobPath(root, hash)));
  } catch {
    return null;
  }
}

/**
 * Publishes bytes the server already holds — a file a collaborator wrote in the
 * browser — so the laptop can fetch it by hash like everything else. Staged and
 * renamed by the same path as an upload, for the same reason.
 */
export async function storeBytes(root: BlobStoreRoot, bytes: Uint8Array): Promise<string> {
  const hash = hashBytes(bytes);
  const destination = blobPath(root, hash);
  if ((await sizeOf(destination)) !== null) {
    return hash;
  }
  await fsPromises.mkdir(root.incomingDir, { recursive: true });
  const staged = nodePath.join(root.incomingDir, `${hash}.${Crypto.randomUUID()}.staged`);
  await fsPromises.writeFile(staged, bytes);
  await fsPromises.mkdir(nodePath.dirname(destination), { recursive: true });
  await fsPromises.rename(staged, destination);
  return hash;
}

export interface SweepReport {
  readonly removedBlobs: number;
  readonly removedParts: number;
}

/**
 * Deletes blobs nothing refers to any more.
 *
 * `keep` is every hash the project's base table still names, tombstones
 * included — a tombstone keeps the content that was agreed before the deletion,
 * which is what makes "an edit beats a delete" resolvable later.
 *
 * `graceMs` is the whole safety of this. A blob uploaded for a pass that has
 * not committed yet is referenced by nothing, and sweeping it would delete the
 * gigabyte the client just finished sending. Anything younger than the grace
 * period is therefore left alone regardless, and the grace period wants to be
 * comfortably longer than the longest plausible pass. Staged `.part` files are
 * swept on the same rule: an upload nobody resumed for that long is abandoned.
 *
 * Nothing schedules this yet; it is written here so that the answer to "what
 * happens to blobs nothing references" is a function and not a plan.
 */
export async function sweepUnreferencedBlobs(
  root: BlobStoreRoot,
  keep: ReadonlySet<string>,
  graceMs: number,
  now: number = Date.now(),
): Promise<SweepReport> {
  let removedBlobs = 0;
  let removedParts = 0;

  const fanout = await fsPromises.readdir(root.blobsDir, { withFileTypes: true }).catch(() => []);
  for (const bucket of fanout) {
    if (!bucket.isDirectory()) {
      continue;
    }
    const bucketDir = nodePath.join(root.blobsDir, bucket.name);
    const blobs = await fsPromises.readdir(bucketDir, { withFileTypes: true }).catch(() => []);
    for (const blob of blobs) {
      if (!blob.isFile() || keep.has(blob.name)) {
        continue;
      }
      const path = nodePath.join(bucketDir, blob.name);
      const stats = await fsPromises.stat(path).catch(() => null);
      if (stats === null || now - stats.mtimeMs < graceMs) {
        continue;
      }
      await fsPromises.rm(path, { force: true });
      removedBlobs += 1;
    }
  }

  const staged = await fsPromises
    .readdir(root.incomingDir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of staged) {
    if (!entry.isFile()) {
      continue;
    }
    const path = nodePath.join(root.incomingDir, entry.name);
    const stats = await fsPromises.stat(path).catch(() => null);
    if (stats === null || now - stats.mtimeMs < graceMs) {
      continue;
    }
    await fsPromises.rm(path, { force: true });
    removedParts += 1;
  }

  return { removedBlobs, removedParts };
}
