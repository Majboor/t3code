import { describe, expect, it } from "vitest";

import {
  PAIRED_ENVIRONMENT_HOSTING_REFUSAL,
  decideProjectHostingRefusal,
} from "./workspaceHosting.ts";

describe("decideProjectHostingRefusal", () => {
  it("refuses to create a project on a server that only holds accounts", () => {
    expect(
      decideProjectHostingRefusal({
        workspaceSource: "paired-environment",
        command: { type: "project.create" },
      }),
    ).toBe(PAIRED_ENVIRONMENT_HOSTING_REFUSAL);
  });

  it("allows project creation on a server that hosts the work", () => {
    expect(
      decideProjectHostingRefusal({
        workspaceSource: "this-server",
        command: { type: "project.create" },
      }),
    ).toBeNull();
  });

  it("leaves every other command alone, so a hub is still a working account server", () => {
    for (const type of [
      "thread.turn.start",
      "project.meta.update",
      "project.delete",
      "thread.meta.update",
    ]) {
      expect(
        decideProjectHostingRefusal({
          workspaceSource: "paired-environment",
          command: { type },
        }),
      ).toBeNull();
    }
  });

  it("says where the project should go instead of only that it was refused", () => {
    // The wording is the feature: someone arriving here has usually done
    // nothing wrong, and a bare denial would leave them stuck.
    expect(PAIRED_ENVIRONMENT_HOSTING_REFUSAL).toMatch(/environment of your own/i);
  });
});
