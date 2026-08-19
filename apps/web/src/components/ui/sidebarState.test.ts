import { describe, expect, it } from "vitest";

import { resolveSidebarState } from "./sidebarState";

describe("resolveSidebarState", () => {
  it("reads the desktop open flag on a desktop viewport", () => {
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
    expect(resolveSidebarState({ isMobile: false, open: false, openMobile: true })).toBe(
      "collapsed",
    );
  });

  it("reads the sheet flag on a mobile viewport", () => {
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
  });
});
