/**
 * Pure helpers for the pack-mode popover's "Browse all packs" modal.
 *
 * `packDirectory.browsePacks` hands back every candidate with its signals
 * attached and unfiltered, on purpose: filtering happens here, in code with no
 * transport in it, so flipping a filter toggle re-renders instantly instead of
 * making another round trip. Kept free of React for the same reason
 * `packBrowser.logic.ts` and `packMode.logic.ts` are.
 */
import { isVerifiedPackId } from "@t3tools/contracts";

import type { Pack, PackRequirements, PackScope } from "./packMode.logic";
import { packMeetsRequirements } from "./packMode.logic";

/**
 * Same "browse everything" limit the standalone `/packs` page already uses —
 * one constant for "how many packs is a full page", rather than the modal
 * inventing its own number.
 */
export { PACK_BROWSE_SEARCH_LIMIT as PACK_BROWSE_MODAL_LIMIT } from "../packBrowser/packBrowser.logic";

/** How long to wait after the last keystroke before asking the server again. */
export const PACK_BROWSE_MODAL_DEBOUNCE_MS = 250;

/**
 * The exact rule `packDirectory.searchPacks` already applies to a live
 * suggestion, extended to a whole grid: this is the actual filter behind
 * "Where to look" and the production-signal thresholds, not a second reading
 * of them.
 */
export function filterPacksForBrowse(
  packs: readonly Pack[],
  scope: PackScope,
  requirements: PackRequirements,
): readonly Pack[] {
  return packs.filter(
    (pack) =>
      (scope === "ecosystem" || pack.scope === "workspace") &&
      packMeetsRequirements(pack, requirements),
  );
}

/**
 * Verified (shipped-with-the-product) packs lead the grid, then the most
 * proven of what is left, then alphabetically — `selectSuggestedPack`'s
 * "most-proven wins" tie-break, extended from picking one pack to ordering
 * all of them.
 */
export function sortPacksForBrowse(packs: readonly Pack[]): readonly Pack[] {
  return packs.toSorted((left, right) => {
    const leftVerified = isVerifiedPackId(left.id);
    const rightVerified = isVerifiedPackId(right.id);
    if (leftVerified !== rightVerified) return leftVerified ? -1 : 1;

    if (left.signals.deployments !== right.signals.deployments) {
      return right.signals.deployments - left.signals.deployments;
    }

    return left.name.localeCompare(right.name);
  });
}

/**
 * The line above the grid. Distinct from `describePackResultCount` because
 * "matched a query" and "cleared a filter" are different reasons for a list to
 * be a given size, and a person adjusting a toggle should not read a message
 * written for typing into a search box.
 */
export function describeBrowseResultCount(count: number, query: string): string {
  const trimmed = query.trim();
  if (count === 0) {
    return trimmed.length === 0
      ? "No packs meet these filters yet."
      : `No packs match “${trimmed}”.`;
  }
  const noun = count === 1 ? "pack" : "packs";
  const verb = count === 1 ? "meets" : "meet";
  return trimmed.length === 0
    ? `${count} ${noun} ${verb} these filters`
    : `${count} ${noun} matching “${trimmed}”`;
}
