import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  blobStatus,
  blobStoreRoot,
  finalizeBlob,
  hashBytes,
  isCloudSyncHash,
  missingBlobs,
  readBlob,
  storeBytes,
  sweepUnreferencedBlobs,
  writeBlobChunk,
} from "./blobStore.ts";
import { hashFromPath, scopeFromQuery } from "./http.ts";

const encoder = new TextEncoder();

async function tempStateDir(): Promise<string> {
  return fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "t3-cloud-sync-http-"));
}

describe("the hash in a blob URL", () => {
  it("takes a well-formed hash and nothing else", () => {
    const hash = hashBytes(encoder.encode("hello"));
    expect(hashFromPath(`/api/cloud-sync/blobs/${hash}`)).toBe(hash);
    expect(hashFromPath(`/api/cloud-sync/blobs/${hash}/`)).toBe(hash);
  });

  it("refuses anything that could become a path", () => {
    // The hash is used as a filename, so this is the traversal guard as much as
    // a format check.
    expect(hashFromPath("/api/cloud-sync/blobs/../../etc/passwd")).toBeNull();
    expect(hashFromPath("/api/cloud-sync/blobs/..")).toBeNull();
    expect(hashFromPath("/api/cloud-sync/blobs/")).toBeNull();
    expect(hashFromPath("/api/cloud-sync/blobs/NOTAHASH")).toBeNull();
    // Upper case is not the same string as lower case, and admitting both would
    // give one blob two names on a case-insensitive filesystem.
    expect(hashFromPath(`/api/cloud-sync/blobs/${"A".repeat(64)}`)).toBeNull();
    expect(hashFromPath("/api/other/blobs/" + "a".repeat(64))).toBeNull();
  });

  it("accepts only 64 hex characters", () => {
    expect(isCloudSyncHash("a".repeat(64))).toBe(true);
    expect(isCloudSyncHash("a".repeat(63))).toBe(false);
    expect(isCloudSyncHash("a".repeat(65))).toBe(false);
    expect(isCloudSyncHash(`${"a".repeat(62)}/z`)).toBe(false);
  });
});

describe("the scope on a blob request", () => {
  it("needs all three, because two of them prove nothing on their own", () => {
    const url = new URL(
      "http://localhost/api/cloud-sync/blobs/x?tenantId=t&workspaceId=w&projectId=p",
    );
    expect(scopeFromQuery(url)).toEqual({ tenantId: "t", workspaceId: "w", projectId: "p" });
    expect(
      scopeFromQuery(new URL("http://localhost/api/cloud-sync/blobs/x?tenantId=t&workspaceId=w")),
    ).toBeNull();
    expect(
      scopeFromQuery(
        new URL("http://localhost/api/cloud-sync/blobs/x?tenantId=+&workspaceId=w&projectId=p"),
      ),
    ).toBeNull();
  });
});

