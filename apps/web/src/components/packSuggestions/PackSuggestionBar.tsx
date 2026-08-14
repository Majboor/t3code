/**
 * Packs worth knowing about, offered above the prompt bar as you type.
 *
 * The agent looks packs up for itself, and after the instruction was sharpened
 * it did so in every measured run — but it still sometimes read a pack and
 * went ahead anyway, and nobody watching could tell. This surface is for the
 * person: before you send, it says "there is recorded knowledge about this",
 * and one click puts that instruction in your prompt.
 *
 * It never changes the prompt on its own. A bar that quietly edited what you
 * typed would be worse than no bar, and the entire point is that you can see
 * what was added.
 */
import { BookOpenIcon, XIcon } from "lucide-react";
import type { PackRegistryEntry } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import {
  suggestPacks,
  withPackMention,
  type PackSuggestion,
  type SuggestablePack,
} from "./matchPrompt.logic";

/**
 * A registry entry, reduced to what matching needs.
 *
 * Tags and the capability summary both count as things the pack says about
 * itself, so they feed the capability list rather than the prose one.
 */
export function toSuggestablePack(entry: PackRegistryEntry): SuggestablePack {
  return {
    id: entry.packId,
    name: entry.name,
    qualified: `${entry.publisherHandle}/${entry.name}@${entry.latestVersion}`,
    summary: `${entry.displayName} ${entry.summary}`,
    capabilities: [...entry.tags, ...entry.capabilitySummary.toLowerCase().split(/[^a-z]+/)].filter(
      (word) => word.length > 2,
    ),
  };
}

export function PackSuggestionBar({
  prompt,
  packs,
  onUsePack,
  onOpenPack,
  enabled = true,
  layout = "inline",
}: {
  readonly prompt: string;
  readonly packs: ReadonlyArray<PackRegistryEntry>;
  readonly onUsePack: (nextPrompt: string) => void;
  readonly onOpenPack?: (packId: string) => void;
  /** Off means never render, however good the match. */
  readonly enabled?: boolean;
  readonly layout?: "inline" | "stacked";
}) {
  // Dismissal is per prompt text, not forever: waving away a suggestion for
  // one sentence should not silence it for the next thing you type.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const suggestions = useMemo<ReadonlyArray<PackSuggestion>>(
    () => (enabled ? suggestPacks(prompt, packs.map(toSuggestablePack)) : []),
    [enabled, prompt, packs],
  );

  if (suggestions.length === 0 || dismissedFor === prompt.trim()) {
    return null;
  }

  return (
    <div
      className={cn(
        "mb-1.5 flex gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1.5",
        layout === "stacked" ? "flex-col items-start" : "flex-wrap items-center",
      )}
      data-testid="pack-suggestion-bar"
    >
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <BookOpenIcon className="size-3" />
        {suggestions.length === 1 ? "There's a pack for this" : "Packs for this"}
      </span>

      {suggestions.map((suggestion) => (
        <span key={suggestion.pack.id} className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            data-testid="pack-suggestion-use"
            data-pack={suggestion.pack.name}
            title={suggestion.pack.summary}
            onClick={() => onUsePack(withPackMention(prompt, suggestion.pack))}
          >
            {suggestion.pack.name}
          </Button>
          {onOpenPack ? (
            <Button
              size="xs"
              variant="ghost"
              data-testid="pack-suggestion-open"
              aria-label={`Look at the ${suggestion.pack.name} pack`}
              onClick={() => onOpenPack(suggestion.pack.id)}
            >
              Look
            </Button>
          ) : null}
        </span>
      ))}

      <Button
        size="icon-xs"
        variant="ghost"
        className="ml-auto"
        aria-label="Hide these suggestions"
        data-testid="pack-suggestion-dismiss"
        onClick={() => setDismissedFor(prompt.trim())}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
