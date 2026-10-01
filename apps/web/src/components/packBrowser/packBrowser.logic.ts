/**
 * Pure helpers for the pack marketplace page — the "browse everything the
 * registry will show me" surface, as opposed to the per-pack detail page or
 * the composer's typing-time suggestions.
 *
 * Kept free of React and of the transport so that what counts as "no query",
 * what a result count reads as, and how a card's tags are trimmed can be
 * tested without a server or a browser.
 */
import type { PackRegistryEntry } from "@t3tools/contracts";

/** How long to wait after the last keystroke before asking the server again. */
export const PACK_SEARCH_DEBOUNCE_MS = 250;

/** Cards shown before "show more" — a registry can hold more than a page wants at once. */
export const PACK_BROWSE_SEARCH_LIMIT = 60;

/**
 * What the registry's `query` means by "no filter": undefined, not an empty
 * string. Sending `""` is a different request than sending nothing, and
 * whitespace typed and deleted should not count as a search at all.
 */
export function normalizePackSearchQuery(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The line above the results. Plural rules and the "nothing matched" case are
 * exactly the kind of thing that reads fine until the count is 1 or 0, so it
 * is written once here rather than in the JSX of the page.
 */
export function describePackResultCount(count: number, query: string | undefined): string {
  if (count === 0) {
    return query === undefined ? "No packs yet." : `No packs match “${query}”.`;
  }
  const noun = count === 1 ? "pack" : "packs";
  return query === undefined ? `${count} ${noun}` : `${count} ${noun} matching “${query}”`;
}

/**
 * Tags beyond this are folded into a "+N" badge rather than pushed onto the
 * card forever — a pack that lists twelve tags should not make its card three
 * times the height of every other one in the grid.
 */
const MAX_VISIBLE_TAGS = 4;

export interface PackCardTags {
  readonly visible: ReadonlyArray<string>;
  readonly overflow: number;
}

export function splitPackCardTags(tags: ReadonlyArray<string>): PackCardTags {
  if (tags.length <= MAX_VISIBLE_TAGS) {
    return { visible: tags, overflow: 0 };
  }
  return { visible: tags.slice(0, MAX_VISIBLE_TAGS), overflow: tags.length - MAX_VISIBLE_TAGS };
}

/**
 * Whether two searches are "the same request" for the purpose of skipping a
 * refetch — normalized and case-insensitive, since the registry's own match
 * is not case-sensitive either.
 */
export function samePackSearchQuery(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "").toLowerCase() === (right ?? "").toLowerCase();
}

/** A stable sort for display: by name, so a re-fetch does not reshuffle the grid under someone reading it. */
export function sortPackResultsByName<
  Entry extends Pick<PackRegistryEntry, "displayName" | "name">,
>(packs: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return packs.toSorted((left, right) =>
    (left.displayName || left.name).localeCompare(right.displayName || right.name),
  );
}
