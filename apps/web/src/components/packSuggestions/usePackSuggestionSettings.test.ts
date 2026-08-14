import { describe, expect, it } from "vitest";

import { DEFAULT_PACK_SUGGESTION_SETTINGS, parseSettings } from "./usePackSuggestionSettings";

describe("parseSettings", () => {
  it("defaults to on, because somebody who has never seen a pack cannot choose", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_PACK_SUGGESTION_SETTINGS);
    expect(DEFAULT_PACK_SUGGESTION_SETTINGS.enabled).toBe(true);
  });

  it("remembers being turned off", () => {
    expect(parseSettings(JSON.stringify({ enabled: false, layout: "inline" })).enabled).toBe(false);
  });

  it("remembers the layout", () => {
    expect(parseSettings(JSON.stringify({ enabled: true, layout: "stacked" })).layout).toBe(
      "stacked",
    );
  });

  it("falls back rather than throwing on a value it cannot read", () => {
    // A bad key in localStorage must not be able to stop the composer
    // rendering, which is what an unguarded JSON.parse would do.
    expect(parseSettings("{not json")).toEqual(DEFAULT_PACK_SUGGESTION_SETTINGS);
  });

  it("ignores a layout it does not recognise instead of using it", () => {
    expect(parseSettings(JSON.stringify({ layout: "diagonal" })).layout).toBe("inline");
  });

  it("treats a missing enabled flag as on, not as off", () => {
    // The difference matters: reading absence as false would silently turn the
    // bar off for anybody whose stored value predates the flag.
    expect(parseSettings(JSON.stringify({ layout: "inline" })).enabled).toBe(true);
  });
});
