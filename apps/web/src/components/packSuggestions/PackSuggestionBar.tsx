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
import { BookOpenIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import type { PackRegistryEntry } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  onChangeSettings,
}: {
  readonly prompt: string;
  readonly packs: ReadonlyArray<PackRegistryEntry>;
  readonly onUsePack: (nextPrompt: string) => void;
  readonly onOpenPack?: (packId: string, packName: string) => void;
  /** Off means never render, however good the match. */
  readonly enabled?: boolean;
  readonly layout?: "inline" | "stacked";
  readonly onChangeSettings?: (next: { enabled?: boolean; layout?: "inline" | "stacked" }) => void;
}) {
  // Dismissal is per prompt text, not forever: waving away a suggestion for
  // one sentence should not silence it for the next thing you type.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Looking for a pack by hand, for when the prompt does not describe the work
  // — reading up on deploying before writing anything about it.
  const [query, setQuery] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const suggestable = useMemo(() => packs.map(toSuggestablePack), [packs]);

  const suggestions = useMemo<ReadonlyArray<PackSuggestion>>(() => {
    if (!enabled) return [];
    // A typed query wins over the prompt: somebody searching has said what
    // they want more plainly than anything inferred.
    if (query !== null && query.trim().length > 0) {
      return suggestPacks(query, suggestable, { limit: 5, minScore: 1 });
    }
    return suggestPacks(prompt, suggestable);
  }, [enabled, prompt, query, suggestable]);

  const searching = query !== null;
  const dismissed = dismissedFor === prompt.trim();
  if (!enabled) {
    return null;
  }
  if (suggestions.length === 0 && !searching && !settingsOpen) {
    return null;
  }
  if (dismissed && !searching && !settingsOpen) {
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
        {searching
          ? "Packs"
          : suggestions.length === 1
            ? "There's a pack for this"
            : "Packs for this"}
      </span>

      {searching ? (
        <Input
          autoFocus
          value={query ?? ""}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery(null);
          }}
          placeholder="Search packs…"
          className="h-6 w-40 text-xs"
          data-testid="pack-suggestion-search-input"
        />
      ) : null}

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
              onClick={() => onOpenPack(suggestion.pack.id, suggestion.pack.name)}
            >
              Look
            </Button>
          ) : null}
        </span>
      ))}

      {searching && suggestions.length === 0 ? (
        <span className="text-[11px] text-muted-foreground" data-testid="pack-suggestion-empty">
          No pack matches that.
        </span>
      ) : null}

      <span className="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={searching ? "Stop searching packs" : "Search packs"}
          data-testid="pack-suggestion-search"
          onClick={() => setQuery((current) => (current === null ? "" : null))}
        >
          <SearchIcon className="size-3" />
        </Button>

        {onChangeSettings ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Pack suggestion settings"
            data-testid="pack-suggestion-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SettingsIcon className="size-3" />
          </Button>
        ) : null}

        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Hide these suggestions"
          data-testid="pack-suggestion-dismiss"
          onClick={() => {
            setQuery(null);
            setSettingsOpen(false);
            setDismissedFor(prompt.trim());
          }}
        >
          <XIcon className="size-3" />
        </Button>
      </span>

      {settingsOpen && onChangeSettings ? (
        <div
          className="flex w-full items-center gap-3 border-t border-border/70 pt-1.5 text-[11px]"
          data-testid="pack-suggestion-settings-panel"
        >
          <Button
            size="xs"
            variant="outline"
            data-testid="pack-suggestion-toggle-off"
            onClick={() => onChangeSettings({ enabled: false })}
          >
            Turn suggestions off
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid="pack-suggestion-layout"
            onClick={() => onChangeSettings({ layout: layout === "inline" ? "stacked" : "inline" })}
          >
            {layout === "inline" ? "Stack them" : "Put them in a row"}
          </Button>
          <span className="text-muted-foreground">
            Turning them off hides this bar. The agent still looks packs up for itself.
          </span>
        </div>
      ) : null}
    </div>
  );
}
