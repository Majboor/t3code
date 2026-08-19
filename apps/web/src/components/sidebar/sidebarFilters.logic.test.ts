import { describe, expect, it } from "vitest";

import {
  countActiveSidebarFilters,
  describeActiveSidebarFilters,
  isTextEntryElement,
  shouldFocusSidebarSearchShortcut,
} from "./sidebarFilters.logic";

const BARE_SLASH = {
  key: "/",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  targetIsTextEntry: false,
  targetIsInsideOverlay: false,
};

describe("shouldFocusSidebarSearchShortcut", () => {
  it("takes a bare slash", () => {
    expect(shouldFocusSidebarSearchShortcut(BARE_SLASH)).toBe(true);
  });

  it("ignores other keys and modified slashes", () => {
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, key: "k" })).toBe(false);
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, metaKey: true })).toBe(false);
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, ctrlKey: true })).toBe(false);
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, altKey: true })).toBe(false);
  });

  it("leaves the slash alone while typing", () => {
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, targetIsTextEntry: true })).toBe(
      false,
    );
  });

  it("does not pull focus out of a dialog or popup", () => {
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, targetIsInsideOverlay: true })).toBe(
      false,
    );
  });

  it("respects an already-handled event", () => {
    expect(shouldFocusSidebarSearchShortcut({ ...BARE_SLASH, defaultPrevented: true })).toBe(false);
  });
});

describe("isTextEntryElement", () => {
  it("recognises the elements that own their own keystrokes", () => {
    expect(isTextEntryElement({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(isTextEntryElement({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isTextEntryElement({ tagName: "SELECT", isContentEditable: false })).toBe(true);
    expect(isTextEntryElement({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntryElement({ tagName: "DIV", isContentEditable: false })).toBe(false);
  });
});

const NO_FILTERS = {
  searchQuery: "",
  threadStatusFilter: "all",
  projectSourceFilter: "all",
  ownerFilter: "all",
};

describe("countActiveSidebarFilters", () => {
  it("counts nothing when every control is at its default", () => {
    expect(countActiveSidebarFilters(NO_FILTERS)).toBe(0);
  });

  it("does not count whitespace as a search", () => {
    expect(countActiveSidebarFilters({ ...NO_FILTERS, searchQuery: "   " })).toBe(0);
  });

  it("counts each narrowing control once", () => {
    expect(
      countActiveSidebarFilters({
        searchQuery: "api",
        threadStatusFilter: "needs_attention",
        projectSourceFilter: "remote",
        ownerFilter: "user-1",
      }),
    ).toBe(4);
  });
});

describe("describeActiveSidebarFilters", () => {
  it("agrees with itself about number", () => {
    expect(describeActiveSidebarFilters(1)).toBe("1 filter");
    expect(describeActiveSidebarFilters(3)).toBe("3 filters");
  });
});
