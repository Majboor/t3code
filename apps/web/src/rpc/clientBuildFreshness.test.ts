import { beforeEach, describe, expect, it } from "vitest";

import {
  getClientUpdateAvailable,
  observeClientBuildId,
  resetClientBuildFreshnessForTests,
} from "./clientBuildFreshness";

describe("clientBuildFreshness", () => {
  beforeEach(() => {
    resetClientBuildFreshnessForTests();
  });

  it("does not flag an update from the first build id a page load ever sees", () => {
    observeClientBuildId("abc123");

    expect(getClientUpdateAvailable()).toBe(false);
  });

  it("does not flag an update while the server keeps reporting the same build", () => {
    observeClientBuildId("abc123");
    observeClientBuildId("abc123");
    observeClientBuildId("abc123");

    expect(getClientUpdateAvailable()).toBe(false);
  });

  it("flags an update once the server reports a different build than the one first observed", () => {
    observeClientBuildId("abc123");
    observeClientBuildId("def456");

    expect(getClientUpdateAvailable()).toBe(true);
  });

  it("stays flagged once true even if a later snapshot reports the original build again", () => {
    observeClientBuildId("abc123");
    observeClientBuildId("def456");
    observeClientBuildId("abc123");

    expect(getClientUpdateAvailable()).toBe(true);
  });

  it("ignores an undefined build id, e.g. from a server that predates this field", () => {
    observeClientBuildId("abc123");
    observeClientBuildId(undefined);

    expect(getClientUpdateAvailable()).toBe(false);
  });
});
