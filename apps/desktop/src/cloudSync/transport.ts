/**
 * The laptop's half of the cloud-sync wire protocol (`apps/server/src/cloudSync/http.ts`).
 *
 * Every piece of the laptop side existed except this and the controller above it: `scan.ts`
 * reads the tree, `apply.ts` writes one path safely, `watch.ts` says when something moved,
 * and `reconcile.ts` decides what should happen. Nothing spoke to the server.
 *
 * Three things this module is deliberately strict about, because each one is a way a
 * content-addressed store quietly stops being one:
 *
 * - **A hash is a name, not a description.** Bytes are sent under the hash the local scan
 *   computed, and the server verifies and destroys a mismatch. This module never "fixes up"
 *   a hash and never retries a mismatch under a different name.
 * - **Offsets are the client's.** A chunk re-sent after a dropped connection must land on
 *   exactly the bytes it landed on before, so resumption reads the server's own `received`
 *   count rather than assuming anything.
 * - **A refusal is not a failure.** `/pass` answers 409 with numbers when it will not run,
 *   and that has to reach the caller as a decision somebody must look at — not as a network
 *   error to be retried in a loop.
 *
 * `fetch` is injected so every path here is exercised without a server.
 */

import {
  CLOUD_SYNC_MAX_CHUNK_BYTES,
  CLOUD_SYNC_MAX_NEGOTIATED_HASHES,
  type CloudSyncEntry,
  type CloudSyncPlannedConflict,
} from "@t3tools/contracts";

import type { CloudSyncPassResult } from "./passPlan.ts";

export { CLOUD_SYNC_MAX_CHUNK_BYTES, CLOUD_SYNC_MAX_NEGOTIATED_HASHES };

export type CloudSyncScope = {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly projectId: string;
};

export type TransportOptions = {
  /** The cloud base URL, with or without a trailing slash. */
  readonly baseUrl: string;
  /** Sent as `authorization` on every call. */
  readonly authorization: string;
  readonly scope: CloudSyncScope;
  readonly fetch?: typeof globalThis.fetch | undefined;
};

/**
 * A call that did not get an answer we can act on.
 *
 * Carries the status when there was one, because "the server said no" and "the server was
 * not there" lead to different advice and the UI has to tell them apart.
 */
export class CloudSyncTransportError extends Error {
  // A plain field rather than a parameter property: `erasableSyntaxOnly` is on,
  // so the shorthand would be syntax the compiler cannot simply erase.
  readonly detail: { readonly status?: number | undefined; readonly cause?: unknown };

