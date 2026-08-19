import { describe, expect, it } from "vitest";

import {
  isSettingsSectionActive,
  SETTINGS_SECTION_PATHS,
  settingsSectionLabel,
} from "./settingsNav.logic";

describe("settingsSectionLabel", () => {
  it("labels every section the nav offers", () => {
    for (const path of SETTINGS_SECTION_PATHS) {
      expect(settingsSectionLabel(path)).toBeTruthy();
    }
  });

  it("ignores a trailing slash", () => {
    expect(settingsSectionLabel("/settings/connections/")).toBe("Connections");
  });

  it("returns null for the settings root rather than inventing a section", () => {
    expect(settingsSectionLabel("/settings")).toBeNull();
    expect(settingsSectionLabel("/settings/does-not-exist")).toBeNull();
  });
});

describe("isSettingsSectionActive", () => {
  it("matches the section itself", () => {
    expect(isSettingsSectionActive("/settings/general", "/settings/general")).toBe(true);
  });

  it("matches a sub-path of the section", () => {
    expect(isSettingsSectionActive("/settings/connections/github", "/settings/connections")).toBe(
      true,
    );
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(isSettingsSectionActive("/settings/general-purpose", "/settings/general")).toBe(false);
  });
});
