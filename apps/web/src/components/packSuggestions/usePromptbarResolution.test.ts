import { describe, expect, it } from "vitest";

import { promptbarQueryKeys } from "./usePromptbarResolution";

// The hook itself is a thin `useDebouncedValue` + `useQuery` wrapper around
// `resolvePromptbar` (see `usePackSuggestionSettings.test.ts` for the same
// choice: this codebase's convention is to unit-test a hook's exported pure
// surface rather than mount it, since mounting would mean pulling in a React
// renderer + fake timers + a mocked fetch just to prove `useDebouncedValue`
// and `useQuery` — both already tested upstream — were plumbed together.
// The debounce/fetch wiring itself needs the real backend to verify end to
// end.
describe("promptbarQueryKeys.resolve", () => {
  it("keys on both the text and isFirstMessageInSession, so the two never share a cache entry", () => {
    const first = promptbarQueryKeys.resolve("deploy this", true);
    const second = promptbarQueryKeys.resolve("deploy this", false);
    expect(first).not.toEqual(second);
  });

  it("is stable for the same inputs, so React Query can dedupe repeats", () => {
    expect(promptbarQueryKeys.resolve("deploy this", true)).toEqual(
      promptbarQueryKeys.resolve("deploy this", true),
    );
  });
});
