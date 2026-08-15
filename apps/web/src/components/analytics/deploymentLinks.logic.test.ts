import { describe, expect, it } from "vitest";

import {
  deploymentsReportingTo,
  describeAddress,
  linkDeployments,
  mostRecentLiveDeployment,
} from "./deploymentLinks.logic";

const deployment = (name: string, streamIds: ReadonlyArray<string>, url: string | null = null) =>
  ({ name, url, analyticsStreamIds: streamIds }) as never;

const stream = (id: string, name: string) => ({ id, name }) as never;

describe("linkDeployments", () => {
  it("names the streams a deployment reports to", () => {
    const links = linkDeployments(
      [deployment("staging", ["s1", "s2"])],
      [stream("s1", "page.view"), stream("s2", "checkout.done")],
    );

    expect(links[0]?.streamNames).toEqual(["page.view", "checkout.done"]);
    expect(links[0]?.dangling).toBe(0);
  });

  it("counts a stream that no longer resolves instead of quietly dropping it", () => {
    // An archived stream leaves a live deployment posting into nothing, which is
    // exactly the case worth surfacing.
    const links = linkDeployments(
      [deployment("staging", ["s1", "gone"])],
      [stream("s1", "page.view")],
    );

    expect(links[0]?.streamNames).toEqual(["page.view"]);
    expect(links[0]?.dangling).toBe(1);
  });

  it("reports a deployment that declares no streams as reporting nothing", () => {
    const links = linkDeployments([deployment("staging", [])], [stream("s1", "page.view")]);

    expect(links[0]?.streamNames).toEqual([]);
    expect(links[0]?.dangling).toBe(0);
  });
});

describe("deploymentsReportingTo", () => {
  it("finds every deployment writing to one stream", () => {
    const found = deploymentsReportingTo("s1" as never, [
      deployment("staging", ["s1"]),
      deployment("prod", ["s1", "s2"]),
      deployment("docs", ["s2"]),
    ]);

    expect(found.map((entry) => entry.name)).toEqual(["staging", "prod"]);
  });
});

describe("describeAddress", () => {
  it("says so rather than rendering an empty link", () => {
    expect(describeAddress(deployment("staging", []))).toBe("no address yet");
    expect(describeAddress(deployment("staging", [], "https://x.test"))).toBe("https://x.test");
  });
});

const at = (name: string, status: string, updatedAt: string) =>
  ({ name, status, updatedAt, url: null, analyticsStreamIds: [] }) as never;

describe("mostRecentLiveDeployment", () => {
  it("is nothing when nothing is deployed", () => {
    expect(mostRecentLiveDeployment([])).toBeNull();
  });

  it("ignores a deployment somebody stopped", () => {
    expect(mostRecentLiveDeployment([at("old", "stopped", "2026-08-15T00:00:00Z")])).toBeNull();
  });

  it("prefers one that is actually live over one nobody has said anything about", () => {
    const found = mostRecentLiveDeployment([
      at("guess", "unknown", "2026-08-15T02:00:00Z"),
      at("staging", "live", "2026-08-15T01:00:00Z"),
    ]);
    expect(found?.name).toBe("staging");
  });

  it("breaks a tie on the one last worked on", () => {
    const found = mostRecentLiveDeployment([
      at("staging", "live", "2026-08-15T01:00:00Z"),
      at("prod", "live", "2026-08-15T03:00:00Z"),
    ]);
    expect(found?.name).toBe("prod");
  });
});
