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
import { makeDirectoryRegistry, type PackRecord } from "@t3tools/pack-cli/registry";
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

/**
 * The shipped packs, one per id, in an order that does not depend on the
 * filesystem.
 *
 * A shipped pack is addressed by its name rather than by the id in its
 * manifest, which is what keeps `ssh-deploy` and the `ssh-flask-deploy` it was
 * renamed from — two directories sharing one permanent manifest id — from
 * pointing at each other here. Names are only unique per publisher though, so
 * two publishers shipping an `ssh-deploy` into one registry would land on one
 * `verified:ssh-deploy` again. That is settled here rather than by widening the
 * id to include the publisher: the id is what a workspace's enablement rows are
 * keyed on, and widening it would quietly turn every pack somebody has already
 * turned on into a pack nobody has heard of.
 *
 * So one of them is served and the other is left out of the listing entirely,
 * deterministically and out loud. A pack that is not offered is a pack nobody
 * clicks; a pack that is offered and opens as its namesake is worse.
 */
async function readShipped(
  root: string,
): Promise<ReadonlyArray<{ readonly packId: string; readonly record: PackRecord }>> {
  const store = makeNodePackStore();
  const registry = makeDirectoryRegistry(store, root);
  // An empty query matches everything the registry can read; unreadable packs
  // are reported by the registry rather than silently skipped, and a pack we
  // cannot parse is one we should not be claiming is verified either.
  const outcome = await registry.search({ query: "" });

  const shipped = new Map<string, PackRecord>();
  for (const hit of outcome.hits.toSorted((left, right) =>
    left.record.ref.qualified.localeCompare(right.record.ref.qualified),
  )) {
    const packId = `${VERIFIED_PACK_ID_PREFIX}${hit.record.manifest.identity.name}`;
    const held = shipped.get(packId);
    if (held !== undefined) {
      console.warn(
        `[packs] ${hit.record.ref.qualified} is not being offered: ${held.ref.qualified} already answers to ${packId}.`,
      );
      continue;
    }
    shipped.set(packId, hit.record);
  }
  return [...shipped].map(([packId, record]) => ({ packId, record }));
}

async function loadFromDisk(): Promise<
  ReadonlyArray<Omit<PackRegistryEntry, "tenantId" | "workspaceId">>
> {
  const root = verifiedPackRoot();
  if (root === undefined) {
    return [];
  }

  return (await readShipped(root)).map((shipped) => {
    const { identity, capability } = shipped.record.manifest;
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
  try {
    // Resolved the same way the listing was, so the pack a search offered is
    // the pack that opens. Asking the registry for the name directly would be
    // cheaper and would answer with whichever namesake the filesystem handed
    // over first, which is the whole failure this is here to avoid.
    const record = (await readShipped(root)).find((shipped) => shipped.packId === packId)?.record;
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
