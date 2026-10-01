import { PROJECT_KINDS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { JOINED_PROJECT_CREATE_REFUSAL, decideProjectKindRefusal } from "./projectKindRules.ts";

describe("decideProjectKindRefusal", () => {
  it("refuses a joined project, because joining is something another person does", () => {
    expect(decideProjectKindRefusal({ kind: "joined" })).toBe(JOINED_PROJECT_CREATE_REFUSAL);
  });

  it("allows every kind somebody can genuinely create here", () => {
    for (const kind of PROJECT_KINDS.filter((candidate) => candidate !== "joined")) {
      expect(decideProjectKindRefusal({ kind })).toBeNull();
    }
  });

  it("allows an absent or null kind, which is what every older client sends", () => {
    // `t3 project add`, the SDK and any browser build from before kinds existed
    // state no kind at all. If this ever started refusing, project creation
    // would break for all of them at once.
    expect(decideProjectKindRefusal({ kind: undefined })).toBeNull();
    expect(decideProjectKindRefusal({ kind: null })).toBeNull();
  });

  it("names the act the caller actually needs instead of only refusing", () => {
    // The wording is the point: whoever hit this wants a project, and there is
    // a way to get one.
    expect(JOINED_PROJECT_CREATE_REFUSAL).toMatch(/share link/i);
  });
});
