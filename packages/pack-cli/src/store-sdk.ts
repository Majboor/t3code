/**
 * The same registry, served by a T3 server over the SDK.
 *
 * A registry that lives beside the agent is the common case; a registry that
 * lives on a server is the shared one, and it answers the same three questions.
 * The pack itself is still authored on local disk — `--server` says where a
 * release goes, not where the working copy lives.
 *
 * The served registry indexes packs rather than files, so a search returns
 * entries and the manifest behind each one is fetched separately; scoring stays
 * here so a local and a served search rank the same way.
 *
 * @module store-sdk
 */
import type { T3Api } from "@t3tools/sdk";

import { PackCliError, type PackCliErrorCode } from "./errors.ts";
import { parseManifestJson, readCard, readRef } from "./manifest.ts";
import type { PackRecord, PackRegistry, PackSearchHit } from "./registry.ts";

/** How many index entries a lookup opens before giving up on a name. */
const LOOKUP_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 10;

const ERROR_CODES: Record<string, PackCliErrorCode> = {
  "pack-not-found": "pack-not-found",
  "manifest-not-found": "manifest-not-found",
  "manifest-invalid": "manifest-invalid",
  "format-version-unsupported": "format-version-unsupported",
  "version-exists": "version-exists",
};

/**
 * A refusal from the registry is a failure about a pack, so it keeps its own
 * code and message rather than collapsing into a transport error the caller
 * cannot act on.
 */
function toRegistryError(cause: unknown): PackCliError {
  if (typeof cause === "object" && cause !== null && "code" in cause && "message" in cause) {
    const code = (cause as { readonly code: unknown }).code;
    const message = (cause as { readonly message: unknown }).message;
    if (typeof code === "string" && typeof message === "string") {
      return new PackCliError(ERROR_CODES[code] ?? "registry-unavailable", message, {
        registryCode: code,
      });
    }
  }
  return new PackCliError(
    "registry-unavailable",
    cause instanceof Error ? cause.message : String(cause),
  );
}

async function attempt<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch (cause) {
    throw toRegistryError(cause);
  }
}

/** Everything a served record carries that a directory record gets from a path. */
function toRecord(input: {
  readonly manifest: unknown;
  readonly address: string;
}): PackRecord | undefined {
  const read = parseManifestJson(JSON.stringify(input.manifest));
  if (!read.ok) {
    return undefined;
  }
  return {
    ref: readRef(read.manifest),
    card: readCard(read.manifest),
    manifest: read.manifest,
    directory: input.address,
  };
}

function splitName(name: string): { readonly name: string; readonly publisher: string | undefined } {
  const separator = name.indexOf("/");
  return separator === -1
    ? { name, publisher: undefined }
    : { name: name.slice(separator + 1), publisher: name.slice(0, separator) };
}

/** Taken off the wire so this module keeps its distance from the pack schemas. */
type PackIdentifier = Parameters<T3Api["packs"]["get"]>[0]["packId"];

export interface SdkPackRegistryScope {
  readonly client: Pick<T3Api, "packs">;
  readonly tenantId: Parameters<T3Api["packs"]["search"]>[0]["tenantId"];
  readonly workspaceId: Parameters<T3Api["packs"]["search"]>[0]["workspaceId"];
  /** What the registry is called in a receipt: the server it was reached at. */
  readonly label: string;
}

/**
 * Resolves the workspace a served registry is read and published as.
 *
 * The CLI has no workspace in hand, so it asks the server which one this token
 * is signed in to — a scope the caller could name is a scope the caller could
 * get wrong, and publishing into somebody else's workspace is not a mistake
 * worth allowing.
 */
export async function resolveSdkPackScope(input: {
  readonly client: Pick<T3Api, "packs" | "organizations">;
  readonly label: string;
}): Promise<SdkPackRegistryScope> {
  const snapshot = await attempt(() => input.client.organizations.list());
  const tenantId = snapshot.tenants[0]?.id;
  const workspaceId = (snapshot.workspaces ?? []).find(
    (workspace) => workspace.tenantId === tenantId && workspace.archivedAt === null,
  )?.id;
  if (tenantId === undefined || workspaceId === undefined) {
    throw new PackCliError(
      "registry-unavailable",
      `${input.label} has no workspace this account can publish to.`,
      { registry: input.label },
    );
  }
  return { client: input.client, tenantId, workspaceId, label: input.label };
}

export function makeSdkPackRegistry(scope: SdkPackRegistryScope): PackRegistry {
  const { client, tenantId, workspaceId } = scope;

  const openEntry = async (
    packId: PackIdentifier,
    version?: string,
  ): Promise<PackRecord | undefined> => {
    const found = await attempt(() =>
      client.packs.get({
        tenantId,
        workspaceId,
        packId,
        ...(version === undefined ? {} : { version }),
      }),
    );
    return toRecord({ manifest: found.manifest, address: found.pack.name });
  };

  const searchEntries = (query: string, limit: number) =>
    attempt(() => client.packs.search({ tenantId, workspaceId, query, limit }));

  return {
    root: scope.label,

    search: async (input) => {
      const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
      const { packs } = await searchEntries(input.query, limit);
      const hits: Array<PackSearchHit> = [];
      const unreadable: Array<{ directory: string; reason: string }> = [];

      for (const entry of packs) {
        const record = await openEntry(entry.packId);
        if (record === undefined) {
          unreadable.push({
            directory: entry.name,
            reason: `${entry.name}@${entry.latestVersion} could not be read.`,
          });
          continue;
        }
        const { card } = record;
        if (input.category !== undefined && !(card.categories ?? []).includes(input.category)) {
          continue;
        }
        if (input.tag !== undefined && !(card.tags ?? []).includes(input.tag)) {
          continue;
        }
        // The registry already ranked these; the score records that it matched
        // rather than restating a judgement made on the other side.
        hits.push({ record, score: packs.length - hits.length, matched: [input.query] });
      }

      return { hits: hits.slice(0, limit), scanned: packs.length, unreadable };
    },

    get: async (input) => {
      const wanted = splitName(input.name);
      const { packs } = await searchEntries(wanted.name, LOOKUP_LIMIT);
      const entry = packs.find(
        (candidate) =>
          candidate.name === wanted.name &&
          (wanted.publisher === undefined || candidate.publisherHandle === wanted.publisher),
      );
      if (entry === undefined) {
        return undefined;
      }
      return openEntry(entry.packId, input.version);
    },

    record: async (input) => {
      const read = parseManifestJson(input.manifestJson);
      if (!read.ok) {
        throw new PackCliError(read.reason, read.message, {
          pack: input.name,
          version: input.version,
        });
      }
      const published = await attempt(() =>
        client.packs.publish({ tenantId, workspaceId, manifest: read.manifest }),
      );
      return {
        directory: published.pack.name,
        versionPath: `${published.pack.name}@${published.version.version}`,
      };
    },
  };
}