describe("uploading a blob", () => {
  it("resumes where it left off, and re-sending a chunk changes nothing", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const contents = encoder.encode("the quick brown fox jumps over the lazy dog");
    const hash = hashBytes(contents);

    const first = await writeBlobChunk(root, hash, 0, contents.subarray(0, 10));
    expect(first).toEqual({ kind: "accepted", received: 10 });

    // The connection dropped; the client asks where to pick up.
    expect(await blobStatus(root, hash)).toEqual({ stored: false, received: 10, sizeBytes: null });

    // It re-sends the chunk it was not sure about. Same bytes, same offset,
    // same result — that is the whole of "idempotent per chunk".
    expect(await writeBlobChunk(root, hash, 0, contents.subarray(0, 10))).toEqual({
      kind: "accepted",
      received: 10,
    });

    await writeBlobChunk(root, hash, 10, contents.subarray(10, 30));
    await writeBlobChunk(root, hash, 30, contents.subarray(30));
    expect(await finalizeBlob(root, hash)).toEqual({
      kind: "stored",
      sizeBytes: contents.byteLength,
    });
    expect(await readBlob(root, hash)).toEqual(contents);
  });

  it("refuses a chunk that starts past the end, and says where to resume", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const hash = hashBytes(encoder.encode("whatever"));

    await writeBlobChunk(root, hash, 0, encoder.encode("what"));
    // Writing at 99 would leave 95 bytes of nothing in the middle of the file,
    // and the blob would then fail its hash check looking like corruption.
    expect(await writeBlobChunk(root, hash, 99, encoder.encode("ever"))).toEqual({
      kind: "gap",
      received: 4,
    });
  });

  it("never stores content that does not hash to the name it was sent under", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const claimed = hashBytes(encoder.encode("the real file"));

    await writeBlobChunk(root, claimed, 0, encoder.encode("something else entirely"));
    const outcome = await finalizeBlob(root, claimed);
    expect(outcome.kind).toBe("hash-mismatch");

    // Not stored, and not left staged either: a client confidently sending the
    // wrong bytes would otherwise resume sending them.
    expect(await readBlob(root, claimed)).toBeNull();
    expect(await blobStatus(root, claimed)).toEqual({
      stored: false,
      received: 0,
      sizeBytes: null,
    });
  });

  it("finalising twice is a success, because that is how a lost reply recovers", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const contents = encoder.encode("once");
    const hash = hashBytes(contents);

    await writeBlobChunk(root, hash, 0, contents);
    expect(await finalizeBlob(root, hash)).toEqual({ kind: "stored", sizeBytes: 4 });
    expect(await finalizeBlob(root, hash)).toEqual({ kind: "stored", sizeBytes: 4 });
  });

  it("is never readable half-written", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const contents = encoder.encode("half a file is worse than none");
    const hash = hashBytes(contents);

    await writeBlobChunk(root, hash, 0, contents.subarray(0, 5));
    // Complete on disk somewhere, but not under its hash — so nothing can pick
    // it up and treat it as the file.
    expect(await readBlob(root, hash)).toBeNull();
    expect((await missingBlobs(root, [hash]))[0]).toBe(hash);
  });
});

describe("the negotiation", () => {
  it("reports only what the server is missing, in the order it was asked", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const held = await storeBytes(root, encoder.encode("already here"));
    const absent = hashBytes(encoder.encode("not here"));

    expect(await missingBlobs(root, [held, absent, held])).toEqual([absent]);
  });

  it("keeps one project's content out of another's, whoever names the hash", async () => {
    const stateDir = await tempStateDir();
    const contents = encoder.encode("a secret in one workspace");
    const mine = blobStoreRoot(stateDir, "project-mine");
    const theirs = blobStoreRoot(stateDir, "project-theirs");

    const hash = await storeBytes(mine, contents);
    // Content addressing makes a hash a capability. Scoped per project, knowing
    // the hash buys nothing from the other project's store.
    expect(await readBlob(theirs, hash)).toBeNull();
    expect(await readBlob(mine, hash)).toEqual(contents);
  });
});

describe("blobs nothing references", () => {
  it("sweeps the abandoned and keeps the referenced and the recent", async () => {
    const stateDir = await tempStateDir();
    const root = blobStoreRoot(stateDir, "project-atlas");
    const referenced = await storeBytes(root, encoder.encode("still in the base table"));
    const orphaned = await storeBytes(root, encoder.encode("nothing points at this"));
    const justUploaded = await storeBytes(root, encoder.encode("a pass that has not committed"));

    // A day later, with the two older blobs backdated past the grace period and
    // the third still inside it.
    const graceMs = 60 * 60 * 1000;
    const now = Date.now() + 2 * graceMs;
    const report = await sweepUnreferencedBlobs(root, new Set([referenced]), graceMs, now);
    expect(report.removedBlobs).toBe(2);
    expect(await readBlob(root, referenced)).not.toBeNull();
    expect(await readBlob(root, orphaned)).toBeNull();

    // And the same sweep run at the moment of upload keeps everything, which is
    // what stops it deleting the gigabyte a client just finished sending.
    const fresh = blobStoreRoot(stateDir, "project-fresh");
    const uploading = await storeBytes(fresh, encoder.encode(justUploaded));
    expect((await sweepUnreferencedBlobs(fresh, new Set(), graceMs)).removedBlobs).toBe(0);
    expect(await readBlob(fresh, uploading)).not.toBeNull();
  });
});
