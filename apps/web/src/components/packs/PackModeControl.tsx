import { useDebouncedValue } from "@tanstack/react-pacer";
import { ChevronDownIcon, PackageIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { packDirectory } from "./packDirectory";
import type { Pack } from "./packMode.logic";
import {
  PACK_DEPLOYMENT_OPTIONS,
  PACK_SCOPE_OPTIONS,
  PACK_TIME_IN_SERVICE_OPTIONS,
  appendPackInstructionToPrompt,
  buildPackIntegrationInstruction,
  selectSuggestedPack,
  usePackModeSettings,
} from "./packMode.logic";
import { PackSuggestionCard } from "./PackSuggestionCard";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

const PACK_QUERY_DEBOUNCE_MS = 400;
/** Below this a draft is still a fragment, and anything matched is a coincidence. */
const PACK_QUERY_MIN_LENGTH = 12;

function OptionRow<T extends number | string>({
  label,
  options,
  value,
  testId,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ readonly value: T; readonly label: string; readonly hint: string }>;
  value: T;
  testId: string;
  onChange: (next: T) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-muted-foreground">{label}</div>
      {/* Single-choice, so the group owns the selection: clicking the pressed
          option must not clear it, which is why an empty change is ignored. */}
      <ToggleGroup
        className="grid w-full grid-cols-3"
        data-testid={testId}
        onValueChange={(next) => {
          const [selected] = next;
          const option = options.find((candidate) => String(candidate.value) === selected);
          if (option && option.value !== value) {
            onChange(option.value);
          }
        }}
        value={[String(value)]}
        variant="segmented"
      >
        {options.map((option) => (
          <ToggleGroupItem
            className="px-2 text-[11px]"
            key={String(option.value)}
            title={option.hint}
            value={String(option.value)}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * Pack mode: the agent may look through the pack ecosystem for something
 * already proven before it writes a capability from scratch.
 *
 * The settings are the production signals themselves, not a verified tier — a
 * tier is coarser than the decision, and the person setting it is the one who
 * knows whether twelve deployments is enough for what they are building.
 */
export function PackModeControl({
  compact = false,
  prompt,
  onInsertPrompt,
}: {
  compact?: boolean;
  prompt: string;
  onInsertPrompt: (nextPrompt: string) => void;
}) {
  const [settings, setSettings] = usePackModeSettings();
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly Pack[]>([]);
  // Dismissals are about the task in front of the person, not a standing
  // preference, so they die with the session rather than being persisted.
  const [dismissedPackIds, setDismissedPackIds] = useState<readonly string[]>([]);
  const [debouncedPrompt] = useDebouncedValue(prompt, { wait: PACK_QUERY_DEBOUNCE_MS });

  const { enabled, scope, requirements } = settings;

  useEffect(() => {
    const query = debouncedPrompt.trim();
    if (!enabled || query.length < PACK_QUERY_MIN_LENGTH) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    packDirectory
      .searchPacks({ query, scope, requirements })
      .then((packs) => {
        if (!cancelled) setSuggestions(packs);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSuggestions([]);
        toastManager.add({
          type: "error",
          title: "Could not search for packs",
          description: error instanceof Error ? error.message : "The request failed.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedPrompt, enabled, scope, requirements]);

  const suggestion = selectSuggestedPack(suggestions, dismissedPackIds);

  const integrate = (pack: Pack) => {
    onInsertPrompt(appendPackInstructionToPrompt(prompt, buildPackIntegrationInstruction(pack)));
    // The pack is in the draft now; suggesting it again would be noise.
    setDismissedPackIds((previous) => [...previous, pack.id]);
    setIsOpen(false);
  };

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "shrink-0 whitespace-nowrap px-2 sm:px-3",
                enabled
                  ? "text-foreground/80"
                  : "text-muted-foreground/70 hover:text-foreground/80",
              )}
              data-testid="pack-mode-trigger"
              data-pack-mode-enabled={enabled ? "true" : "false"}
              title={
                enabled
                  ? "Pack mode on — the agent may suggest a proven pack instead of building it"
                  : "Pack mode off — click to let the agent look for a proven pack"
              }
            />
          }
        >
          <span className="flex items-center gap-1.5">
            <PackageIcon />
            {compact ? null : <span className="sr-only sm:not-sr-only">Packs</span>}
            {suggestion ? (
              <span
                aria-label="A pack matches this"
                className="size-1.5 shrink-0 rounded-full bg-primary"
                data-testid="pack-mode-suggestion-indicator"
              />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
            )}
          </span>
        </PopoverTrigger>

        <PopoverPopup align="start" side="top" className="w-88">
          <div className="grid gap-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium">Pack mode</div>
                <div className="text-[11px] leading-4 text-muted-foreground">
                  The agent looks for a capability that already works in production before writing
                  one. You can ask it for a pack at any time too.
                </div>
              </div>
              <Switch
                checked={enabled}
                aria-label="Toggle pack mode"
                data-testid="pack-mode-switch"
                onCheckedChange={(checked) => {
                  setSettings((previous) => ({ ...previous, enabled: checked }));
                }}
              />
            </div>

            {suggestion ? (
              <div className="border-t border-border pt-3">
                <div className="mb-2 text-[11px] font-medium text-muted-foreground">
                  There is a pack for this
                </div>
                <PackSuggestionCard
                  pack={suggestion}
                  onIntegrate={() => integrate(suggestion)}
                  onDismiss={() => {
                    setDismissedPackIds((previous) => [...previous, suggestion.id]);
                  }}
                />
              </div>
            ) : null}

            <div className="grid gap-3 border-t border-border pt-3">
              <OptionRow
                label="Where to look"
                options={PACK_SCOPE_OPTIONS}
                value={scope}
                testId="pack-mode-scope"
                onChange={(next) => {
                  setSettings((previous) => ({ ...previous, scope: next }));
                }}
              />

              <OptionRow
                label="Only suggest a pack running in at least"
                options={PACK_DEPLOYMENT_OPTIONS}
                value={requirements.minDeployments}
                testId="pack-mode-min-deployments"
                onChange={(next) => {
                  setSettings((previous) => ({
                    ...previous,
                    requirements: { ...previous.requirements, minDeployments: next },
                  }));
                }}
              />

              <OptionRow
                label="…and running for at least"
                options={PACK_TIME_IN_SERVICE_OPTIONS}
                value={requirements.minMonthsInService}
                testId="pack-mode-min-time-in-service"
                onChange={(next) => {
                  setSettings((previous) => ({
                    ...previous,
                    requirements: { ...previous.requirements, minMonthsInService: next },
                  }));
                }}
              />

              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 text-[11px] leading-4 text-muted-foreground">
                  Include packs nobody outside the author has run
                </div>
                <Switch
                  checked={requirements.includeAuthorOnly}
                  aria-label="Include packs nobody outside the author has run"
                  data-testid="pack-mode-author-only-switch"
                  onCheckedChange={(checked) => {
                    setSettings((previous) => ({
                      ...previous,
                      requirements: { ...previous.requirements, includeAuthorOnly: checked },
                    }));
                  }}
                />
              </div>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}
