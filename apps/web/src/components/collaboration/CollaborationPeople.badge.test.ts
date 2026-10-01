import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `readMemberBacking` existed with the tests above and nothing called it: the
 * sharing section listed the carriers as a group, and the roster row of the
 * person it was about said nothing. Asserted on the source because the roster
 * is a component inside a popover with a router and a live roster hook around
 * it, and what was missing was the wiring rather than the rule.
 */
describe("the roster is wired to the badge", () => {
  const people = readFileSync(path.join(import.meta.dirname, "CollaborationPeople.tsx"), "utf8");
  const panel = readFileSync(path.join(import.meta.dirname, "CollaborationPanel.tsx"), "utf8");

  it("asks for each member's backing by that member's id", () => {
    expect(people).toContain("readMemberBacking(sharingOverview, member.userId)");
  });

  it("renders the badge, and says so when the named account is unusable", () => {
    expect(people).toContain('data-testid="collaboration-member-backing"');
    expect(people).toContain("describeBacking(backing)");
    expect(people).toContain("Backing, unavailable");
  });

  // The overview is already in the panel, two lines from the roster it renders.
  it("hands the roster the overview the sharing section already reads", () => {
    expect(panel).toContain("<CollaborationPeople roster={roster} sharingOverview={overview} />");
  });

  // Badge-less rather than wrong: a caller with no overview must not render a
  // row that silently claims nobody is carrying anything.
  it("leaves the overview optional", () => {
    expect(people).toContain("sharingOverview?: ProviderSharingOverviewResult | null | undefined");
    expect(people).toContain("sharingOverview ? readMemberBacking(");
  });
});
