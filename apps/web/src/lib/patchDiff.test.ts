import { describe, expect, it } from "vitest";

import { diffPathMatchesTarget } from "./patchDiff";

describe("diffPathMatchesTarget", () => {
  it("matches repo-root diff paths against workspace-relative paths", () => {
    expect(
      diffPathMatchesTarget(
        "apps/web/src/components/AppSidebarLayout.logic.ts",
        "../web/src/components/AppSidebarLayout.logic.ts",
      ),
    ).toBe(true);
    expect(diffPathMatchesTarget("apps/server/src/auth/http.ts", "src/auth/http.ts")).toBe(true);
  });

  it("matches exact paths and patch-prefixed paths", () => {
    expect(diffPathMatchesTarget("b/src/new-file.ts", "src/new-file.ts")).toBe(true);
    expect(diffPathMatchesTarget("src/new-file.ts", "src/new-file.ts")).toBe(true);
  });

  it("does not match unrelated files with the same basename", () => {
    expect(diffPathMatchesTarget("apps/server/src/config.ts", "apps/web/src/config.ts")).toBe(
      false,
    );
  });
});