  constructor(
    message: string,
    detail: { readonly status?: number | undefined; readonly cause?: unknown },
  ) {
    super(message);
    this.name = "CloudSyncTransportError";
    this.detail = detail;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function scopeQuery(scope: CloudSyncScope): string {
  return new URLSearchParams({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  }).toString();
}

export function createCloudSyncTransport(options: TransportOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = { authorization: options.authorization };

  const postJson = async (path: string, body: unknown): Promise<Response> => {
    try {
      return await doFetch(joinUrl(options.baseUrl, path), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ...options.scope, ...(body as Record<string, unknown>) }),
      });
    } catch (cause) {
      throw new CloudSyncTransportError(`Could not reach the cloud copy (${path}).`, { cause });
    }
  };

  const readJson = async (response: Response, path: string): Promise<unknown> => {
    try {
      return await response.json();
    } catch (cause) {
      throw new CloudSyncTransportError(
        `The cloud copy sent an answer we could not read (${path}).`,
        {
          status: response.status,
          cause,
        },
      );
    }
  };

  return {
    /**
     * Which of these the server is missing.
     *
     * The one chatty call in the exchange, and the reason everything after it is not: a
     * laptop re-sharing yesterday's tree learns in one round trip that it has nothing to
     * send. Longer lists are paged rather than truncated, because a hash silently dropped
     * here is content the commit later claims agreement on and does not have.
     */
    async missingBlobs(hashes: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
      const missing: string[] = [];
      for (let start = 0; start < hashes.length; start += CLOUD_SYNC_MAX_NEGOTIATED_HASHES) {
        const page = hashes.slice(start, start + CLOUD_SYNC_MAX_NEGOTIATED_HASHES);
        const response = await postJson("/api/cloud-sync/negotiate", { hashes: page });
        if (!response.ok) {
          throw new CloudSyncTransportError("The cloud copy would not say what it is missing.", {
            status: response.status,
          });
        }
        const body = (await readJson(response, "negotiate")) as {
          missing?: unknown;
        };
        if (Array.isArray(body.missing)) {
          for (const hash of body.missing) {
            if (typeof hash === "string") missing.push(hash);
          }
        }
      }
      return missing;
    },

    /**
     * How many bytes of this hash the server already holds, so a resumed upload knows
     * where to start. Zero for anything it has never seen.
     */
    async blobReceived(hash: string): Promise<number> {
      const url = `${joinUrl(options.baseUrl, `/api/cloud-sync/blobs/${hash}`)}?${scopeQuery(
        options.scope,
      )}&probe=1`;
      let response: Response;
      try {
        response = await doFetch(url, { headers });
      } catch (cause) {
        throw new CloudSyncTransportError("Could not ask the cloud copy what it has.", { cause });
      }
      if (!response.ok) return 0;
      const body = (await readJson(response, "probe")) as { received?: unknown };
      return typeof body.received === "number" && Number.isSafeInteger(body.received)
        ? body.received
        : 0;
    },

    /**
     * Sends one blob, resuming from whatever the server already has.
     *
     * `final=1` on the last chunk asks the server to verify and publish. A hash mismatch
     * comes back 422 and is raised rather than retried: the bytes on this disk do not hash
     * to the name the scan gave them, which is a local problem and sending them again
     * under the same name cannot fix it.
     */
    async uploadBlob(hash: string, bytes: Uint8Array): Promise<void> {
      const alreadyHave = await this.blobReceived(hash);
      if (alreadyHave >= bytes.byteLength) {
        // Staged in full already. Still needs the finalize, which is idempotent.
        await this.finalizeBlob(hash, bytes.byteLength, new Uint8Array());
        return;
      }
      let offset = alreadyHave;
      while (offset < bytes.byteLength) {
        const end = Math.min(offset + CLOUD_SYNC_MAX_CHUNK_BYTES, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        const isFinal = end === bytes.byteLength;
        if (isFinal) {
          await this.finalizeBlob(hash, offset, chunk);
        } else {
          await this.sendChunk(hash, offset, chunk, false);
        }
        offset = end;
      }
    },

    async sendChunk(
      hash: string,
      offset: number,
      chunk: Uint8Array,
      final: boolean,
    ): Promise<Response> {
      const query = `${scopeQuery(options.scope)}&offset=${offset}${final ? "&final=1" : ""}`;
      const url = `${joinUrl(options.baseUrl, `/api/cloud-sync/blobs/${hash}`)}?${query}`;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: chunk as unknown as BodyInit,
        });
      } catch (cause) {
        throw new CloudSyncTransportError("An upload chunk did not reach the cloud copy.", {
          cause,
        });
      }
      if (response.status === 422) {
        throw new CloudSyncTransportError(
          "The bytes on this disk do not match the hash they were read under; nothing was stored.",
          { status: 422 },
        );
      }
      if (!response.ok && response.status !== 202) {
        throw new CloudSyncTransportError("The cloud copy refused an upload chunk.", {
          status: response.status,
        });
      }
      return response;
    },

    async finalizeBlob(hash: string, offset: number, chunk: Uint8Array): Promise<void> {
      await this.sendChunk(hash, offset, chunk, true);
    },

    /** The bytes behind one hash, for a download or a conflict's remote side. */
    async fetchBlob(hash: string): Promise<Uint8Array> {
      const url = `${joinUrl(options.baseUrl, `/api/cloud-sync/blobs/${hash}`)}?${scopeQuery(
        options.scope,
      )}`;
      let response: Response;
      try {
        response = await doFetch(url, { headers });
      } catch (cause) {
        throw new CloudSyncTransportError("Could not fetch content from the cloud copy.", {
          cause,
        });
      }
      if (!response.ok) {
        throw new CloudSyncTransportError(
          "The cloud copy does not have content it planned to send.",
          {
            status: response.status,
          },
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Hands over the scan and gets back the plan, or the refusal.
     *
     * 409 is a `CloudSyncPassRefusal` and is returned, not thrown. It means a person has to
     * look — most likely because the scan behind it would have deleted files nobody
     * deleted — and the numbers travel with it so the UI can say which rather than "sync
     * failed".
     */
    async requestPass(input: {
      readonly files: ReadonlyArray<CloudSyncEntry>;
      readonly scanComplete: boolean;
    }): Promise<CloudSyncPassResult> {
      const response = await postJson("/api/cloud-sync/pass", input);
      if (response.status !== 200 && response.status !== 409) {
        throw new CloudSyncTransportError("The cloud copy would not plan this pass.", {
          status: response.status,
        });
      }
      return (await readJson(response, "pass")) as CloudSyncPassResult;
    },

    /** Publishes what both sides now agree on and advances the base. */
    async commitPass(input: {
      readonly files: ReadonlyArray<CloudSyncEntry>;
      readonly deletions: ReadonlyArray<string>;
      readonly conflicts: ReadonlyArray<CloudSyncPlannedConflict>;
      readonly final: boolean;
    }): Promise<unknown> {
      const response = await postJson("/api/cloud-sync/commit", input);
      if (!response.ok) {
        throw new CloudSyncTransportError("The cloud copy would not accept this commit.", {
          status: response.status,
        });
      }
      return readJson(response, "commit");
    },
  };
}

export type CloudSyncTransport = ReturnType<typeof createCloudSyncTransport>;
