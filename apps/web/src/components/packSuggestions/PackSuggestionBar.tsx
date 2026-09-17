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
 *
 * The main-prompt suggestions come from the backend hybrid retrieval pipeline
 * (`POST /api/promptbar/resolve`, via `usePromptbarResolution`), debounced as
 * you type. The hand-search box (`query`) is a different, deliberate flow —
 * "look up a pack by hand" — and keeps using the local, static
 * `suggestPacks` heuristic against whatever packs are already enabled, since
 * the resolve endpoint isn't for that.
 *
 * Zone-aware rendering follows the spec verbatim: `attach` (confidence
 * >= 0.60) shows plainly; `suggest` (0.35-0.60) shows dimmed with a "Tab to
 * accept" hint, and Tab accepts it exactly like clicking "Use"; `silent`
 * (< 0.35) and any non-ACTION intent (QUESTION/STATEMENT/CONTINUATION) show
 * nothing. A resolve failure or an endpoint that isn't live yet also shows
 * nothing — never a broken composer.
 */
import { BookOpenIcon, SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import type { PackRegistryEntry } from "@t3tools/contracts";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { sendPromptbarTelemetry } from "../../environments/primary/promptbar";
import {
  suggestPacks,
  withPackMention,
  type PackSuggestion,
  type SuggestablePack,
} from "./matchPrompt.logic";
import {
  candidateToSuggestablePack,
  deriveZoneDecision,
  isAbstained,
  resolveTabAcceptCandidate,
} from "./promptbarZone.logic";
import { usePromptbarResolution } from "./usePromptbarResolution";

/**
 * A registry entry, reduced to what matching needs.
 *
 * Only tags count as declared capabilities. Splitting the capability summary
 * into words and treating each as one was a mistake with real consequences:
 * every word of "Renders a PDF from code, serves it over HTTP" — including
 * "code", "from" and "over" — scored as highly as a tag, so "Create a file
 * named x" offered the PDF pack. It surfaced as six unrelated collaboration
 * checks failing, because a bar that should not have been there changed the
 * layout under them.
 *
 * The summary still counts, as prose, which is worth a point rather than
 * three.
 */
export function toSuggestablePack(entry: PackRegistryEntry): SuggestablePack {
  return {
    id: entry.packId,
    name: entry.name,
    qualified: `${entry.publisherHandle}/${entry.name}@${entry.latestVersion}`,
    summary: `${entry.displayName} ${entry.summary} ${entry.capabilitySummary}`,
    capabilities: entry.tags.filter((tag) => tag.length > 2),
  };
}

/** Imperative surface for the composer's own Tab handling — see `resolveTabAcceptCandidate`. */
export interface PackSuggestionBarHandle {
  /**
   * Called when the composer editor receives Tab. Returns `true` (and
   * behaves exactly like clicking "Use") when a `suggest`-zone candidate was
   * showing and worth accepting; `false` means Tab has nothing to do here and
   * the composer should fall through to its normal Tab handling.
   */
  readonly acceptTabSuggestion: () => boolean;
}

export const PackSuggestionBar = forwardRef<
  PackSuggestionBarHandle,
  {
    readonly prompt: string;
    readonly packs: ReadonlyArray<PackRegistryEntry>;
    readonly onUsePack: (nextPrompt: string) => void;
    readonly onOpenPack?: (packId: string, packName: string) => void;
    /** Off means never render, however good the match. */
    readonly enabled?: boolean;
    readonly layout?: "inline" | "stacked";
    readonly onChangeSettings?: (next: { enabled?: boolean; layout?: "inline" | "stacked" }) => void;
    /**
     * Whether this is the first message of the current thread/session.
     * Passed through verbatim to `POST /api/promptbar/resolve` on every call
     * — the classifier has no session memory, so this is the only place that
     * knows.
     */
    readonly isFirstMessageInSession: boolean;
  }
>(function PackSuggestionBar(
  {
    prompt,
    packs,
    onUsePack,
    onOpenPack,
    enabled = true,
    layout = "inline",
    onChangeSettings,
    isFirstMessageInSession,
  },
  ref,
) {
  // Dismissal is per prompt text, not forever: waving away a suggestion for
  // one sentence should not silence it for the next thing you type.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // Looking for a pack by hand, for when the prompt does not describe the work
  // — reading up on deploying before writing anything about it.
  const [query, setQuery] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const suggestable = useMemo(() => packs.map(toSuggestablePack), [packs]);
  const searching = query !== null;
  const dismissed = dismissedFor === prompt.trim();

  // The main-prompt path: a debounced call to the backend hybrid retrieval
  // pipeline. Disabled while hand-searching, since that flow does not touch
  // the prompt at all and the resolution would go unused.
  const resolution = usePromptbarResolution(prompt, isFirstMessageInSession, enabled && !searching);

  const localSuggestions = useMemo<ReadonlyArray<PackSuggestion>>(() => {
    if (!enabled || query === null || query.trim().length === 0) return [];
    return suggestPacks(query, suggestable, { limit: 5, minScore: 1 });
  }, [enabled, query, suggestable]);

  // Only ACTION intent with a non-silent zone and real candidates produces
  // anything to show — see `deriveZoneDecision` for the full rule table.
  const zoneDecision = useMemo(() => deriveZoneDecision(resolution), [resolution]);

  const backendSuggestions = useMemo<ReadonlyArray<PackSuggestion>>(() => {
    if (!zoneDecision) return [];
    return zoneDecision.candidates.map((candidate) => ({
      pack: candidateToSuggestablePack(candidate, suggestable),
      score: candidate.retrievalScore,
      matched: [],
    }));
  }, [zoneDecision, suggestable]);

  const suggestions = searching ? localSuggestions : backendSuggestions;
  const showTabHint = !searching && zoneDecision?.zone === "suggest";

  // "Abstained": the resolve call came back ACTION but nothing good enough
  // survived to show. Fired once per distinct resolution, not once per
  // render — the eval harness wants one row per outcome.
  const lastAbstainedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (searching || !resolution || !isAbstained(resolution)) return;
    const signature = `${prompt.trim()}::${resolution.intent}::${resolution.zone}`;
    if (lastAbstainedSignatureRef.current === signature) return;
    lastAbstainedSignatureRef.current = signature;
    void sendPromptbarTelemetry({ event: "abstained", query: prompt.trim() });
  }, [resolution, searching, prompt]);

  useImperativeHandle(
    ref,
    () => ({
      acceptTabSuggestion: () => {
        const candidate = resolveTabAcceptCandidate({ resolution, searching, dismissed });
        if (!candidate) return false;
        void sendPromptbarTelemetry({
          event: "accepted",
          packId: candidate.packId,
          query: prompt.trim(),
        });
        onUsePack(withPackMention(prompt, candidateToSuggestablePack(candidate, suggestable)));
        return true;
      },
    }),
    [resolution, searching, dismissed, prompt, onUsePack, suggestable],
  );

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
        {showTabHint ? (
          <span
            className="italic text-muted-foreground/80"
            data-testid="pack-suggestion-tab-hint"
          >
            — Tab to accept
          </span>
        ) : null}
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
            className={showTabHint ? "border-dashed opacity-70" : undefined}
            data-testid="pack-suggestion-use"
            data-pack={suggestion.pack.name}
            data-zone={searching ? undefined : (zoneDecision?.zone ?? undefined)}
            title={suggestion.pack.summary}
            onClick={() => {
              if (!searching) {
                void sendPromptbarTelemetry({
                  event: "accepted",
                  packId: suggestion.pack.id,
                  query: prompt.trim(),
                });
              }
              onUsePack(withPackMention(prompt, suggestion.pack));
            }}
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
            if (!searching && zoneDecision) {
              const topPackId = zoneDecision.candidates[0]?.packId;
              void sendPromptbarTelemetry({
                event: "dismissed",
                ...(topPackId !== undefined ? { packId: topPackId } : {}),
                query: prompt.trim(),
              });
            }
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
});
