import { describe, expect, it } from "vitest";

import { describeReadiness, orderForAttention } from "./infra.logic";

const enablement = (packName: string, settings: ReadonlyArray<[string, boolean]>) =>
  ({
    packName,
    settings: settings.map(([name, provided]) => ({ name, provided })),
  }) as never;

describe("describeReadiness", () => {
  it("counts what the pack asked for and the project must supply", () => {
    const readiness = describeReadiness(
      enablement("deploy", [
        ["HOST", true],
        ["TOKEN", false],
        ["PORT", false],
      ]),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toEqual(["TOKEN", "PORT"]);
    // Not "still to set": nothing here can see whether they are set.
    expect(readiness.summary).toBe("Needs 2 things you have to supply");
  });

  it("is ready only when nothing is outstanding", () => {
    expect(describeReadiness(enablement("deploy", [["HOST", true]])).ready).toBe(true);
  });

  it("says a pack that asks for nothing asks for nothing", () => {
    // Distinguishable from "everything is set", which would be a different
    // claim about a pack that wanted something.
    const readiness = describeReadiness(enablement("simple", []));
    expect(readiness.ready).toBe(true);
    expect(readiness.summary).toBe("Asks for nothing");
  });
});

describe("orderForAttention", () => {
  it("puts what needs doing first", () => {
    const ordered = orderForAttention([
      enablement("ready-one", [["A", true]]),
      enablement("needs-one", [["B", false]]),
    ]);
    expect(ordered.map((entry) => entry.packName)).toEqual(["needs-one", "ready-one"]);
  });

  it("stays alphabetical inside a group, so the list does not shuffle", () => {
    const ordered = orderForAttention([
      enablement("zebra", [["A", false]]),
      enablement("alpha", [["B", false]]),
    ]);
    expect(ordered.map((entry) => entry.packName)).toEqual(["alpha", "zebra"]);
  });
});
