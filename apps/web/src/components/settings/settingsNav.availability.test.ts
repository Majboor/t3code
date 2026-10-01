import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isSettingsSectionAvailable, SETTINGS_SECTION_PATHS } from "./settingsNav.logic";

describe("isSettingsSectionAvailable", () => {
  it("hides Billing only when we know this instance has no gateway", () => {
    expect(isSettingsSectionAvailable("/settings/billing", { billingAvailable: false })).toBe(
      false,
    );
    expect(isSettingsSectionAvailable("/settings/billing", { billingAvailable: true })).toBe(true);
  });

  // Same rule the nav already applies to unloaded preferences: an unknown
  // answer must not flash-hide a section somebody can already see.
  it("treats an unknown answer as visible", () => {
    expect(isSettingsSectionAvailable("/settings/billing", { billingAvailable: null })).toBe(true);
  });

  // The two the sidebar used to decide inline, which the breadcrumb therefore
  // knew nothing about: a section could be gone from the menu and still be
  // reachable by URL with its own title.
  it("owns the preference-gated sections too", () => {
    expect(
      isSettingsSectionAvailable("/settings/organization", { orgSettingsVisible: false }),
    ).toBe(false);
    expect(isSettingsSectionAvailable("/settings/api-usage", { apiUsageTabVisible: false })).toBe(
      false,
    );
    // Absent, not merely null: a caller that knows about only one of the three
    // must not hide the other two.
    expect(isSettingsSectionAvailable("/settings/organization", {})).toBe(true);
    expect(isSettingsSectionAvailable("/settings/api-usage", {})).toBe(true);
  });

  it("leaves every other section alone", () => {
    const allOff = {
      orgSettingsVisible: false,
      apiUsageTabVisible: false,
      billingAvailable: false,
    };
    const gated = new Set<string>([
      "/settings/billing",
      "/settings/organization",
      "/settings/api-usage",
    ]);
    for (const path of SETTINGS_SECTION_PATHS) {
      if (gated.has(path)) continue;
      expect(isSettingsSectionAvailable(path, allOff)).toBe(true);
    }
  });
});

// The rule existed, with these tests, and nothing called it: the Billing entry
// was still unconditional and the sidebar still decided the other two inline.
// Asserted on the source because the nav is a component with a router and a
// sidebar context around it, and what went wrong was the wiring, not the rule.
describe("the settings nav is wired to the rule", () => {
  const nav = readFileSync(path.join(import.meta.dirname, "SettingsSidebarNav.tsx"), "utf8");

  it("filters its items through isSettingsSectionAvailable", () => {
    expect(nav).toContain("isSettingsSectionAvailable(item.to, {");
  });

  it("asks the server whether this instance has a gateway", () => {
    expect(nav).toContain("useGatewayInstance()");
    expect(nav).toContain("billingAvailable");
  });

  it("no longer decides the preference-gated sections inline", () => {
    expect(nav).not.toContain('item.to === "/settings/organization"');
    expect(nav).not.toContain('item.to === "/settings/api-usage"');
  });
});
