/**
 * Real-browser check for the "popup over a popup" interaction: opening the
 * small pack-mode settings popover, then expanding it into the larger browse
 * modal without the popover disappearing underneath.
 *
 * `useQuery` is mocked rather than given a `QueryClientProvider` — the same
 * choice `GitActionsControl.browser.tsx` makes — because what this test is
 * checking is the layering of two overlays, not the registry round trip
 * `packDirectory.browsePacks` already has its own logic tests for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], error: null, isPending: false })),
  };
});

import { PackModeControl } from "./PackModeControl";

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

describe("PackModeControl → Browse all packs", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("opens the browse modal on top of the still-open pack-mode popover", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <PackModeControl prompt="" onInsertPrompt={() => undefined} />,
      { container: host },
    );

    try {
      // Open the small popover.
      const trigger = byTestId("pack-mode-trigger");
      expect(trigger, "pack-mode-trigger should render").toBeTruthy();
      (trigger as HTMLElement).click();

      await expect
        .poll(() => byTestId("pack-mode-browse-all"))
        .toBeTruthy();

      // The popover's own filter row should be visible before anything else opens.
      expect(byTestId("pack-mode-scope")).toBeTruthy();

      // Expand into the larger modal.
      (byTestId("pack-mode-browse-all") as HTMLElement).click();

      await expect.poll(() => byTestId("pack-browse-modal")).toBeTruthy();

      // The modal renders its own search box and the same three filter rows,
      // now as the actual UI for pack-mode's settings.
      expect(byTestId("pack-browse-modal-search-input")).toBeTruthy();
      expect(byTestId("pack-browse-modal-scope")).toBeTruthy();
      expect(byTestId("pack-browse-modal-min-deployments")).toBeTruthy();
      expect(byTestId("pack-browse-modal-min-time-in-service")).toBeTruthy();
      expect(byTestId("pack-browse-modal-author-only-switch")).toBeTruthy();

      // With a mocked empty result set, the modal's own empty state renders
      // instead of a card grid — proving the query wiring without needing a
      // router context for the cards' `Link`.
      expect(byTestId("pack-browse-modal-empty")).toBeTruthy();

      // The core "cool effect" claim: the small popover is still in the DOM,
      // dimmed behind the larger modal's own backdrop, rather than having
      // been closed when the modal opened — the same layering
      // `ShareProjectButton`'s popover + confirm dialog already uses.
      expect(byTestId("pack-mode-scope"), "the small popover should still be mounted").toBeTruthy();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
