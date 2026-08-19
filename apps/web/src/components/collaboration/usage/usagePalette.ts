import { cn } from "../../../lib/utils";

/**
 * The chart palette shared by everything that draws collaboration data, kept
 * local because the app has no chart ramp of its own yet. Slots come from a
 * validated categorical set: blue and orange clear the colourblind separation
 * gates in both modes, and the unattributed slice takes a neutral grey on
 * purpose — it is the absence of an identity, not a third one.
 *
 * It is a class rather than a theme token so any subtree can opt in by wearing
 * it, which is how the collaboration popover's previews get the same ramp as
 * the full usage panel without either one importing the other's layout.
 */
export const USAGE_PALETTE = cn(
  "[--usage-accent:#2a78d6] [--usage-accent-soft:#86b6ef] [--usage-codex:#2a78d6]",
  "[--usage-claude:#eb6834] [--usage-unrecorded:#8a8983] [--usage-grid:#e5e4df]",
  "dark:[--usage-accent:#3987e5] dark:[--usage-accent-soft:#184f95] dark:[--usage-codex:#3987e5]",
  "dark:[--usage-claude:#d95926] dark:[--usage-unrecorded:#7d7c76] dark:[--usage-grid:#33322f]",
);
