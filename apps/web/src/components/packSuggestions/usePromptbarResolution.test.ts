import { describe, expect, it } from "vitest";

import { promptbarQueryKeys, shouldResolvePromptbar } from "./usePromptbarResolution";

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

describe("shouldResolvePromptbar", () => {
  it("resolves when the bar is enabled, Pack mode is on, and nobody is hand-searching", () => {
    expect(
      shouldResolvePromptbar({ barEnabled: true, packModeEnabled: true, searching: false }),
    ).toBe(true);
  });

  it("never resolves when Pack mode is off, even though the bar itself is enabled", () => {
    expect(
      shouldResolvePromptbar({ barEnabled: true, packModeEnabled: false, searching: false }),
    ).toBe(false);
  });

  it("never resolves when the bar itself is disabled, even though Pack mode is on", () => {
    expect(
      shouldResolvePromptbar({ barEnabled: false, packModeEnabled: true, searching: false }),
    ).toBe(false);
  });

  it("pauses while hand-searching, independently of Pack mode", () => {
    expect(
      shouldResolvePromptbar({ barEnabled: true, packModeEnabled: true, searching: true }),
    ).toBe(false);
    expect(
      shouldResolvePromptbar({ barEnabled: true, packModeEnabled: false, searching: true }),
    ).toBe(false);
  });
});
