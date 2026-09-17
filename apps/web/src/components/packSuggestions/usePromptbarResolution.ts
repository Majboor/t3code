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

import { resolvePromptbar, type PromptbarResolution } from "../../environments/primary/promptbar";

const PROMPTBAR_RESOLVE_DEBOUNCE_MS = 350;

export const promptbarQueryKeys = {
  resolve: (text: string, isFirstMessageInSession: boolean) =>
    ["promptbar", "resolve", text, isFirstMessageInSession] as const,
};

export function usePromptbarResolution(
  text: string,
  isFirstMessageInSession: boolean,
  enabled: boolean,
): PromptbarResolution | null {
  const trimmed = text.trim();
  const [debouncedText] = useDebouncedValue(trimmed, {
    wait: PROMPTBAR_RESOLVE_DEBOUNCE_MS,
  });

  const shouldFetch = enabled && debouncedText.length > 0;

  const query = useQuery({
    queryKey: promptbarQueryKeys.resolve(debouncedText, isFirstMessageInSession),
    queryFn: () => resolvePromptbar({ text: debouncedText, isFirstMessageInSession }),
    enabled: shouldFetch,
    staleTime: 10_000,
    retry: false,
  });

  if (!shouldFetch) {
    return null;
  }
  return query.data ?? null;
}
