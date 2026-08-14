/**
 * The packs that ship with the product, visible to every workspace.
 *
 * These live in the file registry, which is what the CLI — and therefore the
 * agent — reads. The server registry is a different store, holding what each
 * tenant published for itself, and it starts empty. So a workspace could hold
 * five verified packs by any reasonable account of the word and the UI would
 * show none of them, because it was asking the store that had never heard of
 * them. Merging them here makes one answer to "what packs can I use".
 *
 * They are on by default and stay on until somebody turns them off: knowledge
 * about deploying is not something a new account should have to go and find.
 * Disabling is per workspace and recorded separately — nothing here writes.
 *
 * Read from disk once and cached. The set changes when the product is
 * installed or upgraded, not while it is running, and re-reading a directory
 * on every keystroke of somebody's prompt would be a strange thing to do.
 */
import type { PackManifest, PackRegistryEntry, TenantId, WorkspaceId } from "@t3tools/contracts";
import { PackId } from "@t3tools/contracts";
import { makeDirectoryRegistry } from "@t3tools/pack-cli/registry";
import { resolveRegistryRoot } from "@t3tools/pack-cli/registryRoot";
import { makeNodePackStore } from "@t3tools/pack-cli/store";

/** Marks an entry as shipped rather than published by a tenant. */
export const VERIFIED_PACK_ID_PREFIX = "verified:";

export function isVerifiedPackId(packId: string): boolean {
  return packId.startsWith(VERIFIED_PACK_ID_PREFIX);
}

let cached: ReadonlyArray<Omit<PackRegistryEntry, "tenantId" | "workspaceId">> | undefined;

/**
 * Where the shipped packs are read from.
 *
 * Normally the machine's registry, which is where installing a pack puts it
 * and where the CLI looks — that is the whole point, since the agent and the
 * UI have to agree about what exists. T3CODE_VERIFIED_PACKS overrides it, and
 * setting it to "none" turns the whole idea off: a test asserting that one
 * workspace cannot see another's packs should not depend on what happens to be
 * installed on the machine running it.
 */
function verifiedPackRoot(): string | undefined {
  const override = process.env["T3CODE_VERIFIED_PACKS"];
  if (override === "none") {
    return undefined;
  }
  return override !== undefined && override.length > 0 ? override : resolveRegistryRoot(undefined);
}

async function loadFromDisk(): Promise<
  ReadonlyArray<Omit<PackRegistryEntry, "tenantId" | "workspaceId">>
> {
  const root = verifiedPackRoot();
  if (root === undefined) {
    return [];
  }
  const store = makeNodePackStore();
  const registry = makeDirectoryRegistry(store, root);
  // An empty query matches everything the registry can read; unreadable packs
  // are reported by the registry rather than silently skipped, and a pack we
  // cannot parse is one we should not be claiming is verified either.
  const outcome = await registry.search({ query: "" });

  return outcome.hits.map((hit) => {
    const { identity, capability } = hit.record.manifest;
    // The registry is the source of these, not the clock — but a registry
    // entry has to carry timestamps, and a shipped pack has no publish event
    // to take them from.
    const stamped = new Date(0).toISOString();
    return {
      packId: PackId.make(`${VERIFIED_PACK_ID_PREFIX}${identity.name}`),
      name: identity.name,
      publisherHandle: identity.publisher.handle,
      displayName: identity.displayName,
      summary: identity.summary,
      capabilitySummary: capability.does,
      tags: identity.tags ?? [],
      visibility: { scope: "public" as const },
      latestVersion: identity.version,
      createdAt: stamped,
      updatedAt: stamped,
    };
  });
}

/**
 * Every shipped pack, stamped with the workspace asking.
 *
 * Failure returns nothing rather than throwing: no registry on disk is an
 * ordinary state for a fresh install, and a search that fails outright would
 * take the tenant's own packs down with it.
 */
export async function listVerifiedPacks(
  tenantId: TenantId,
  workspaceId: WorkspaceId,
): Promise<ReadonlyArray<PackRegistryEntry>> {
  if (cached === undefined) {
    try {
      cached = await loadFromDisk();
    } catch {
      cached = [];
    }
  }
  return cached.map((entry) => ({ ...entry, tenantId, workspaceId }));
}

/**
 * One shipped pack, with its manifest.
 *
 * Search and read have to agree about what exists. Offering a pack in a list
 * and then failing to open it is worse than not offering it, because the
 * person has already decided they want it.
 */
export async function getVerifiedPack(
  packId: string,
): Promise<{ manifest: PackManifest; version: string } | undefined> {
  if (!isVerifiedPackId(packId)) {
    return undefined;
  }
  const root = verifiedPackRoot();
  if (root === undefined) {
    return undefined;
  }
  const name = packId.slice(VERIFIED_PACK_ID_PREFIX.length);
  try {
    const record = await makeDirectoryRegistry(makeNodePackStore(), root).get({ name });
    if (record === undefined) {
      return undefined;
    }
    return {
      manifest: record.manifest,
      // A record without a version would be a registry that cannot say which
      // release it just handed over, which is not something to paper over.
      version: record.ref.version ?? record.manifest.identity.version,
    };
  } catch {
    return undefined;
  }
}

/** Only for tests, which need a registry other than the one on this machine. */
export function resetVerifiedPackCache(): void {
  cached = undefined;
}
