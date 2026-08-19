/**
 * Which pack an id names, when more than one pack claims it.
 *
 * `identity.id` is authored data. The format says it is permanent and survives
 * a rename, which is what lets an install record outlive `ssh-flask-deploy`
 * becoming `ssh-deploy` — and it is also how one id ends up on two packs at
 * once. A registry keeps one directory per `publisher/name`, so the rename
 * leaves the old releases sitting beside the new ones under the same id. Copy a
 * pack directory and edit the name and you get there too, without a rename
 * anywhere in the story.
 *
 * Nothing downstream survives that. A registry hands out an id and a caller
 * opens a page with it, so an id claimed by two packs means one of them opens
 * the other's page — you click `ssh-flask-deploy` and read `ssh-deploy`. That
 * is worse than a dead link, because nothing about the page says it is the
 * wrong one.
 *
 * So this module decides what a registry serves rather than what a manifest
 * says. The rule is short: an id one pack claims is that pack's; an id two
 * packs claim belongs to neither, and both fall back to an address derived from
 * the pair the registry already keeps unique — `publisher/name`. The
 * contested id is then served to nobody and reported instead, which turns a
 * page showing the wrong pack into a link that does not resolve and a conflict
 * somebody can go and fix.
 *
 * Manifests are never rewritten to fix this. The id is permanent by definition,
 * and manifests are signed over their bytes: healing on disk would strip the
 * one thing that proves a release is what its publisher published.
 *
 * @module packIdentity
 */

/**
 * Marks an address this file derived, rather than one a publisher chose. The
 * colon is deliberate — `pack_` ids are opaque, so a reader who sees
 * `pack:t3demo/ssh-deploy` can tell at a glance that nobody minted it.
 */
export const DERIVED_PACK_ID_PREFIX = "pack:";

/** What a registry knows about one pack before any id is settled. */
export interface PackIdClaim {
  readonly publisher: string | undefined;
  readonly name: string;
  /** The id in the manifest, which may be missing and may not be unique. */
  readonly id: string | undefined;
}

/** An id more than one pack claims, and therefore no pack is served under. */
export interface PackIdConflict {
  readonly id: string;
  /** Every pack that claims it, as `publisher/name`, sorted for a stable message. */
  readonly claimedBy: ReadonlyArray<string>;
}

export interface ResolvedPackIds {
  /**
   * The id to serve for each pack, keyed by its derived address so a caller can
   * look one up without carrying object identity around.
   */
  readonly served: ReadonlyMap<string, string>;
  readonly conflicts: ReadonlyArray<PackIdConflict>;
}

/**
 * A pack's address derived from what makes it distinct in a registry rather
 * than from anything it was handed.
 *
 * `publisher/name` is the pair a registry already guarantees is unique — it is
 * the directory name — so two genuinely different packs cannot land on the same
 * derived address however much else they share: same title, same capability,
 * same tags, same first release, same lineage.
 */
export function derivePackId(claim: Pick<PackIdClaim, "publisher" | "name">): string {
  const publisher = claim.publisher !== undefined ? `${claim.publisher}/` : "";
  return `${DERIVED_PACK_ID_PREFIX}${publisher}${claim.name}`;
}

/** `publisher/name`, which is what a conflict message has to name to be followable. */
function qualify(claim: PackIdClaim): string {
  return claim.publisher !== undefined ? `${claim.publisher}/${claim.name}` : claim.name;
}

/**
 * Settles the ids for every pack a registry holds, together.
 *
 * It has to be all of them at once: whether `pack_c7f9…` names this pack is not
 * a fact about this pack, it is a fact about whether anything else claims it.
 *
 * A derived address counts as a claim too, so a manifest cannot take an id that
 * some other pack would otherwise be served under. That keeps the guarantee
 * total rather than nearly total: every pack ends up on either an uncontested
 * manifest id or its own derived address, and derived addresses are unique by
 * construction, so no two packs can come out of here sharing an id.
 *
 * Callers must pass one claim per `publisher/name`; a registry that held two
 * would have had to put them in one directory.
 */
export function resolvePackIds(claims: ReadonlyArray<PackIdClaim>): ResolvedPackIds {
  const derived = claims.map((claim) => ({ claim, address: derivePackId(claim) }));

  const claimants = new Map<string, Array<string>>();
  const claimOn = (id: string, by: string): void => {
    const existing = claimants.get(id);
    if (existing === undefined) {
      claimants.set(id, [by]);
    } else if (!existing.includes(by)) {
      existing.push(by);
    }
  };
  for (const entry of derived) {
    claimOn(entry.address, qualify(entry.claim));
    if (entry.claim.id !== undefined) {
      claimOn(entry.claim.id, qualify(entry.claim));
    }
  }

  const served = new Map<string, string>();
  for (const entry of derived) {
    const claimed = entry.claim.id;
    const contested = claimed === undefined || (claimants.get(claimed)?.length ?? 0) > 1;
    served.set(entry.address, contested || claimed === undefined ? entry.address : claimed);
  }

  const conflicts = [...claimants]
    .filter(([, holders]) => holders.length > 1)
    .map(([id, holders]) => ({ id, claimedBy: holders.toSorted() }))
    .toSorted((left, right) => left.id.localeCompare(right.id));

  return { served, conflicts };
}

/** The conflict a given pack is caught up in, if any. */
export function conflictFor(
  resolved: ResolvedPackIds,
  claim: PackIdClaim,
): PackIdConflict | undefined {
  return claim.id === undefined
    ? undefined
    : resolved.conflicts.find((conflict) => conflict.id === claim.id);
}
