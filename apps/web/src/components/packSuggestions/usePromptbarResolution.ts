/**
 * Debounced live resolution of the main prompt against the backend hybrid
 * retrieval pipeline (`POST /api/promptbar/resolve`).
 *
 * Debounced with the same `@tanstack/react-pacer` + `@tanstack/react-query`
 * combination `ChatComposer.tsx` already uses for the path-trigger lookup
 * (`debouncedPathQuery`/`workspaceEntriesQuery`), rather than a bespoke
 * `setTimeout`.
 *
 * The backend endpoint may not exist yet, may 404/500, or the network may be
 * down — none of that is this hook's problem to surface. `retry: false` and
 * a `null` fallback on any non-success state means a broken or not-yet-live
 * promptbar renders nothing rather than an error, the same "courtesy, not a
 * gate" pattern as onboarding.
 */
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";

import {
  resolvePromptbar,
  type PromptbarRecentContextEntry,
  type PromptbarResolution,
} from "../../environments/primary/promptbar";

const PROMPTBAR_RESOLVE_DEBOUNCE_MS = 350;

export const promptbarQueryKeys = {
  resolve: (text: string, isFirstMessageInSession: boolean) =>
    ["promptbar", "resolve", text, isFirstMessageInSession] as const,
};

/**
 * Whether the automatic, debounced resolve call should run at all.
 *
 * Pack mode (`packMode.logic.ts`'s `enabled`) is the master switch for this:
 * off means the bar must not fetch or show anything, however good a match
 * would have been — the same "off means never render" rule the bar's own
 * `enabled` prop already follows. The hand-search box is a separate,
 * deliberate action and is never gated by Pack mode; `searching` is here only
 * so the automatic fetch pauses while that box is in use, which is a UX
 * choice unrelated to whether Pack mode itself is on.
 */
export function shouldResolvePromptbar(input: {
  readonly barEnabled: boolean;
  readonly packModeEnabled: boolean;
  readonly searching: boolean;
}): boolean {
  return input.barEnabled && input.packModeEnabled && !input.searching;
}

export function usePromptbarResolution(
  text: string,
  isFirstMessageInSession: boolean,
  enabled: boolean,
  recentContext?: ReadonlyArray<PromptbarRecentContextEntry>,
): PromptbarResolution | null {
  const trimmed = text.trim();
  const [debouncedText] = useDebouncedValue(trimmed, {
    wait: PROMPTBAR_RESOLVE_DEBOUNCE_MS,
  });

  const shouldFetch = enabled && debouncedText.length > 0;

  const query = useQuery({
    // recentContext deliberately isn't part of the key: it's supplementary
    // context for the stage-3 decision model, not part of what's being
    // resolved, so a new array reference each render shouldn't force a
    // refetch of an otherwise-identical query.
    queryKey: promptbarQueryKeys.resolve(debouncedText, isFirstMessageInSession),
    queryFn: () =>
      resolvePromptbar({
        text: debouncedText,
        isFirstMessageInSession,
        ...(recentContext && recentContext.length > 0 ? { recentContext } : {}),
      }),
    enabled: shouldFetch,
    staleTime: 10_000,
    retry: false,
  });

  if (!shouldFetch) {
    return null;
  }
  return query.data ?? null;
}
