import { describe, expect, it } from "vitest";

import { resolveSidebarUtilityPage } from "./sidebarChrome.logic";

describe("resolveSidebarUtilityPage", () => {
  it("marks the settings surface, including its sections", () => {
    expect(resolveSidebarUtilityPage("/settings")).toBe("settings");
    expect(resolveSidebarUtilityPage("/settings/connections")).toBe("settings");
    expect(resolveSidebarUtilityPage("/settings/")).toBe("settings");
  });

  it("marks the environments surface", () => {
    expect(resolveSidebarUtilityPage("/environments")).toBe("environments");
  });

  it("reports the workspace as no utility page rather than guessing one", () => {
    expect(resolveSidebarUtilityPage("/")).toBeNull();
    expect(resolveSidebarUtilityPage("/env/thread")).toBeNull();
    expect(resolveSidebarUtilityPage("/settings-export")).toBeNull();
    expect(resolveSidebarUtilityPage("/environmentsomething")).toBeNull();
  });
});
